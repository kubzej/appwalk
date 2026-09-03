/** Shared runtime validation for persisted discovery artifacts. */

import { isValidWebUrl } from "../url.js";

export interface ArtifactValidationIssue {
  path: string;
  message: string;
}

export const MAX_ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_ITEMS = 100_000;
const MAX_JSON_STRING_LENGTH = 8_000_000;

const EXPECTATION_ASSERTIONS = new Set(["visible", "hidden", "containsText", "urlContains", "urlEquals", "value", "checked", "unchecked", "disabled", "enabled", "count", "unknown"]);
const RESPONSE_ASSERTIONS = new Set(["visible", "hidden", "containsText", "urlContains", "urlEquals"]);
const RUNTIME_ERROR_KINDS = new Set(["console_error", "page_error", "request_failed", "http_error", "page_crash"]);
const STOP_REASONS = new Set(["completed", "agent_stopped", "budget_exhausted", "no_progress", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(issues: ArtifactValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function recordAt(value: unknown, path: string, issues: ArtifactValidationIssue[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return undefined;
  }
  return value;
}

function arrayAt(value: unknown, path: string, issues: ArtifactValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return undefined;
  }
  if (value.length > MAX_JSON_ARRAY_ITEMS) issue(issues, path, `must contain at most ${MAX_JSON_ARRAY_ITEMS} items`);
  return value;
}

function requiredString(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (typeof value[key] !== "string" || value[key].length === 0) issue(issues, `${path}.${key}`, "must be a non-empty string");
}

function requiredWebUrl(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (!isValidWebUrl(value[key])) issue(issues, `${path}.${key}`, "must be a valid absolute http or https URL");
}

function optionalString(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (has(value, key) && (typeof value[key] !== "string" || value[key].length === 0)) issue(issues, `${path}.${key}`, "must be a non-empty string when present");
}

function requiredBoolean(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (typeof value[key] !== "boolean") issue(issues, `${path}.${key}`, "must be a boolean");
}

function optionalBoolean(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (has(value, key) && typeof value[key] !== "boolean") issue(issues, `${path}.${key}`, "must be a boolean when present");
}

function requiredInteger(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[], minimum = 0): void {
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < minimum) {
    issue(issues, `${path}.${key}`, `must be a safe integer >= ${minimum}`);
  }
}

function optionalInteger(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[], minimum = 0): void {
  if (has(value, key) && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < minimum)) {
    issue(issues, `${path}.${key}`, `must be a safe integer >= ${minimum} when present`);
  }
}

function optionalStatus(value: Record<string, unknown>, key: string, path: string, issues: ArtifactValidationIssue[]): void {
  if (has(value, key) && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 100 || value[key] > 599)) {
    issue(issues, `${path}.${key}`, "must be an HTTP status integer between 100 and 599 when present");
  }
}

function enumValue(value: Record<string, unknown>, key: string, path: string, allowed: Set<string>, issues: ArtifactValidationIssue[], required = false): void {
  if (!has(value, key)) {
    if (required) issue(issues, `${path}.${key}`, `is required and must be one of ${[...allowed].join(", ")}`);
    return;
  }
  if (typeof value[key] !== "string" || !allowed.has(value[key])) issue(issues, `${path}.${key}`, `must be one of ${[...allowed].join(", ")}`);
}

function knownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string, issues: ArtifactValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, `${path}.${key}`, "unknown field");
  }
}

function validateJsonValue(value: unknown, path: string, issues: ArtifactValidationIssue[], depth = 0): void {
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) issue(issues, path, `string exceeds ${MAX_JSON_STRING_LENGTH} characters`);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) issue(issues, path, "must contain only finite numbers");
    return;
  }
  if (depth >= MAX_JSON_DEPTH) {
    issue(issues, path, `nested value exceeds maximum depth of ${MAX_JSON_DEPTH}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) issue(issues, path, `array exceeds ${MAX_JSON_ARRAY_ITEMS} items`);
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues, depth + 1));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => validateJsonValue(item, `${path}.${key}`, issues, depth + 1));
    return;
  }
  issue(issues, path, "contains a non-JSON value");
}

function validateStringArray(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const items = arrayAt(value, path, issues);
  items?.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) issue(issues, `${path}[${index}]`, "must be a non-empty string");
  });
}

function validateExpectation(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["expectationIndex", "status", "assertion", "locator", "value", "expectedCount", "detail"]), path, issues);
  requiredInteger(object, "expectationIndex", path, issues, 0);
  enumValue(object, "status", path, new Set(["met", "violated", "unknown"]), issues, true);
  enumValue(object, "assertion", path, EXPECTATION_ASSERTIONS, issues, true);
  optionalString(object, "locator", path, issues);
  optionalString(object, "value", path, issues);
  optionalInteger(object, "expectedCount", path, issues, 0);
  requiredString(object, "detail", path, issues);
}

function validateStepResult(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["url", "snapshot", "expectation"]), path, issues);
  requiredString(object, "url", path, issues);
  requiredString(object, "snapshot", path, issues);
  if (has(object, "expectation")) validateExpectation(object.expectation, `${path}.expectation`, issues);
}

function validateNetworkEntry(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["method", "url", "status", "body", "bodyReadTimedOut"]), path, issues);
  requiredString(object, "method", path, issues);
  requiredString(object, "url", path, issues);
  optionalStatus(object, "status", path, issues);
  optionalBoolean(object, "bodyReadTimedOut", path, issues);
  if (has(object, "body")) validateJsonValue(object.body, `${path}.body`, issues);
}

function validateRuntimeError(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["kind", "message", "method", "url", "status", "safetyRelated", "lifecycle"]), path, issues);
  enumValue(object, "kind", path, RUNTIME_ERROR_KINDS, issues, true);
  requiredString(object, "message", path, issues);
  optionalString(object, "method", path, issues);
  optionalString(object, "url", path, issues);
  optionalStatus(object, "status", path, issues);
  optionalBoolean(object, "safetyRelated", path, issues);
  optionalBoolean(object, "lifecycle", path, issues);
}

export function validateEvidenceEntry(value: unknown, line: number): ArtifactValidationIssue[] {
  const issues: ArtifactValidationIssue[] = [];
  const path = `evidence line ${line}`;
  const object = recordAt(value, path, issues);
  if (!object) return issues;
  knownKeys(object, new Set(["index", "flowIndex", "runId", "scenarioId", "origin", "timestamp", "toolCall", "result", "error", "finalText", "network", "console", "runtimeErrors", "safetyBlocked", "webSocketFrames"]), path, issues);
  requiredInteger(object, "index", path, issues, 0);
  requiredInteger(object, "flowIndex", path, issues, 0);
  optionalString(object, "runId", path, issues);
  optionalString(object, "scenarioId", path, issues);
  enumValue(object, "origin", path, new Set(["discovered", "derived"]), issues);
  requiredString(object, "timestamp", path, issues);
  optionalString(object, "error", path, issues);
  optionalString(object, "finalText", path, issues);
  optionalInteger(object, "safetyBlocked", path, issues, 0);

  const toolCall = has(object, "toolCall") ? recordAt(object.toolCall, `${path}.toolCall`, issues) : undefined;
  if (toolCall) {
    knownKeys(toolCall, new Set(["name", "input"]), `${path}.toolCall`, issues);
    requiredString(toolCall, "name", `${path}.toolCall`, issues);
    const input = recordAt(toolCall.input, `${path}.toolCall.input`, issues);
    if (input) validateJsonValue(input, `${path}.toolCall.input`, issues);
  }
  if (has(object, "result")) validateStepResult(object.result, `${path}.result`, issues);
  const network = arrayAt(object.network, `${path}.network`, issues);
  network?.forEach((entry, index) => validateNetworkEntry(entry, `${path}.network[${index}]`, issues));
  const consoleEntries = arrayAt(object.console, `${path}.console`, issues);
  consoleEntries?.forEach((entry, index) => {
    const item = recordAt(entry, `${path}.console[${index}]`, issues);
    if (!item) return;
    knownKeys(item, new Set(["type", "text"]), `${path}.console[${index}]`, issues);
    requiredString(item, "type", `${path}.console[${index}]`, issues);
    requiredString(item, "text", `${path}.console[${index}]`, issues);
  });
  const runtimeErrors = has(object, "runtimeErrors") ? arrayAt(object.runtimeErrors, `${path}.runtimeErrors`, issues) : undefined;
  runtimeErrors?.forEach((entry, index) => validateRuntimeError(entry, `${path}.runtimeErrors[${index}]`, issues));
  const frames = has(object, "webSocketFrames") ? arrayAt(object.webSocketFrames, `${path}.webSocketFrames`, issues) : undefined;
  frames?.forEach((entry, index) => {
    const item = recordAt(entry, `${path}.webSocketFrames[${index}]`, issues);
    if (!item) return;
    knownKeys(item, new Set(["url", "direction", "payload"]), `${path}.webSocketFrames[${index}]`, issues);
    requiredString(item, "url", `${path}.webSocketFrames[${index}]`, issues);
    enumValue(item, "direction", `${path}.webSocketFrames[${index}]`, new Set(["sent", "received"]), issues, true);
    requiredString(item, "payload", `${path}.webSocketFrames[${index}]`, issues);
  });
  return issues;
}

function validateResponseFixture(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["method", "url", "occurrence", "urlPattern", "status", "body"]), path, issues);
  requiredString(object, "method", path, issues);
  requiredString(object, "url", path, issues);
  optionalInteger(object, "occurrence", path, issues, 1);
  optionalString(object, "urlPattern", path, issues);
  requiredInteger(object, "status", path, issues, 100);
  if (typeof object.status === "number" && object.status > 599) issue(issues, `${path}.status`, "must be an HTTP status integer between 100 and 599");
  if (!has(object, "body")) issue(issues, `${path}.body`, "is required");
  else validateJsonValue(object.body, `${path}.body`, issues);
}

function validateResponseVariant(value: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  const object = recordAt(value, path, issues);
  if (!object) return;
  knownKeys(object, new Set(["name", "sourceMethod", "sourceUrl", "sourceOccurrence", "patches", "expectation", "reason"]), path, issues);
  requiredString(object, "name", path, issues);
  optionalString(object, "sourceMethod", path, issues);
  requiredString(object, "sourceUrl", path, issues);
  optionalInteger(object, "sourceOccurrence", path, issues, 1);
  optionalString(object, "reason", path, issues);
  const patches = arrayAt(object.patches, `${path}.patches`, issues);
  patches?.forEach((patch, index) => {
    const itemPath = `${path}.patches[${index}]`;
    const item = recordAt(patch, itemPath, issues);
    if (!item) return;
    knownKeys(item, new Set(["path", "value"]), itemPath, issues);
    requiredString(item, "path", itemPath, issues);
    if (!has(item, "value")) issue(issues, `${itemPath}.value`, "is required");
    else validateJsonValue(item.value, `${itemPath}.value`, issues);
  });
  const expectation = recordAt(object.expectation, `${path}.expectation`, issues);
  if (expectation) {
    knownKeys(expectation, new Set(["assertion", "locator", "value"]), `${path}.expectation`, issues);
    enumValue(expectation, "assertion", `${path}.expectation`, RESPONSE_ASSERTIONS, issues, true);
    optionalString(expectation, "locator", `${path}.expectation`, issues);
    optionalString(expectation, "value", `${path}.expectation`, issues);
  }
}

export function validateDiscoveryManifest(value: unknown): ArtifactValidationIssue[] {
  const issues: ArtifactValidationIssue[] = [];
  const path = "manifest";
  const manifest = recordAt(value, path, issues);
  if (!manifest) return issues;
  knownKeys(manifest, new Set(["version", "executionId", "url", "createdAt", "exhausted", "setup", "intent", "runs", "flows"]), path, issues);
  if (manifest.version !== 1 && manifest.version !== 2) issue(issues, `${path}.version`, "must be 1 or 2");
  optionalString(manifest, "executionId", path, issues);
  requiredWebUrl(manifest, "url", path, issues);
  requiredString(manifest, "createdAt", path, issues);
  requiredBoolean(manifest, "exhausted", path, issues);

  const setup = recordAt(manifest.setup, `${path}.setup`, issues);
  if (setup) {
    knownKeys(setup, new Set(["requiresLogin", "storageStatePath"]), `${path}.setup`, issues);
    requiredBoolean(setup, "requiresLogin", `${path}.setup`, issues);
    optionalString(setup, "storageStatePath", `${path}.setup`, issues);
  }
  const intent = recordAt(manifest.intent, `${path}.intent`, issues);
  if (intent) {
    knownKeys(intent, new Set(["scope", "expectations"]), `${path}.intent`, issues);
    optionalString(intent, "scope", `${path}.intent`, issues);
    validateStringArray(intent.expectations, `${path}.intent.expectations`, issues);
  }

  const runs = has(manifest, "runs") ? arrayAt(manifest.runs, `${path}.runs`, issues) : undefined;
  const runIds = new Set<string>();
  runs?.forEach((run, index) => {
    const runPath = `${path}.runs[${index}]`;
    const item = recordAt(run, runPath, issues);
    if (!item) return;
    knownKeys(item, new Set(["id", "name", "persona", "personaIntent", "maxSteps", "scope", "expectations", "exhausted", "stopReason", "flowIds", "error"]), runPath, issues);
    requiredString(item, "id", runPath, issues);
    if (typeof item.id === "string") {
      if (runIds.has(item.id)) issue(issues, `${runPath}.id`, "must be unique");
      runIds.add(item.id);
    }
    requiredString(item, "name", runPath, issues);
    optionalString(item, "persona", runPath, issues);
    enumValue(item, "personaIntent", runPath, new Set(["journey", "challenge"]), issues);
    requiredInteger(item, "maxSteps", runPath, issues, 1);
    optionalString(item, "scope", runPath, issues);
    validateStringArray(item.expectations, `${runPath}.expectations`, issues);
    requiredBoolean(item, "exhausted", runPath, issues);
    enumValue(item, "stopReason", runPath, STOP_REASONS, issues);
    const flowIds = arrayAt(item.flowIds, `${runPath}.flowIds`, issues);
    flowIds?.forEach((flowId, flowIndex) => {
      if (typeof flowId !== "number" || !Number.isSafeInteger(flowId) || flowId < 1) issue(issues, `${runPath}.flowIds[${flowIndex}]`, "must be a positive safe integer");
    });
    optionalString(item, "error", runPath, issues);
  });

  const flows = arrayAt(manifest.flows, `${path}.flows`, issues);
  const flowIds = new Set<number>();
  flows?.forEach((flow, index) => {
    const flowPath = `${path}.flows[${index}]`;
    const item = recordAt(flow, flowPath, issues);
    if (!item) return;
    knownKeys(item, new Set(["id", "runId", "runFlowIndex", "name", "title", "verified", "replayConfirmed", "startIndex", "endIndex", "startUrl", "responseFixtures", "origin", "sourceFlowId", "scenarioId", "responseVariant", "finding"]), flowPath, issues);
    requiredInteger(item, "id", flowPath, issues, 1);
    if (typeof item.id === "number") {
      if (flowIds.has(item.id)) issue(issues, `${flowPath}.id`, "must be unique");
      flowIds.add(item.id);
    }
    optionalString(item, "runId", flowPath, issues);
    optionalInteger(item, "runFlowIndex", flowPath, issues, 0);
    requiredString(item, "name", flowPath, issues);
    optionalString(item, "title", flowPath, issues);
    requiredBoolean(item, "verified", flowPath, issues);
    requiredBoolean(item, "replayConfirmed", flowPath, issues);
    requiredInteger(item, "startIndex", flowPath, issues, 0);
    requiredInteger(item, "endIndex", flowPath, issues, 0);
    if (typeof item.startIndex === "number" && typeof item.endIndex === "number" && item.endIndex < item.startIndex) issue(issues, flowPath, "endIndex must be >= startIndex");
    requiredWebUrl(item, "startUrl", flowPath, issues);
    enumValue(item, "origin", flowPath, new Set(["discovered", "derived"]), issues);
    optionalInteger(item, "sourceFlowId", flowPath, issues, 1);
    optionalString(item, "scenarioId", flowPath, issues);
    if (has(item, "responseFixtures")) {
      const fixtures = arrayAt(item.responseFixtures, `${flowPath}.responseFixtures`, issues);
      fixtures?.forEach((fixture, fixtureIndex) => validateResponseFixture(fixture, `${flowPath}.responseFixtures[${fixtureIndex}]`, issues));
    }
    if (has(item, "responseVariant")) validateResponseVariant(item.responseVariant, `${flowPath}.responseVariant`, issues);
    if (has(item, "finding")) {
      const finding = recordAt(item.finding, `${flowPath}.finding`, issues);
      if (finding) {
        knownKeys(finding, new Set(["status", "summary", "failure"]), `${flowPath}.finding`, issues);
        enumValue(finding, "status", `${flowPath}.finding`, new Set(["confirmed", "inconclusive"]), issues, true);
        requiredString(finding, "summary", `${flowPath}.finding`, issues);
        optionalString(finding, "failure", `${flowPath}.finding`, issues);
      }
    }
    if (item.origin === "derived" && (typeof item.sourceFlowId !== "number" || typeof item.scenarioId !== "string")) {
      issue(issues, flowPath, "derived flow requires sourceFlowId and scenarioId");
    }
  });

  if (runs && flows) {
    const runIdSet = new Set(runs.flatMap((run) => isRecord(run) && typeof run.id === "string" ? [run.id] : []));
    flows.forEach((flow, index) => {
      if (!isRecord(flow)) return;
      if (typeof flow.runId === "string" && !runIdSet.has(flow.runId)) issue(issues, `${path}.flows[${index}].runId`, "must reference an existing run");
      if (typeof flow.sourceFlowId === "number" && !flowIds.has(flow.sourceFlowId)) issue(issues, `${path}.flows[${index}].sourceFlowId`, "must reference an existing flow");
    });
    runs.forEach((run, index) => {
      if (!isRecord(run) || !Array.isArray(run.flowIds)) return;
      const seen = new Set<number>();
      run.flowIds.forEach((flowId, flowIndex) => {
        if (typeof flowId !== "number") return;
        if (seen.has(flowId)) issue(issues, `${path}.runs[${index}].flowIds[${flowIndex}]`, "must be unique within the run");
        seen.add(flowId);
        if (!flowIds.has(flowId)) issue(issues, `${path}.runs[${index}].flowIds[${flowIndex}]`, "must reference an existing flow");
      });
    });
  }
  return issues;
}

export function formatArtifactIssues(issues: ArtifactValidationIssue[], max = 8): string {
  const shown = issues.slice(0, max).map((item) => `${item.path}: ${item.message}`);
  return issues.length > max ? `${shown.join("; ")}; and ${issues.length - max} more issue(s)` : shown.join("; ");
}
