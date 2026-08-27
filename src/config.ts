import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type ProviderName = "anthropic" | "gemini" | "ollama" | "grok" | "openai";

export interface CoverageRunConfig {
  name: string;
  persona?: string;
  maxSteps?: number;
  scope?: string;
  expect?: string[];
}

export interface AppwalkConfig {
  version: number;
  url?: string;
  output?: string;
  provider?: ProviderName;
  model?: string;
  maxSteps?: number;
  screenshots?: boolean;
  responses?: {
    maxVariants?: number;
    maxFixtureBytes?: number;
  };
  auth?: {
    email?: string;
    password?: string;
    storageState?: string;
  };
  safety?: {
    allowDestructive?: boolean;
    blockMethods?: string[];
    config?: string;
  };
  scope?: string;
  expect?: string[];
  coverage?: {
    runs?: CoverageRunConfig[];
  };
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const replacement = process.env[name];
    if (replacement === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return replacement;
  });
}

function expandStrings(value: unknown): unknown {
  if (typeof value === "string") return expandEnv(value);
  if (Array.isArray(value)) return value.map(expandStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandStrings(entry)]));
  }
  return value;
}

export function isProvider(value: unknown): value is ProviderName {
  return value === "anthropic" || value === "gemini" || value === "ollama" || value === "grok" || value === "openai";
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateStringList(value: unknown, label: string, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be a list of strings in ${path}.`);
  }
}

export function validateMaxSteps(value: unknown, label: string, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer in ${path}.`);
  }
}

export function validateNonNegativeInteger(value: unknown, label: string, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer in ${path}.`);
  }
}

/** Validates the flattened options after CLI values and YAML values have been merged. */
export function validateResolvedOptions(options: Record<string, unknown>, path = "options"): void {
  if (!isNonEmptyString(options.url)) throw new Error(`url must be a non-empty string in ${path}.`);
  if (!isNonEmptyString(options.output)) throw new Error(`output must be a non-empty string in ${path}.`);
  if (!isProvider(options.provider)) throw new Error(`provider must be one of anthropic, gemini, ollama, grok, or openai in ${path}.`);
  if (!isNonEmptyString(options.model)) throw new Error(`model must be a non-empty string in ${path}.`);
  validateMaxSteps(options.maxSteps, "maxSteps", path);

  for (const key of ["screenshots", "allowDestructive"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new Error(`${key} must be a boolean in ${path}.`);
    }
  }
  for (const key of ["email", "password", "storageStatePath", "safetyConfigPath", "scope", "personaName"] as const) {
    if (options[key] !== undefined && !isNonEmptyString(options[key])) {
      throw new Error(`${key} must be a non-empty string in ${path}.`);
    }
  }
  if (options.responseVariantMax !== undefined) {
    validateNonNegativeInteger(options.responseVariantMax, "responseVariantMax", path);
  }
  if (options.responseFixtureMaxBytes !== undefined) {
    validateNonNegativeInteger(options.responseFixtureMaxBytes, "responseFixtureMaxBytes", path);
  }
  if (options.blockMethods !== undefined) validateStringList(options.blockMethods, "blockMethods", path);
  if (options.expectations !== undefined) validateStringList(options.expectations, "expectations", path);
  if (options.flowSelection !== undefined) {
    if (!Array.isArray(options.flowSelection) || options.flowSelection.some((id) => !Number.isInteger(id) || (id as number) < 1)) {
      throw new Error(`flowSelection must contain positive integers in ${path}.`);
    }
  }
  if (options.logLevel !== undefined && !["quiet", "normal", "verbose", "debug"].includes(options.logLevel as string)) {
    throw new Error(`logLevel must be quiet, normal, verbose, or debug in ${path}.`);
  }
}

function validateObject(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object in ${path}.`);
  }
  return value as Record<string, unknown>;
}

function validateConfig(value: unknown, path: string): AppwalkConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Config must contain an object: ${path}`);
  const config = value as Record<string, unknown>;
  if (config.version !== 1) throw new Error(`Unsupported config version in ${path}. Expected version: 1.`);
  if (config.provider !== undefined && !isProvider(config.provider)) throw new Error(`Invalid provider in ${path}.`);
  if (config.model !== undefined && !isNonEmptyString(config.model)) throw new Error(`model must be a non-empty string in ${path}.`);
  if (config.url !== undefined && !isNonEmptyString(config.url)) throw new Error(`url must be a non-empty string in ${path}.`);
  if (config.output !== undefined && !isNonEmptyString(config.output)) throw new Error(`output must be a non-empty string in ${path}.`);
  if (config.maxSteps !== undefined) validateMaxSteps(config.maxSteps, "maxSteps", path);
  if (config.screenshots !== undefined && typeof config.screenshots !== "boolean") {
    throw new Error(`screenshots must be a boolean in ${path}.`);
  }
  if (config.responses !== undefined) {
    const responses = validateObject(config.responses, "responses", path);
    if (responses.maxVariants !== undefined) validateNonNegativeInteger(responses.maxVariants, "responses.maxVariants", path);
    if (responses.maxFixtureBytes !== undefined) validateNonNegativeInteger(responses.maxFixtureBytes, "responses.maxFixtureBytes", path);
  }
  if (config.scope !== undefined && !isNonEmptyString(config.scope)) throw new Error(`scope must be a non-empty string in ${path}.`);
  if (config.auth !== undefined) {
    const auth = validateObject(config.auth, "auth", path);
    for (const key of ["email", "password", "storageState"]) {
      if (auth[key] !== undefined && !isNonEmptyString(auth[key])) {
        throw new Error(`auth.${key} must be a non-empty string in ${path}.`);
      }
    }
  }
  if (config.safety !== undefined) {
    const safety = validateObject(config.safety, "safety", path);
    if (safety.allowDestructive !== undefined && typeof safety.allowDestructive !== "boolean") {
      throw new Error(`safety.allowDestructive must be a boolean in ${path}.`);
    }
    if (safety.blockMethods !== undefined) validateStringList(safety.blockMethods, "safety.blockMethods", path);
    if (safety.config !== undefined && !isNonEmptyString(safety.config)) {
      throw new Error(`safety.config must be a non-empty string in ${path}.`);
    }
  }
  if (config.coverage !== undefined) {
    if (!config.coverage || typeof config.coverage !== "object" || Array.isArray(config.coverage)) {
      throw new Error(`coverage must be an object in ${path}.`);
    }
    const runs = (config.coverage as Record<string, unknown>).runs;
    if (runs !== undefined && (!Array.isArray(runs) || runs.some((run) => !run || typeof run !== "object" || Array.isArray(run)))) {
      throw new Error(`coverage.runs must be a list of run objects in ${path}.`);
    }
    for (const [index, run] of ((runs as unknown[] | undefined) ?? []).entries()) {
      const runConfig = run as Record<string, unknown>;
      if (!isNonEmptyString(runConfig.name)) throw new Error(`coverage.runs[${index}].name is required in ${path}.`);
      if (runConfig.persona !== undefined && !isNonEmptyString(runConfig.persona)) {
        throw new Error(`coverage.runs[${index}].persona must be a non-empty string in ${path}.`);
      }
      if (runConfig.maxSteps !== undefined) validateMaxSteps(runConfig.maxSteps, `coverage.runs[${index}].maxSteps`, path);
      if (runConfig.scope !== undefined && !isNonEmptyString(runConfig.scope)) {
        throw new Error(`coverage.runs[${index}].scope must be a non-empty string in ${path}.`);
      }
      if (runConfig.expect !== undefined) validateStringList(runConfig.expect, `coverage.runs[${index}].expect`, path);
    }
  }
  if (config.expect !== undefined) validateStringList(config.expect, "expect", path);
  return config as unknown as AppwalkConfig;
}

export function loadAppwalkConfig(path: string): AppwalkConfig {
  const parsed = expandStrings(parse(readFileSync(path, "utf-8")));
  return validateConfig(parsed, path);
}
