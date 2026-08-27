#!/usr/bin/env node
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { runAgentLoop, type LoopResult } from "../agent/loop.js";
import { PERSONAS, type PersonaIntent } from "../agent/personas.js";
import { login } from "../browser/login.js";
import { configurePageTimeouts } from "../browser/actions.js";
import { formatTestTitle, generateSpec, type FlowEntries } from "../codegen/spec.js";
import { loadAppwalkConfig, validateResolvedOptions, type CoverageRunConfig, type ProviderName } from "../config.js";
import { EvidenceLog, readEvidenceLog, type EvidenceEntry, type EvidenceReadIssue } from "../evidence/log.js";
import { EvidenceRecorder, type RuntimeErrorEntry } from "../evidence/recorder.js";
import {
  applyResponseVariant,
  extractResponseFixtures,
  installResponseFixtures,
  parseResponseVariantsDetailed,
  RESPONSE_VARIANT_MAX_OUTPUT_TOKENS,
  responseVariantPrompt,
  type ResponseFixture,
  type ResponseVariantParseResult,
  type ResponseVariant,
} from "../response/variants.js";
import type { ExpectationObservation } from "../types.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { GeminiProvider } from "../providers/gemini.js";
import { GrokProvider } from "../providers/grok.js";
import { OllamaProvider } from "../providers/ollama.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LlmProvider } from "../providers/provider.js";
import type { SafetyConfig } from "../safety/guard.js";
import { installDestructiveActionGuard } from "../safety/guard.js";
import { Logger, logError, type LogLevel } from "../logging/logger.js";
import {
  buildExecutionReport,
  renderHtmlReport,
  type ExecutionReport,
  type ReportFlow,
  type ReportIssue,
  type ReportResponseVariantAudit,
  type ReportRuntimeError,
  type ReportSafety,
  type ReportStopReason,
  type ReportStep,
} from "../report/contract.js";
import { extractActions, hasObservableReplayDifference, replay } from "../verify/replay.js";

const DEFAULT_OUTPUT_DIR = "./appwalk-output";
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_BLOCK_METHODS = ["POST", "DELETE", "PUT", "PATCH"];
let appLogger = new Logger("normal");

type Command = "explore" | "generate" | "run";

interface CliArgs {
  command: Command;
  url: string;
  email?: string;
  password?: string;
  output: string;
  outputSpecified: boolean;
  maxSteps: number;
  model?: string;
  provider?: ProviderName;
  allowDestructive: boolean;
  blockMethods: string[];
  safetyConfigPath?: string;
  storageStatePath?: string;
  screenshots: boolean;
  responseVariantMax?: number;
  responseFixtureMaxBytes?: number;
  personaName?: string;
  scope?: string;
  expectations: string[];
  flowSelection?: number[];
  configPath?: string;
  coverageRuns?: CoverageRunConfig[];
  cliSpecified: Set<string>;
  logLevel: LogLevel;
}

interface DiscoveryManifestFlow {
  id: number;
  runId?: string;
  runFlowIndex?: number;
  name: string;
  title?: string;
  verified: boolean;
  replayConfirmed: boolean;
  startIndex: number;
  endIndex: number;
  startUrl: string;
  startStorageState?: string;
  responseFixtures?: ResponseFixture[];
  origin?: "discovered" | "derived";
  sourceFlowId?: number;
  scenarioId?: string;
  responseVariant?: ResponseVariant;
  finding?: {
    status: "confirmed" | "inconclusive";
    summary: string;
    failure?: string;
  };
}

interface DiscoveryManifest {
  version: 1 | 2;
  executionId?: string;
  url: string;
  createdAt: string;
  exhausted: boolean;
  setup: {
    requiresLogin: boolean;
    storageStatePath?: string;
  };
  intent: {
    scope?: string;
    expectations: string[];
  };
  runs?: DiscoveryManifestRun[];
  flows: DiscoveryManifestFlow[];
}

interface DiscoveryManifestRun {
  id: string;
  name: string;
  persona?: string;
  personaIntent?: PersonaIntent;
  maxSteps: number;
  scope?: string;
  expectations: string[];
  exhausted: boolean;
  stopReason?: ReportStopReason;
  flowIds: number[];
  error?: string;
}

interface ExplorationRun {
  runId: string;
  runName: string;
  args: CliArgs;
  evidencePath: string;
  allEntries: EvidenceEntry[];
  discovery?: LoopResult;
  confirmedFlows: ConfirmedFlow[];
  replayConfirmedIds: number[];
  findings: FlowFinding[];
  responseVariantAudits: ReportResponseVariantAudit[];
  safety: ReportSafety;
  runtimeErrors: ReportRuntimeError[];
  replayFailures: Record<number, NonNullable<ReportFlow["replayFailure"]>>;
  error?: string;
}

interface FlowFinding {
  flowIndex: number;
  status: "confirmed" | "inconclusive";
  summary: string;
  failure?: string;
}

interface ExplorationBatch {
  executionId: string;
  args: CliArgs;
  evidencePath: string;
  runs: ExplorationRun[];
  allEntries: EvidenceEntry[];
  confirmedFlows: ConfirmedFlow[];
  evidenceIssues: EvidenceReadIssue[];
}

interface ConfirmedFlow extends FlowEntries {
  origin: "discovered" | "derived";
  sourceFlowIndex?: number;
  scenarioId?: string;
  responseVariant?: ResponseVariant;
}

interface SafetyEvent {
  phase: "exploration" | "replay";
  method: string;
  url: string;
}

function emptySafety(): ReportSafety {
  return { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 };
}

function summarizeSafety(events: SafetyEvent[]): ReportSafety {
  const byMethod: Record<string, number> = {};
  for (const event of events) byMethod[event.method] = (byMethod[event.method] ?? 0) + 1;
  const samples: ReportSafety["samples"] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = `${event.phase}:${event.method}:${event.url}`;
    if (seen.has(key) || samples.length >= 20) continue;
    seen.add(key);
    samples.push(event);
  }
  return {
    blockedRequests: events.length,
    explorationBlocked: events.filter((event) => event.phase === "exploration").length,
    replayBlocked: events.filter((event) => event.phase === "replay").length,
    byMethod,
    samples,
    safetyRelatedRuntimeErrors: 0,
  };
}

function summarizeRuntimeErrors(
  entries: Array<{ error: RuntimeErrorEntry; phase: "exploration" | "replay"; flowIndex?: number }>,
): ReportRuntimeError[] {
  const grouped = new Map<string, ReportRuntimeError>();
  for (const entry of entries) {
    const { error, phase, flowIndex } = entry;
    const key = JSON.stringify([phase, flowIndex, error.kind, error.message, error.method, error.url, error.status, error.safetyRelated]);
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    grouped.set(key, { ...error, phase, flowIndex, occurrences: 1 });
  }
  return [...grouped.values()];
}

function printUsage(error?: string): never {
  if (error) console.error(error);
  console.error([
    "Usage:",
    "  appwalk explore <url> [options]",
    "  appwalk generate <discovery-dir> [--flows 1,3] [-o output] [-e email] [-p password] [--storage-state path]",
    "  appwalk run <url> [options]",
    "",
    "Explore/run options:",
    "  -e, --email <email>                         Login username/email",
    "  -p, --password <password>                   Login password",
    "  -o, --output <dir>                          Output root; each CLI execution gets a subdirectory (default: ./appwalk-output)",
    "  -n, --max-steps <number>                    Exploration action budget (default: 25)",
    "  -m, --model <model>                         Provider model (required)",
    "      --provider anthropic|gemini|ollama|grok|openai (required)",
    "      --allow-destructive",
    "      --block-methods METHOD,...",
    "      --safety-config <path>",
    "      --storage-state <path>",
    "      --screenshots",
    "      --response-variant-max <number>           Maximum derived response scenarios",
    "      --response-fixture-max-bytes <number>     Maximum captured fixture size",
    "      --persona <name>",
    "      --scope <text>                           Natural-language exploration objective",
    "      --expect <text>                           Acceptance criterion (repeatable; requires --scope)",
    "      --config <path>                           Global YAML config",
    "      --quiet                                    Only final results and errors",
    "      --verbose                                  Detailed user-facing progress",
    "      --debug                                    Developer diagnostics",
    "",
    "Generate reads discovery.json and evidence.jsonl from the discovery directory.",
    "The old 'test' command is no longer the full pipeline; use 'run'.",
  ].join("\n"));
  process.exit(1);
}

function parseFlowSelection(value: string): number[] {
  const ids = value.split(",").map((part) => Number(part.trim()));
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1)) {
    printUsage("Invalid --flows value \"" + value + "\". Use a comma-separated list such as 1,3.");
  }
  return [...new Set(ids)];
}

function parseArgs(argv: string[]): CliArgs {
  const [commandValue, ...commandArgs] = argv;
  if (commandValue === "test") {
    printUsage("The 'test' command is reserved for running generated tests. Use 'run' for the full Appwalk workflow.");
  }
  if (commandValue !== "explore" && commandValue !== "generate" && commandValue !== "run") {
    return printUsage();
  }
  const rest = [...commandArgs];
  const url = rest[0] && !rest[0].startsWith("-") ? rest.shift() : undefined;

  const args: CliArgs = {
    command: commandValue,
    url: url ?? "",
    output: DEFAULT_OUTPUT_DIR,
    outputSpecified: false,
    maxSteps: DEFAULT_MAX_STEPS,
    allowDestructive: false,
    blockMethods: DEFAULT_BLOCK_METHODS,
    screenshots: false,
    expectations: [],
    cliSpecified: new Set<string>(),
    logLevel: "normal",
  };
  if (url) args.cliSpecified.add("url");
  const valueFlags = new Set([
    "--flows", "-e", "--email", "-p", "--password", "-o", "--output", "-n", "--max-steps",
    "--response-variant-max", "--response-fixture-max-bytes", "-m", "--model", "--provider",
    "--block-methods", "--safety-config", "--storage-state", "--persona", "--scope", "--expect", "--config",
  ]);

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    if (flag === "--allow-destructive") {
      args.allowDestructive = true;
      args.cliSpecified.add("allowDestructive");
      continue;
    }
    if (flag === "--screenshots") {
      args.screenshots = true;
      args.cliSpecified.add("screenshots");
      continue;
    }
    if (flag === "--quiet" || flag === "--verbose" || flag === "--debug") {
      args.logLevel = flag.slice(2) as LogLevel;
      args.cliSpecified.add("logLevel");
      continue;
    }
    const value = rest[i + 1];
    if (valueFlags.has(flag) && value === undefined) {
      return printUsage(`${flag} requires a value.`);
    }
    if (flag === "--flows" && value) args.flowSelection = parseFlowSelection(value);
    else if ((flag === "-e" || flag === "--email") && value) {
      args.email = value;
      args.cliSpecified.add("email");
    }
    else if ((flag === "-p" || flag === "--password") && value) {
      args.password = value;
      args.cliSpecified.add("password");
    }
    else if ((flag === "-o" || flag === "--output") && value) {
      args.output = value;
      args.outputSpecified = true;
      args.cliSpecified.add("output");
    } else if ((flag === "-n" || flag === "--max-steps") && value) {
      args.maxSteps = Number(value);
      args.cliSpecified.add("maxSteps");
    } else if (flag === "--response-variant-max" && value) {
      args.responseVariantMax = Number(value);
      args.cliSpecified.add("responseVariantMax");
    } else if (flag === "--response-fixture-max-bytes" && value) {
      args.responseFixtureMaxBytes = Number(value);
      args.cliSpecified.add("responseFixtureMaxBytes");
    }
    else if ((flag === "-m" || flag === "--model") && value) {
      args.model = value;
      args.cliSpecified.add("model");
    }
    else if (flag === "--provider" && value) {
      args.provider = value as ProviderName;
      args.cliSpecified.add("provider");
    }
    else if (flag === "--block-methods" && value) {
      args.blockMethods = value.split(",").map((method) => method.trim().toUpperCase());
      args.cliSpecified.add("blockMethods");
    }
    else if (flag === "--safety-config" && value) {
      args.safetyConfigPath = value;
      args.cliSpecified.add("safetyConfigPath");
    }
    else if (flag === "--storage-state" && value) {
      args.storageStatePath = value;
      args.cliSpecified.add("storageStatePath");
    }
    else if (flag === "--persona" && value) {
      args.personaName = value;
      args.cliSpecified.add("personaName");
    }
    else if (flag === "--scope" && value) {
      args.scope = value;
      args.cliSpecified.add("scope");
    }
    else if (flag === "--expect" && value) {
      args.expectations.push(value);
      args.cliSpecified.add("expectations");
    }
    else if (flag === "--config" && value) {
      args.configPath = value;
      args.cliSpecified.add("configPath");
    }
    else continue;
    i += 1;
  }
  return args;
}

function applyConfig(args: CliArgs): CliArgs {
  if (!args.configPath) {
    if (!args.url) return printUsage("Missing URL for '" + args.command + "'.");
    if (!args.provider) return printUsage("Missing provider. Pass --provider or define provider in --config.");
    if (!args.model) return printUsage("Missing model. Pass --model or define model in --config.");
    validateResolvedCliOptions(args);
    if (args.expectations.length > 0 && !args.scope) {
      return printUsage("--expect requires --scope. Expectations describe what should hold within a scoped exploration.");
    }
    return args;
  }

  const config = loadAppwalkConfig(args.configPath);
  if (!args.cliSpecified.has("url") && config.url) args.url = config.url;
  if (!args.cliSpecified.has("output") && config.output) args.output = config.output;
  if (!args.cliSpecified.has("provider") && config.provider) args.provider = config.provider;
  if (!args.cliSpecified.has("model") && config.model) args.model = config.model;
  if (!args.cliSpecified.has("maxSteps") && config.maxSteps !== undefined) args.maxSteps = config.maxSteps;
  if (!args.cliSpecified.has("screenshots") && config.screenshots !== undefined) args.screenshots = config.screenshots;
  if (!args.cliSpecified.has("email") && config.auth?.email) args.email = config.auth.email;
  if (!args.cliSpecified.has("password") && config.auth?.password) args.password = config.auth.password;
  if (!args.cliSpecified.has("storageStatePath") && config.auth?.storageState) args.storageStatePath = config.auth.storageState;
  if (!args.cliSpecified.has("allowDestructive") && config.safety?.allowDestructive !== undefined) args.allowDestructive = config.safety.allowDestructive;
  if (!args.cliSpecified.has("blockMethods") && config.safety?.blockMethods) args.blockMethods = config.safety.blockMethods.map((method) => method.toUpperCase());
  if (!args.cliSpecified.has("safetyConfigPath") && config.safety?.config) args.safetyConfigPath = config.safety.config;
  if (!args.cliSpecified.has("scope") && config.scope) args.scope = config.scope;
  if (!args.cliSpecified.has("expectations") && config.expect) args.expectations = config.expect;
  args.coverageRuns = config.coverage?.runs;

  if (!args.url) return printUsage("Missing URL. Pass it positionally or define url in " + args.configPath + ".");
  if (!args.provider) return printUsage("Missing provider. Pass --provider or define provider in " + args.configPath + ".");
  if (!args.model) return printUsage("Missing model. Pass --model or define model in " + args.configPath + ".");
  if (!args.cliSpecified.has("responseVariantMax") && config.responses?.maxVariants !== undefined) {
    args.responseVariantMax = config.responses.maxVariants;
  }
  if (!args.cliSpecified.has("responseFixtureMaxBytes") && config.responses?.maxFixtureBytes !== undefined) {
    args.responseFixtureMaxBytes = config.responses.maxFixtureBytes;
  }
  validateResolvedCliOptions(args);
  if (args.expectations.length > 0 && !args.scope) {
    return printUsage("--expect requires --scope. Expectations describe what should hold within a scoped exploration.");
  }
  const invalidRunExpectation = args.coverageRuns?.find((run) => run.expect?.length && !((run.scope ?? args.scope)?.trim()));
  if (invalidRunExpectation) {
    return printUsage("coverage.runs.expect requires a run scope or a global scope. Expectations describe what should hold within a scoped exploration.");
  }
  return args;
}

function validateResolvedCliOptions(args: CliArgs): void {
  try {
    validateResolvedOptions(args as unknown as Record<string, unknown>, "CLI options");
  } catch (error) {
    return printUsage((error as Error).message);
  }
}

function createExecutionDirectory(outputRoot: string): { id: string; path: string; startedAt: string } {
  const startedAt = new Date().toISOString();
  const timestamp = startedAt.replace(/[.:]/g, "-");
  const id = `${timestamp}-${randomUUID().slice(0, 8)}`;
  const path = join(outputRoot, id);
  mkdirSync(path, { recursive: true });
  return { id, path, startedAt };
}

function loadSafetyConfig(path: string | undefined): SafetyConfig | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as SafetyConfig;
}

async function navigateOrLogin(page: Page, args: CliArgs, hasPreloadedState = false, startUrl = args.url, logger = appLogger) {
  if (hasPreloadedState || args.storageStatePath) {
    logger.debug("browser.navigation_started", "Navigating with preloaded storage state", { startUrl });
    await page.goto(startUrl);
  } else if (args.email && args.password) {
    logger.debug("browser.navigation_started", "Navigating with credential login", { startUrl });
    await login(page, startUrl, args.email, args.password, logger);
  } else {
    logger.debug("browser.navigation_started", "Navigating as an anonymous session", { startUrl });
    await page.goto(startUrl);
  }
}

function createProvider(provider: ProviderName, model: string, apiKey: string | undefined, logger = appLogger): LlmProvider {
  return provider === "gemini"
    ? new GeminiProvider(apiKey!, model, logger)
    : provider === "ollama"
      ? new OllamaProvider(model, undefined, logger)
      : provider === "grok"
        ? new GrokProvider(apiKey!, model, logger)
        : provider === "openai"
          ? new OpenAIProvider(apiKey!, model, logger)
          : new AnthropicProvider(apiKey!, model, logger);
}

function validatePersona(args: CliArgs) {
  const persona = args.personaName ? PERSONAS[args.personaName] : undefined;
  if (args.personaName && !persona) {
    appLogger.error("Unknown persona \"" + args.personaName + "\". Available: " + Object.keys(PERSONAS).join(", "));
    process.exit(1);
  }
  return persona;
}

async function proposeResponseVariants(
  provider: ProviderName,
  model: string,
  apiKey: string | undefined,
  flowName: string,
  fixtures: ResponseFixture[],
  maxVariants: number,
  finalSnapshot: string,
  replayTimeline: Array<{ url: string; snapshot: string }>,
  logger = appLogger,
): Promise<ResponseVariantParseResult> {
  const plannerLogger = logger.child({ operation: "response_variant_planner" });
  plannerLogger.debug("response_variants.planning_started", "Response variant planning started", {
    flowName,
    fixtureCount: fixtures.length,
    maxVariants,
    maxOutputTokens: RESPONSE_VARIANT_MAX_OUTPUT_TOKENS,
    replaySteps: replayTimeline.length,
  });
  const planner = createProvider(provider, model, apiKey, plannerLogger);
  const turn = await planner.start({
    systemPrompt:
      "You are a conservative response-variant planner for browser test generation. Return only the JSON requested by the user. Never invent application behavior or fields.",
    tools: [],
    initialInput: responseVariantPrompt(flowName, fixtures, maxVariants, finalSnapshot, replayTimeline),
    maxOutputTokens: RESPONSE_VARIANT_MAX_OUTPUT_TOKENS,
  });
  if (turn.type !== "text") {
    const result = {
      variants: [],
      candidates: 0,
      rejected: 0,
      rejectionReasons: [],
      reason: "Planner did not return a text response.",
    };
    plannerLogger.debug("response_variants.planning_parsed", "Response variant planner returned no text proposals", {
      responseType: turn.type,
      candidates: result.candidates,
      accepted: result.variants.length,
      rejected: result.rejected,
      reason: result.reason,
    });
    return result;
  }
  const result = parseResponseVariantsDetailed(turn.text, fixtures, maxVariants);
  if (turn.incompleteReason) {
    result.incomplete = true;
    result.reason = `Planner response was incomplete: ${turn.incompleteReason}.`;
  }
  plannerLogger.debug("response_variants.planning_response", "Response variant planner response received", {
    responseType: turn.type,
    responseLength: turn.text.length,
    incompleteReason: turn.incompleteReason,
    plannerReason: result.plannerReason,
  });
  plannerLogger.debug("response_variants.planning_parsed", "Response variant planner output parsed", {
    candidates: result.candidates,
    accepted: result.variants.length,
    rejected: result.rejected,
    rejectionReasons: result.rejectionReasons,
    reason: result.reason,
  });
  return result;
}

function derivedEvidenceEntries(
  actions: ReturnType<typeof extractActions>,
  steps: import("../types.js").StepResult[],
  runId: string,
  flowIndex: number,
  scenarioId: string,
  expectationResult?: import("../agent/tools.js").ToolCallResult,
  expectationStepIndex?: number,
  expectationInput?: Record<string, unknown>,
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  actions.forEach((action, index) => {
    entries.push({
      index: entries.length,
      flowIndex,
      runId,
      scenarioId,
      origin: "derived",
      timestamp: new Date().toISOString(),
      toolCall: { name: action.name, input: action.input },
      result: steps[index],
      network: [],
      console: [],
      runtimeErrors: [],
    });
    if (expectationResult && expectationStepIndex === index) {
      entries.push({
        index: entries.length,
        flowIndex,
        runId,
        scenarioId,
        origin: "derived",
        timestamp: new Date().toISOString(),
        toolCall: { name: "verifyExpectation", input: expectationInput ?? {} },
        result: expectationResult,
        network: [],
        console: [],
        runtimeErrors: [],
      });
    }
  });
  if (expectationResult && expectationStepIndex === undefined) {
    entries.push({
      index: entries.length,
      flowIndex,
      runId,
      scenarioId,
      origin: "derived",
      timestamp: new Date().toISOString(),
      toolCall: { name: "verifyExpectation", input: expectationInput ?? {} },
      result: expectationResult,
      network: [],
      console: [],
      runtimeErrors: [],
    });
  }
  return entries;
}

async function exploreAndVerify(args: CliArgs, evidenceLog: EvidenceLog, runId: string, runName: string): Promise<ExplorationRun> {
  appLogger.info("  Launching browser");
  const browser = await chromium.launch();
  try {
    return await exploreAndVerifyInBrowser(args, evidenceLog, runId, runName, browser);
  } finally {
    await browser.close();
  }
}

async function exploreAndVerifyInBrowser(
  args: CliArgs,
  evidenceLog: EvidenceLog,
  runId: string,
  runName: string,
  browser: Browser,
): Promise<ExplorationRun> {
  const persona = validatePersona(args);
  const runLogger = appLogger.child({ runId, persona: args.personaName ?? runName });
  const provider = args.provider;
  const model = args.model;
  if (!provider || !model) throw new Error("Provider and model must be configured before starting an exploration run.");
  const requiresApiKey = provider !== "ollama";
  const apiKeyEnvVar =
    provider === "gemini"
      ? "GEMINI_API_KEY"
      : provider === "grok"
        ? "XAI_API_KEY"
        : provider === "openai"
          ? "OPENAI_API_KEY"
          : "ANTHROPIC_API_KEY";
  const apiKey = requiresApiKey ? process.env[apiKeyEnvVar] : undefined;
  if (requiresApiKey && !apiKey) {
    throw new Error("Set " + apiKeyEnvVar + " before starting an exploration run.");
  }

  const evidencePath = join(args.output, "evidence.jsonl");
  const safetyConfig = loadSafetyConfig(args.safetyConfigPath);
  const safetyEvents: SafetyEvent[] = [];
  let safetyPhase: SafetyEvent["phase"] = "exploration";
  let activeRecorder: EvidenceRecorder | undefined;
  const guardOptions = {
    allowDestructive: args.allowDestructive,
    blockMethods: args.blockMethods,
    config: safetyConfig,
    logger: runLogger,
    onBlocked: (request: { method: string; url: string }) => {
      safetyEvents.push({ phase: safetyPhase, ...request });
      activeRecorder?.markSafetyBlocked(request);
    },
  };

  const page = await browser.newPage(
    args.storageStatePath ? { storageState: args.storageStatePath } : undefined,
  );
  configurePageTimeouts(page);
  const runEntries: EvidenceEntry[] = [];

  runLogger.info("  Navigating to application URL");
  await navigateOrLogin(page, args, false, args.url, runLogger);
  // Authentication is setup, not discovered application behavior. Enable the destructive
  // request guard after login so a required login POST is not blocked by the default policy.
  await installDestructiveActionGuard(page, guardOptions);
  // Start recording after setup so login and token-refresh traffic never become application fixtures.
  const recorder = new EvidenceRecorder(page, runLogger);
  activeRecorder = recorder;

  runLogger.info("  Exploring application");
  const discovery = await runAgentLoop(page, createProvider(provider, model, apiKey, runLogger), {
    maxSteps: args.maxSteps,
    recorder,
    captureScreenshots: args.screenshots,
    persona,
    scope: args.scope,
    expectations: args.expectations,
    logger: runLogger,
    getSafetyBlockCount: () => safetyEvents.filter((event) => event.phase === "exploration").length,
    onStep: (step, index, flowIndex) => {
      const { network, console: consoleEntries, runtimeErrors } = recorder.drain();
        const entry = {
          index,
          flowIndex,
          runId,
          timestamp: new Date().toISOString(),
          ...step,
          network,
          console: consoleEntries,
          runtimeErrors,
        } satisfies EvidenceEntry;
        runEntries.push(entry);
        evidenceLog.append(entry);
    },
  });
  await recorder.waitForPendingBodies();
  await discovery.finalPage.context().browser()?.close();
  const explorationBlockedRequests = safetyEvents.filter((event) => event.phase === "exploration").length;
  if (explorationBlockedRequests > 0) {
    runLogger.info(`  Safety: ${explorationBlockedRequests} destructive request${explorationBlockedRequests === 1 ? "" : "s"} blocked during exploration`);
  }
  runLogger.info(`  Exploration completed: ${discovery.flows.length} flow(s) found${discovery.exhausted ? "; action budget reached" : ""}`);
  runLogger.debug("exploration.completed", "Exploration completed", { flowsFound: discovery.flows.length, exhausted: discovery.exhausted });

  const verifiedFlows = discovery.flows
    .map((flow, index) => ({ flow, index }))
    .filter(({ flow }) => flow.verified || persona?.intent === "challenge");
  const allEntries = runEntries;
  const confirmedFlows: ConfirmedFlow[] = [];
  const replayConfirmedIds: number[] = [];
  const findings: FlowFinding[] = [];
  const responseVariantAudits: ReportResponseVariantAudit[] = [];
  const replayFailures: Record<number, NonNullable<ReportFlow["replayFailure"]>> = {};
  const runtimeErrorEntries: Array<{ error: RuntimeErrorEntry; phase: "exploration" | "replay"; flowIndex?: number }> = recorder.runtimeErrors.map((error) => ({ error, phase: "exploration" }));
  let runError: string | undefined;

  if (verifiedFlows.length > 0) {
    runLogger.info(`  Verifying ${verifiedFlows.length} of ${discovery.flows.length} discovered flow(s) by replay in a clean session`);
    let replayBrowser: Browser | undefined;
    try {
      replayBrowser = await chromium.launch();
      try {
        for (const { flow, index } of verifiedFlows) {
        safetyPhase = "replay";
        const flowLogger = runLogger.child({ flowIndex: index + 1 });
        const flowEntries = allEntries.filter((entry) => entry.flowIndex === index);
        const actions = extractActions(flowEntries);
        const hasCoreAction =
          !persona?.coreActionTypes ||
          actions.some((action) => persona.coreActionTypes!.includes(action.name));
        const findingCandidate = persona?.intent === "challenge" && !flow.verified && hasCoreAction;
        const flowStorageState = index > 0 && flow.startStorageState
          ? JSON.parse(flow.startStorageState)
          : args.storageStatePath;

        const replayPage = await replayBrowser.newPage(flowStorageState ? { storageState: flowStorageState } : undefined);
        configurePageTimeouts(replayPage);
        await navigateOrLogin(
          replayPage,
          args,
          index > 0 && Boolean(flow.startStorageState),
          index > 0 && flow.startUrl ? flow.startUrl : args.url,
          flowLogger,
        );
        await installDestructiveActionGuard(replayPage, guardOptions);
        const replayRecorder = new EvidenceRecorder(replayPage, flowLogger);
        activeRecorder = replayRecorder;
        const expectedExpectations = flowEntries
          .filter((entry) => entry.result?.expectation)
          .map((entry) => entry.result!.expectation!) as ExpectationObservation[];
        const replayResult = await replay(
          replayPage,
          actions,
          persona?.verificationMode ?? "completion",
          replayRecorder,
          expectedExpectations,
          undefined,
          flowLogger,
          () => safetyEvents.filter((event) => event.phase === "replay").length,
        );
        runtimeErrorEntries.push(...replayRecorder.runtimeErrors.map((error) => ({ error, phase: "replay" as const, flowIndex: index + 1 })));
        if (!replayResult.reproduced) {
          const runtimeIssues = replayRecorder.runtimeErrors.filter((error) => !error.safetyRelated);
          replayFailures[index] = {
            reason: replayResult.failedAt
              ? "A recorded action could not be completed in the clean replay session."
              : replayResult.safetyBlocked > 0
                ? "Replay was limited by the safety policy."
                : !replayResult.expectationsReproduced
                  ? "The replay did not reproduce the recorded expectation signals."
                  : "The replay did not reach the recorded verification state.",
            step: replayResult.failedAt ? replayResult.failedAt.index + 1 : undefined,
            action: replayResult.failedAt?.action,
            error: replayResult.failedAt?.error,
            lastUrl: replayResult.finalUrl,
            lastSnapshot: replayResult.finalSnapshot,
          };
        }
        const activeBrowser = replayResult.finalPage.context().browser();
        if (activeBrowser && activeBrowser !== replayBrowser) replayBrowser = activeBrowser;
        await replayResult.finalPage.close();

        if (findingCandidate) {
          const confirmedFinding =
            !replayResult.failedAt &&
            replayResult.safetyBlocked === 0 &&
            replayResult.expectationsReproduced &&
            !replayResult.verificationPassed;
          const finding: FlowFinding = {
            flowIndex: index,
            status: confirmedFinding ? "confirmed" : "inconclusive",
            summary: flow.finalText || "The application did not satisfy the challenge verification condition.",
            failure: replayResult.failedAt
              ? `step ${replayResult.failedAt.index}, ${replayResult.failedAt.action}: ${replayResult.failedAt.error}`
              : replayResult.safetyBlocked > 0
                ? `Replay was limited by safety policy: ${replayResult.safetyBlocked} request${replayResult.safetyBlocked === 1 ? "" : "s"} blocked.`
              : !replayResult.expectationsReproduced
                ? "The replay did not reproduce one or more expectation signals."
                : replayResult.verificationPassed
                  ? "The replay defended the application on the clean session."
                  : undefined,
          };
          findings.push(finding);
          flowLogger.warn(`    Flow ${index + 1}: ${confirmedFinding ? "finding confirmed" : "finding inconclusive"}${finding.failure ? ` (${finding.failure})` : ""}`);
          continue;
        }

        if (!replayResult.reproduced) {
          if (replayResult.failedAt) {
            flowLogger.warn(`    Flow ${index + 1} not confirmed: replay could not complete the ${replayResult.failedAt.action} action at step ${replayResult.failedAt.index + 1}`);
            flowLogger.debug("replay.step_failed", "Replay action failed", { stepIndex: replayResult.failedAt.index, action: replayResult.failedAt.action, error: replayResult.failedAt.error });
          } else if (!replayResult.expectationsReproduced) {
            flowLogger.warn(`    Flow ${index + 1} not confirmed: expected result was not reproduced`);
          } else if (replayResult.safetyBlocked > 0) {
            flowLogger.warn(`    Flow ${index + 1} not confirmed: replay was limited by safety policy (${replayResult.safetyBlocked} request${replayResult.safetyBlocked === 1 ? "" : "s"} blocked)`);
          } else {
            flowLogger.warn(`    Flow ${index + 1} not confirmed: expected final state was not reached`);
          }
          continue;
        }
        flowLogger.info(`    Flow ${index + 1} replay confirmed`);
        replayConfirmedIds.push(index + 1);
        const baseFlow: ConfirmedFlow = {
          name: flow.finalText || "Flow " + (index + 1),
          title: flow.title,
          entries: flowEntries,
          startUrl: index === 0 ? undefined : flow.startUrl,
          startStorageState: index === 0 ? undefined : flow.startStorageState,
          responseFixtures: extractResponseFixtures(flowEntries, args.url, args.responseFixtureMaxBytes),
          origin: "discovered",
          sourceFlowIndex: index,
        };
        confirmedFlows.push(baseFlow);

        const responseVariantAudit: ReportResponseVariantAudit = {
          flowIndex: index,
          enabled: (args.responseVariantMax ?? 0) > 0,
          fixturesFound: baseFlow.responseFixtures?.length ?? 0,
          fixtures: (baseFlow.responseFixtures ?? []).map((fixture) => ({
            method: fixture.method,
            url: fixture.url,
            bytes: JSON.stringify(fixture.body).length,
          })),
          planningStatus: (args.responseVariantMax ?? 0) > 0 && (baseFlow.responseFixtures?.length ?? 0) > 0 ? "completed" :
            (args.responseVariantMax ?? 0) > 0 ? "not_run" : "not_enabled",
          plannerCandidates: 0,
          plannerRejected: 0,
          plannerRejectionReasons: [],
          proposed: 0,
          confirmed: 0,
          confirmedScenarios: [],
          skipped: [],
        };
        responseVariantAudits.push(responseVariantAudit);

        if (baseFlow.responseFixtures?.length && responseVariantAudit.enabled) {
          let variants: ResponseVariant[] = [];
          try {
            flowLogger.verbose(`    Flow ${index + 1}: planning response scenarios`);
            const planning = await proposeResponseVariants(
              provider,
              model,
              apiKey,
              baseFlow.name,
              baseFlow.responseFixtures,
              args.responseVariantMax!,
              replayResult.finalSnapshot,
              replayResult.steps.map((step) => ({ url: step.url, snapshot: step.snapshot })),
              flowLogger,
            );
            variants = planning.variants;
            responseVariantAudit.plannerCandidates = planning.candidates;
            responseVariantAudit.plannerRejected = planning.rejected;
            responseVariantAudit.plannerRejectionReasons = planning.rejectionReasons;
            responseVariantAudit.plannerReason = planning.reason;
            responseVariantAudit.proposed = variants.length;
            responseVariantAudit.planningStatus = planning.incomplete ? "incomplete" : "completed";
            flowLogger.verbose(`    Flow ${index + 1}: response planner proposals=${planning.candidates}, accepted=${planning.variants.length}, rejected=${planning.rejected}`);
            if (planning.reason) {
              flowLogger.verbose(`    Flow ${index + 1}: response planner note: ${planning.reason}`);
            }
          } catch (error) {
            const reason = (error as Error).message;
            responseVariantAudit.planningStatus = "failed";
            responseVariantAudit.plannerReason = reason;
            responseVariantAudit.skipped.push({ name: "planner", reason });
            flowLogger.warn(`    Flow ${index + 1}: response scenario planning skipped`);
            flowLogger.debug("response_variants.planning_failed", "Response scenario planning failed", { error: reason });
          }

          for (const [variantIndex, variant] of variants.entries()) {
            try {
            const variantFixtures = applyResponseVariant(baseFlow.responseFixtures, variant);
            if (!variantFixtures) {
              responseVariantAudit.skipped.push({ name: variant.name, reason: "The proposed patch did not apply to the captured response." });
              continue;
            }
            const scenarioId = `derived-${runId}-${index + 1}-${variantIndex + 1}`;
            const variantStorageState = index > 0 && flow.startStorageState
              ? JSON.parse(flow.startStorageState)
              : args.storageStatePath;
            const variantPage = await replayBrowser.newPage(
              variantStorageState ? { storageState: variantStorageState } : undefined,
            );
            configurePageTimeouts(variantPage);
            await navigateOrLogin(
              variantPage,
              args,
              index > 0 && Boolean(flow.startStorageState),
              index > 0 && flow.startUrl ? flow.startUrl : args.url,
              flowLogger,
            );
            await installDestructiveActionGuard(variantPage, guardOptions);
            await installResponseFixtures(variantPage, variantFixtures);
            const variantRecorder = new EvidenceRecorder(variantPage, flowLogger);
            activeRecorder = variantRecorder;
            const variantResult = await replay(
              variantPage,
              actions,
              persona?.verificationMode ?? "completion",
              variantRecorder,
              expectedExpectations,
              variant.expectation,
              flowLogger.child({ scenarioId }),
              () => safetyEvents.filter((event) => event.phase === "replay").length,
            );
            runtimeErrorEntries.push(...variantRecorder.runtimeErrors.map((error) => ({ error, phase: "replay" as const, flowIndex: index + 1 })));
            const variantExpectationResult = variantResult.variantExpectationResult;
            const activeVariantBrowser = variantResult.finalPage.context().browser();
            if (activeVariantBrowser && activeVariantBrowser !== replayBrowser) replayBrowser = activeVariantBrowser;
            await variantResult.finalPage.close();

            if (!variantResult.reproduced) {
              responseVariantAudit.skipped.push({ name: variant.name, reason: variantResult.failedAt
                ? `Replay failed at step ${variantResult.failedAt.index}: ${variantResult.failedAt.error}`
                : variantResult.safetyBlocked > 0
                  ? `Replay was limited by safety policy: ${variantResult.safetyBlocked} request${variantResult.safetyBlocked === 1 ? "" : "s"} blocked.`
                : variantResult.expectationsReproduced ? "Replay did not satisfy the flow verification." : "Replay did not reproduce the original expectation signals." });
              flowLogger.verbose(`      Response scenario "${variant.name}": replay failed`);
              continue;
            }
            if (variantExpectationResult?.expectation?.status !== "met") {
              responseVariantAudit.skipped.push({ name: variant.name, reason: "The derived expectation was not observed at any replay step." });
              flowLogger.verbose(`      Response scenario "${variant.name}": expectation not observed`);
              continue;
            }
            if (!hasObservableReplayDifference(replayResult, variantResult)) {
              responseVariantAudit.skipped.push({ name: variant.name, reason: "The response patch caused no observable UI difference." });
              flowLogger.verbose(`      Response scenario "${variant.name}": no observable UI difference`);
              continue;
            }

            const variantEntries = derivedEvidenceEntries(
              actions,
              variantResult.steps,
              runId,
              index,
              scenarioId,
              variantExpectationResult,
              variantResult.variantExpectationStep,
              {
                expectationIndex: 1,
                assertion: variant.expectation.assertion,
                locator: variant.expectation.locator,
                value: variant.expectation.value,
              },
            );
            for (const entry of variantEntries) evidenceLog.append(entry);
            confirmedFlows.push({
              name: `${baseFlow.name} — ${variant.name}`,
              title: `${baseFlow.title ?? formatTestTitle(baseFlow.name)} — ${variant.name}`,
              entries: variantEntries,
              startUrl: baseFlow.startUrl,
              startStorageState: baseFlow.startStorageState,
              responseFixtures: variantFixtures,
              origin: "derived",
              sourceFlowIndex: index,
              scenarioId,
              responseVariant: variant,
            });
            responseVariantAudit.confirmed += 1;
            responseVariantAudit.confirmedScenarios.push(variant.name);
            flowLogger.verbose(`      Response scenario "${variant.name}": replay confirmed`);
            } catch (error) {
              responseVariantAudit.skipped.push({ name: variant.name, reason: (error as Error).message });
              flowLogger.verbose(`      Response scenario "${variant.name}": replay skipped`);
              flowLogger.debug("response_variant.failed", "Response scenario replay failed", { name: variant.name, error: logError(error) });
            }
          }
          flowLogger.verbose(`    Flow ${index + 1}: response scenarios proposed=${responseVariantAudit.proposed}, confirmed=${responseVariantAudit.confirmed}, skipped=${responseVariantAudit.skipped.length}`);
        }
        }
      } finally {
        const replayBlockedRequests = safetyEvents.filter((event) => event.phase === "replay").length;
        if (replayBlockedRequests > 0) {
          runLogger.info(`  Safety: ${replayBlockedRequests} destructive request${replayBlockedRequests === 1 ? "" : "s"} blocked during replay`);
        }
        await replayBrowser.close();
      }
    } catch (error) {
      runError = logError(error);
      runLogger.error(`  Replay stopped before all discovered flows were verified: ${runError}`);
      runLogger.debug("replay.incomplete", "Replay stopped with partial results", {
        confirmedFlows: confirmedFlows.length,
        replayConfirmed: replayConfirmedIds.length,
        findings: findings.length,
        error: runError,
      });
    }
  } else {
    runLogger.warn("  No flows were ready for replay");
  }

  const summarizedRuntimeErrors = summarizeRuntimeErrors(runtimeErrorEntries);
  const summarizedSafety = summarizeSafety(safetyEvents);
  summarizedSafety.safetyRelatedRuntimeErrors = runtimeErrorEntries
    .filter(({ error }) => error.safetyRelated)
    .reduce((total) => total + 1, 0);

  return {
    runId,
    runName,
    args,
    evidencePath,
    allEntries,
    discovery,
    confirmedFlows,
    replayConfirmedIds,
    findings,
    responseVariantAudits,
    safety: summarizedSafety,
    runtimeErrors: summarizedRuntimeErrors,
    replayFailures,
    error: runError,
  };
}

function createCoverageRuns(args: CliArgs): Array<{ id: string; name: string; args: CliArgs }> {
  const configuredRuns = args.coverageRuns?.length
    ? args.coverageRuns
    : [{ name: args.personaName ? `${args.personaName} baseline` : "default" }];

  return configuredRuns.map((run, index) => ({
    id: `run-${index + 1}`,
    name: run.name,
    args: {
      ...args,
      coverageRuns: undefined,
      personaName: run.persona ?? args.personaName,
      maxSteps: run.maxSteps ?? args.maxSteps,
      scope: run.scope ?? args.scope,
      expectations: run.expect !== undefined ? run.expect : args.expectations,
    },
  }));
}

async function exploreCoverage(args: CliArgs, executionId: string): Promise<ExplorationBatch> {
  mkdirSync(args.output, { recursive: true });
  const evidencePath = join(args.output, "evidence.jsonl");
  const evidenceLog = new EvidenceLog(evidencePath);
  const runs: ExplorationRun[] = [];

  const configuredRuns = createCoverageRuns(args);
  for (const [runIndex, configuredRun] of configuredRuns.entries()) {
    const personaLabel = configuredRun.args.personaName ?? configuredRun.name;
    appLogger.info(`Persona ${runIndex + 1}/${configuredRuns.length}: ${personaLabel}`);
    try {
      const run = await exploreAndVerify(configuredRun.args, evidenceLog, configuredRun.id, configuredRun.name);
      runs.push(run);
      const needsReview = Boolean(run.error) || Boolean(run.discovery?.exhausted) || run.safety.blockedRequests > 0 || run.runtimeErrors.length > 0;
      appLogger.info(`  ${needsReview ? "Partial results" : "Completed"}: ${run.replayConfirmedIds.length} of ${run.discovery?.flows.length ?? 0} discovered flow(s) replay-confirmed`, {
        runId: configuredRun.id,
        flowsFound: run.discovery?.flows.length ?? 0,
        replayConfirmed: run.replayConfirmedIds.length,
        findings: run.findings.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error(`  Persona failed: ${message}`);
      runs.push({
        runId: configuredRun.id,
        runName: configuredRun.name,
        args: configuredRun.args,
        evidencePath,
        allEntries: [],
        confirmedFlows: [],
        replayConfirmedIds: [],
        findings: [],
        responseVariantAudits: [],
        safety: emptySafety(),
        runtimeErrors: [],
        replayFailures: {},
        error: message,
      });
    }
  }

  const evidence = readEvidenceLog(evidencePath);
  if (evidence.issues.length > 0) {
    appLogger.warn(`  Evidence warning: skipped ${evidence.issues.length} malformed record${evidence.issues.length === 1 ? "" : "s"}`);
    appLogger.debug("evidence.records_skipped", "Malformed evidence records were skipped", { issues: evidence.issues });
  }
  const allEntries = evidence.entries;
  const confirmedFlows = runs.flatMap((run) => run.confirmedFlows.map((flow) => ({
    ...flow,
    name: `${run.runName}: ${flow.name}`,
  })));
  return { executionId, args, evidencePath, runs, allEntries, confirmedFlows, evidenceIssues: evidence.issues };
}

function manifestFor(batch: ExplorationBatch): DiscoveryManifest {
  let nextFlowId = 1;
  const flows: DiscoveryManifestFlow[] = [];
  const runs: DiscoveryManifestRun[] = batch.runs.map((run) => {
    const flowIds: number[] = [];
    for (const [runFlowIndex, flow] of (run.discovery?.flows ?? []).entries()) {
      const id = nextFlowId;
      nextFlowId += 1;
      flowIds.push(id);
      const confirmed = run.confirmedFlows.find(
        (candidate) => candidate.origin === "discovered" && candidate.sourceFlowIndex === runFlowIndex,
      );
      flows.push({
        id,
        runId: run.runId,
        runFlowIndex,
        name: flow.finalText || "Flow " + (runFlowIndex + 1),
        title: flow.title,
        verified: flow.verified,
        replayConfirmed: run.replayConfirmedIds.includes(runFlowIndex + 1),
        startIndex: flow.startIndex,
        endIndex: flow.endIndex,
        startUrl: flow.startUrl,
        responseFixtures: confirmed?.responseFixtures,
        origin: "discovered",
        finding: run.findings.find((finding) => finding.flowIndex === runFlowIndex),
      });
    }
    for (const derived of run.confirmedFlows.filter((flow) => flow.origin === "derived")) {
      const source = flows.find(
        (flow) => flow.runId === run.runId && flow.runFlowIndex === derived.sourceFlowIndex,
      );
      if (!source) continue;
      const id = nextFlowId;
      nextFlowId += 1;
      flowIds.push(id);
      flows.push({
        id,
        runId: run.runId,
        runFlowIndex: derived.sourceFlowIndex,
        name: derived.name,
        title: derived.title,
        verified: true,
        replayConfirmed: true,
        startIndex: source.startIndex,
        endIndex: source.endIndex,
        startUrl: derived.startUrl ?? source.startUrl,
        responseFixtures: derived.responseFixtures,
        origin: "derived",
        sourceFlowId: source.id,
        scenarioId: derived.scenarioId,
        responseVariant: derived.responseVariant,
      });
    }
    return {
      id: run.runId,
      name: run.runName,
      persona: run.args.personaName,
      personaIntent: run.args.personaName ? PERSONAS[run.args.personaName]?.intent : undefined,
      maxSteps: run.args.maxSteps,
      scope: run.args.scope,
      expectations: run.args.expectations,
      exhausted: run.discovery?.exhausted ?? false,
      stopReason: run.discovery?.stopReason ?? (run.error ? "error" : "completed"),
      flowIds,
      error: run.error,
    };
  });

  return {
    version: 2,
    executionId: batch.executionId,
    url: batch.args.url,
    createdAt: new Date().toISOString(),
    exhausted: batch.runs.some((run) => Boolean(run.error) || Boolean(run.discovery?.exhausted)),
    setup: {
      requiresLogin: Boolean(batch.args.email || batch.args.password),
      storageStatePath: batch.args.storageStatePath,
    },
    intent: {
      scope: batch.args.scope,
      expectations: batch.args.expectations,
    },
    runs,
    flows,
  };
}

function writeDiscoveryArtifacts(batch: ExplorationBatch): string {
  const manifestPath = join(batch.args.output, "discovery.json");
  writeFileSync(manifestPath, JSON.stringify(manifestFor(batch), null, 2) + "\n");
  return manifestPath;
}

function reportActionLabel(name: string): string {
  const labels: Record<string, string> = {
    navigate: "Navigate",
    click: "Click",
    fill: "Fill",
    select: "Select",
    pressKey: "Press key",
    check: "Check",
    uncheck: "Uncheck",
    hover: "Hover",
    goBack: "Go back",
    goForward: "Go forward",
    reload: "Reload",
    hardReload: "Hard reload",
    openInNewTab: "Open new tab",
    reopenBrowser: "Reopen browser",
    scroll: "Scroll",
    setViewportSize: "Set viewport",
    waitFor: "Wait for element",
    uploadFile: "Upload file",
    handleDialog: "Handle dialog",
    verifyExpectation: "Verify expectation",
    clearCookie: "Clear cookie",
    simulateFailure: "Simulate failure",
    simulateLatency: "Simulate latency",
    burst: "Repeat action",
  };
  return labels[name] ?? name;
}

function reportStepValue(entry: EvidenceEntry): string | undefined {
  const input = entry.toolCall?.input ?? {};
  const value = input.value ?? input.key ?? input.mode;
  if (value === undefined) return undefined;
  const target = typeof input.locator === "string" ? input.locator : "";
  return /password|card|cvv|secret|token/i.test(target) ? "[redacted]" : String(value);
}

function reportSteps(entries: EvidenceEntry[], errorLabel: string): ReportStep[] {
  return entries
    .filter((entry) => entry.toolCall && entry.toolCall.name !== "flowComplete")
    .map((entry, index) => {
      const input = entry.toolCall!.input;
      const target = typeof input.locator === "string"
        ? input.locator
        : typeof input.url === "string"
          ? input.url
          : undefined;
      return {
        number: index + 1,
        action: reportActionLabel(entry.toolCall!.name),
        target,
        value: reportStepValue(entry),
        error: entry.error,
        errorLabel: entry.error ? errorLabel : undefined,
        safetyBlocked: entry.safetyBlocked,
      };
    });
}

function reportFlowsForRun(run: ExplorationRun): ReportFlow[] {
  const discovered = (run.discovery?.flows ?? []).map((flow, index): ReportFlow => {
    const entries = run.allEntries.filter((entry) => entry.flowIndex === index && entry.scenarioId === undefined);
    const finding = run.findings.find((candidate) => candidate.flowIndex === index);
    const runtimeIssues = run.runtimeErrors.filter((error) => error.phase === "replay" && error.flowIndex === index + 1);
    return {
      id: `${run.runId}-flow-${index + 1}`,
      title: flow.title ?? formatTestTitle(flow.finalText || `Flow ${index + 1}`),
      summary: flow.finalText || "No flow summary provided.",
      origin: "discovered",
      discoveryVerified: flow.verified,
      replayConfirmed: run.replayConfirmedIds.includes(index + 1),
      runtimeIssues,
      steps: reportSteps(entries, "Exploration action failed"),
      replayFailure: run.replayFailures[index],
      finding,
    };
  });
  const derived = run.confirmedFlows
    .filter((flow) => flow.origin === "derived")
    .map((flow, index): ReportFlow => ({
      id: flow.scenarioId ?? `${run.runId}-derived-${index + 1}`,
      title: flow.title ?? formatTestTitle(flow.name),
      summary: flow.name,
      origin: "derived",
      discoveryVerified: true,
      replayConfirmed: true,
      runtimeIssues: [],
      steps: reportSteps(flow.entries, "Replay action failed"),
    }));
  return [...discovered, ...derived];
}

function writeExecutionReport(
  batch: ExplorationBatch,
  command: "explore" | "run",
  execution: { id: string; startedAt: string },
  generatedTests: number,
): ExecutionReport {
  const artifacts = {
    reportJson: "report.json",
    reportHtml: "report.html",
    discovery: "discovery.json",
    evidence: "evidence.jsonl",
    ...(generatedTests > 0 ? { testSuite: "discovered.spec.ts" } : {}),
  };
  const report = buildExecutionReport({
    executionId: execution.id,
    command,
    url: batch.args.url,
    startedAt: execution.startedAt,
    completedAt: new Date().toISOString(),
    scope: batch.args.scope,
    expectations: batch.args.expectations,
    generatedTests,
    artifacts,
    issues: batch.evidenceIssues.map((issue): ReportIssue => ({
      source: "evidence",
      severity: "warning",
      line: issue.line,
      message: issue.reason,
    })),
    runs: batch.runs.map((run) => ({
      id: run.runId,
      name: run.runName,
      persona: run.args.personaName,
      personaIntent: run.args.personaName ? PERSONAS[run.args.personaName]?.intent : undefined,
      flowsFound: run.discovery?.flows.length ?? 0,
      replayConfirmed: run.replayConfirmedIds.length,
      generatedTests: command === "run" ? run.confirmedFlows.length : 0,
      exhausted: run.discovery?.exhausted ?? false,
      stopReason: run.discovery?.stopReason ?? (run.error ? "error" : "completed"),
      safety: run.safety,
      runtimeErrors: run.runtimeErrors,
      flows: reportFlowsForRun(run),
      findings: run.findings,
      responseVariants: run.responseVariantAudits,
      error: run.error,
    })),
  });
  writeFileSync(join(batch.args.output, artifacts.reportJson), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(batch.args.output, artifacts.reportHtml), renderHtmlReport(report));
  return report;
}

function resolveDiscoveryInput(input: string): { manifestPath: string; inputDir: string } {
  const manifestPath = input.endsWith(".json") ? input : join(input, "discovery.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Discovery manifest not found: " + manifestPath + ". Run 'explore <url>' first.");
  }
  return { manifestPath, inputDir: dirname(manifestPath) };
}

function loadManifest(path: string): DiscoveryManifest {
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as DiscoveryManifest;
  if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.flows)) {
    throw new Error("Unsupported discovery manifest: " + path);
  }
  return manifest;
}

function selectManifestFlows(manifest: DiscoveryManifest, selection: number[] | undefined): DiscoveryManifestFlow[] {
  const selectedIds = selection ?? manifest.flows.filter((flow) => flow.replayConfirmed).map((flow) => flow.id);
  const knownIds = new Set(manifest.flows.map((flow) => flow.id));
  const unknownIds = selectedIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error("Unknown flow id(s): " + unknownIds.join(", ") + ". Available: 1-" + manifest.flows.length + ".");
  }

  const selected = selectedIds.map((id) => manifest.flows.find((flow) => flow.id === id)!);
  const unconfirmed = selected.filter((flow) => !flow.replayConfirmed).map((flow) => flow.id);
  if (unconfirmed.length > 0) {
    throw new Error("Flow(s) " + unconfirmed.join(", ") + " were not confirmed by replay and cannot be generated.");
  }
  if (selected.length === 0) throw new Error("No replay-confirmed flows available to generate.");
  return selected;
}

function generateFromManifest(args: CliArgs): void {
  const { manifestPath, inputDir } = resolveDiscoveryInput(args.url);
  const manifest = loadManifest(manifestPath);
  const evidence = readEvidenceLog(join(inputDir, "evidence.jsonl"));
  if (evidence.issues.length > 0) {
    appLogger.warn(`Evidence warning: skipped ${evidence.issues.length} malformed record${evidence.issues.length === 1 ? "" : "s"}`);
  }
  const entries = evidence.entries;
  const selected = selectManifestFlows(manifest, args.flowSelection);
  const storageStatePath = args.storageStatePath ?? manifest.setup.storageStatePath;
  const useCapturedState = manifest.setup.requiresLogin && !storageStatePath && !(args.email && args.password);
  if (useCapturedState) {
    throw new Error("This discovery used login. Pass -e/-p or --storage-state when generating from it; captured session state is not stored in discovery artifacts.");
  }

  const runNames = new Map((manifest.runs ?? []).map((run) => [run.id, run.name]));
  const flows: FlowEntries[] = selected.map((flow) => {
    const flowEntries = entries.filter((entry) => flow.origin === "derived"
      ? entry.runId === flow.runId && entry.scenarioId === flow.scenarioId
      : flow.runId
        ? entry.runId === flow.runId && entry.scenarioId === undefined && entry.flowIndex === (flow.runFlowIndex ?? 0)
        : entry.flowIndex === flow.id - 1);
    const useFlowState = manifest.version === 2 || useCapturedState;
    return {
      name: flow.runId && runNames.has(flow.runId) ? `${runNames.get(flow.runId)}: ${flow.name}` : flow.name,
      title: flow.title,
      entries: flowEntries,
      startUrl: useFlowState ? flow.startUrl : flow.id === 1 ? undefined : flow.startUrl,
      startStorageState: useFlowState ? flow.startStorageState : flow.id === 1 ? undefined : flow.startStorageState,
      responseFixtures: flow.responseFixtures,
      origin: flow.origin,
    };
  });
  const emptyFlows = flows.filter((flow) => flow.entries.length === 0).map((flow) => flow.name);
  if (emptyFlows.length > 0) {
    throw new Error("Discovery evidence is missing for selected flow(s): " + emptyFlows.join(", "));
  }
  appLogger.debug("codegen.started", "Generating tests from discovery", {
    mode: "generate",
    flows: flows.length,
    baselineFlows: flows.filter((flow) => flow.origin !== "derived").length,
    derivedFlows: flows.filter((flow) => flow.origin === "derived").length,
    baselineFixtures: flows.reduce((total, flow) => total + (flow.responseFixtures?.length ?? 0), 0),
  });
  flows.forEach((flow, index) => {
    appLogger.debug("codegen.flow", "Preparing generated flow", {
      mode: "generate",
      flowIndex: index + 1,
      origin: flow.origin ?? "discovered",
      responseFixtures: flow.responseFixtures?.length ?? 0,
      responseMocking: (flow.responseFixtures?.length ?? 0) > 0,
    });
  });
  const execution = createExecutionDirectory(args.output);
  const specPath = join(execution.path, "discovered.spec.ts");
  writeFileSync(specPath, generateSpec(flows, {
    url: manifest.url,
    username: args.email,
    password: args.password,
    storageStatePath,
  }));
  appLogger.debug("codegen.completed", "Generated test suite", {
    mode: "generate",
    tests: flows.length,
    baselineTests: flows.filter((flow) => flow.origin !== "derived").length,
    derivedTests: flows.filter((flow) => flow.origin === "derived").length,
  });
  appLogger.result("done:\n  execution:                           " + execution.path + "\n  test suite (" + flows.length + " test(s)): " + specPath);
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  appLogger = new Logger(parsedArgs.logLevel);
  if (parsedArgs.command === "generate") {
    generateFromManifest(parsedArgs);
    return;
  }
  const args = applyConfig(parsedArgs);
  appLogger.info(`Starting ${args.command} execution for ${args.url}`);
  appLogger.debug("execution.config_resolved", "Execution configuration resolved", {
    command: args.command, url: args.url, provider: args.provider, model: args.model,
    maxSteps: args.maxSteps, personas: args.coverageRuns?.map((run) => run.name) ?? [args.personaName ?? "default"],
    scopePresent: Boolean(args.scope), expectations: args.expectations.length, screenshots: args.screenshots,
  });
  const execution = createExecutionDirectory(args.output);
  const executionArgs = { ...args, output: execution.path, outputSpecified: true };
  const executionCommand: "explore" | "run" = args.command === "explore" ? "explore" : "run";

  const batch = await exploreCoverage(executionArgs, execution.id);
  const manifestPath = writeDiscoveryArtifacts(batch);
  appLogger.result("done:\n  execution:                           " + execution.path +
    "\n  report JSON:                         " + join(executionArgs.output, "report.json") +
    "\n  report HTML:                         " + join(executionArgs.output, "report.html") +
    "\n  discovery bundle:                   " + manifestPath +
    "\n  evidence:                           " + batch.evidencePath);

  if (executionArgs.command === "explore") {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    appLogger.result(`summary: ${report.summary.runs} persona(s), ${report.summary.flowsFound} flow(s) found, ${report.summary.replayConfirmed} replay-confirmed`);
    return;
  }
  if (batch.confirmedFlows.length === 0) {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    appLogger.result("No confirmed regression flow to generate; see the execution report.");
    return;
  }

  appLogger.info("Generating test suite");
  appLogger.debug("codegen.started", "Generating tests from confirmed flows", {
    mode: "run",
    flows: batch.confirmedFlows.length,
    baselineFlows: batch.confirmedFlows.filter((flow) => flow.origin === "discovered").length,
    derivedFlows: batch.confirmedFlows.filter((flow) => flow.origin === "derived").length,
    baselineFixtures: batch.confirmedFlows.reduce((total, flow) => total + (flow.responseFixtures?.length ?? 0), 0),
  });
  batch.confirmedFlows.forEach((flow, index) => {
    appLogger.debug("codegen.flow", "Preparing generated flow", {
      mode: "run",
      flowIndex: index + 1,
      origin: flow.origin,
      responseFixtures: flow.responseFixtures?.length ?? 0,
      responseMocking: (flow.responseFixtures?.length ?? 0) > 0,
    });
  });
  const specPath = join(executionArgs.output, "discovered.spec.ts");
  writeFileSync(specPath, generateSpec(batch.confirmedFlows, {
    url: executionArgs.url,
    username: executionArgs.email,
    password: executionArgs.password,
    storageStatePath: executionArgs.storageStatePath,
  }));
  appLogger.debug("codegen.completed", "Generated test suite", {
    mode: "run",
    tests: batch.confirmedFlows.length,
    baselineTests: batch.confirmedFlows.filter((flow) => flow.origin === "discovered").length,
    derivedTests: batch.confirmedFlows.filter((flow) => flow.origin === "derived").length,
  });
  appLogger.result("test suite (" + batch.confirmedFlows.length + " test(s)): " + specPath);
  const report = writeExecutionReport(batch, executionCommand, execution, batch.confirmedFlows.length);
  process.exitCode = report.exitCode;
  appLogger.result(`summary: ${report.summary.runs} persona(s), ${report.summary.flowsFound} flow(s) found, ${report.summary.replayConfirmed} replay-confirmed, ${report.summary.generatedTests} test(s) generated`);
}

main().catch((err) => {
  appLogger.error(logError(err));
  appLogger.debug("execution.failed", "Execution failed unexpectedly", { error: logError(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
