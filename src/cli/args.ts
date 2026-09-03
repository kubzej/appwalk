import { loadAppwalkConfig, validateResolvedOptions, type BrowserEngine, type CoverageRunConfig, type ProviderName } from "../config.js";
import type { LogLevel } from "../logging/logger.js";
import { DEFAULT_BLOCK_METHODS, normalizeBlockMethods } from "../safety/methods.js";

const DEFAULT_OUTPUT_DIR = "./appwalk-output";
const DEFAULT_MAX_STEPS = 25;

type Command = "explore" | "generate" | "run";

export interface CliArgs {
  command: Command;
  url: string;
  email?: string;
  password?: string;
  output: string;
  maxSteps: number;
  model?: string;
  provider?: ProviderName;
  browserEngine: BrowserEngine;
  allowDestructive: boolean;
  blockMethods: string[];
  safetyConfigPath?: string;
  storageStatePath?: string;
  screenshots: boolean;
  trace: boolean;
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
    "      --browser chromium|firefox|webkit         Browser engine to drive (default: chromium)",
    "      --allow-destructive",
    "      --block-methods METHOD,...",
    "      --safety-config <path>",
    "      --storage-state <path>",
    "      --screenshots",
    "      --trace                                    Save a Playwright trace (.zip) for exploration and each replayed flow",
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

export function parseArgs(argv: string[]): CliArgs {
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
    maxSteps: DEFAULT_MAX_STEPS,
    browserEngine: "chromium",
    allowDestructive: false,
    blockMethods: [...DEFAULT_BLOCK_METHODS],
    screenshots: false,
    trace: false,
    expectations: [],
    cliSpecified: new Set<string>(),
    logLevel: "normal",
  };
  if (url) args.cliSpecified.add("url");
  const flagKeys = new Map([
    ["--flows", "flowSelection"],
    ["-e", "email"], ["--email", "email"],
    ["-p", "password"], ["--password", "password"],
    ["-o", "output"], ["--output", "output"],
    ["-n", "maxSteps"], ["--max-steps", "maxSteps"],
    ["--response-variant-max", "responseVariantMax"],
    ["--response-fixture-max-bytes", "responseFixtureMaxBytes"],
    ["-m", "model"], ["--model", "model"],
    ["--provider", "provider"], ["--browser", "browserEngine"],
    ["--block-methods", "blockMethods"], ["--safety-config", "safetyConfigPath"],
    ["--storage-state", "storageStatePath"], ["--persona", "personaName"],
    ["--scope", "scope"], ["--expect", "expectations"], ["--config", "configPath"],
    ["--allow-destructive", "allowDestructive"], ["--screenshots", "screenshots"],
    ["--trace", "trace"], ["--quiet", "logLevel"], ["--verbose", "logLevel"], ["--debug", "logLevel"],
  ]);
  const valueFlags = new Set([
    "--flows", "-e", "--email", "-p", "--password", "-o", "--output", "-n", "--max-steps",
    "--response-variant-max", "--response-fixture-max-bytes", "-m", "--model", "--provider", "--browser",
    "--block-methods", "--safety-config", "--storage-state", "--persona", "--scope", "--expect", "--config",
  ]);
  const repeatableFlags = new Set(["expectations"]);
  const seenFlags = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    const flagKey = flagKeys.get(flag);
    if (flagKey === undefined) {
      return printUsage(flag.startsWith("-")
        ? `Unknown option "${flag}".`
        : `Unexpected positional argument "${flag}".`);
    }
    if (!repeatableFlags.has(flagKey)) {
      if (seenFlags.has(flagKey)) return printUsage(`Option "${flag}" was specified more than once.`);
      seenFlags.add(flagKey);
    }
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
    if (flag === "--trace") {
      args.trace = true;
      args.cliSpecified.add("trace");
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
    else if (flag === "--browser" && value) {
      args.browserEngine = value as BrowserEngine;
      args.cliSpecified.add("browserEngine");
    }
    else if (flag === "--block-methods" && value) {
      args.blockMethods = normalizeBlockMethods(value.split(","));
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

export function applyConfig(args: CliArgs): CliArgs {
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
  if (!args.cliSpecified.has("browserEngine") && config.browser) args.browserEngine = config.browser;
  if (!args.cliSpecified.has("personaName") && config.persona) args.personaName = config.persona;
  if (!args.cliSpecified.has("maxSteps") && config.maxSteps !== undefined) args.maxSteps = config.maxSteps;
  if (!args.cliSpecified.has("screenshots") && config.screenshots !== undefined) args.screenshots = config.screenshots;
  if (!args.cliSpecified.has("trace") && config.trace !== undefined) args.trace = config.trace;
  if (!args.cliSpecified.has("email") && config.auth?.email) args.email = config.auth.email;
  if (!args.cliSpecified.has("password") && config.auth?.password) args.password = config.auth.password;
  if (!args.cliSpecified.has("storageStatePath") && config.auth?.storageState) args.storageStatePath = config.auth.storageState;
  if (!args.cliSpecified.has("allowDestructive") && config.safety?.allowDestructive !== undefined) args.allowDestructive = config.safety.allowDestructive;
  if (!args.cliSpecified.has("blockMethods") && config.safety?.blockMethods) args.blockMethods = normalizeBlockMethods(config.safety.blockMethods);
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
