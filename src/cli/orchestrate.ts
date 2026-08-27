import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { runAgentLoop, type LoopResult } from "../agent/loop.js";
import { PERSONAS, type PersonaIntent } from "../agent/personas.js";
import { login } from "../browser/login.js";
import { configurePageTimeouts } from "../browser/actions.js";
import { formatTestTitle, type FlowEntries } from "../codegen/spec.js";
import type { ProviderName } from "../config.js";
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
import { logError } from "../logging/logger.js";
import type {
  ReportFlow,
  ReportResponseVariantAudit,
  ReportRuntimeError,
  ReportSafety,
  ReportStopReason,
} from "../report/contract.js";
import { extractActions, hasObservableReplayDifference, replay } from "../verify/replay.js";
import type { CliArgs } from "./args.js";
import type { DiscoveryManifest, DiscoveryManifestFlow, DiscoveryManifestRun } from "./manifest.js";
import { appLogger } from "./logger-state.js";

export interface ExplorationRun {
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

export interface ExplorationBatch {
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

export function runOutcome(run: ExplorationRun): { personaIntent: PersonaIntent | undefined; exhausted: boolean; stopReason: ReportStopReason } {
  return {
    personaIntent: run.args.personaName ? PERSONAS[run.args.personaName]?.intent : undefined,
    exhausted: run.discovery?.exhausted ?? false,
    stopReason: run.discovery?.stopReason ?? (run.error ? "error" : "completed"),
  };
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

export async function exploreCoverage(args: CliArgs, executionId: string): Promise<ExplorationBatch> {
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
    const outcome = runOutcome(run);
    return {
      id: run.runId,
      name: run.runName,
      persona: run.args.personaName,
      personaIntent: outcome.personaIntent,
      maxSteps: run.args.maxSteps,
      scope: run.args.scope,
      expectations: run.args.expectations,
      exhausted: outcome.exhausted,
      stopReason: outcome.stopReason,
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

export function writeDiscoveryArtifacts(batch: ExplorationBatch): string {
  const manifestPath = join(batch.args.output, "discovery.json");
  writeFileSync(manifestPath, JSON.stringify(manifestFor(batch), null, 2) + "\n");
  return manifestPath;
}
