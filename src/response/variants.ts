import type { Page } from "playwright";
import type { EvidenceEntry } from "../evidence/log.js";
import type { ExpectationAssertion } from "../types.js";

export interface ResponseFixture {
  method: string;
  url: string;
  /** Position among captured responses with the same method and URL. */
  occurrence?: number;
  /** Glob used for replay when the captured URL contains a resource identifier. */
  urlPattern?: string;
  status: number;
  body: unknown;
}

export interface ResponsePatch {
  path: string;
  value: unknown;
}

export interface ResponseVariant {
  name: string;
  sourceMethod?: string;
  sourceUrl: string;
  sourceOccurrence?: number;
  patches: ResponsePatch[];
  expectation: ResponseExpectation;
  reason?: string;
}

export interface ResponseExpectation {
  assertion: Exclude<ExpectationAssertion, "unknown">;
  locator?: string;
  value?: string;
}

export interface ResponseFixtureSelector {
  method?: string;
  url: string;
  occurrence?: number;
}

export interface ResponseFixtureInstallOptions {
  /** Called after a captured fixture has been selected and its response is about to be fulfilled. */
  onFixtureApplied?: (fixture: ResponseFixture, requestUrl: string) => void;
}

export interface ResponseVariantParseResult {
  variants: ResponseVariant[];
  candidates: number;
  rejected: number;
  rejectionReasons: string[];
  reason?: string;
  plannerReason?: string;
  incomplete?: boolean;
}

export const RESPONSE_VARIANT_MAX_OUTPUT_TOKENS = 4096;

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compactPromptValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      __preview: "array",
      length: value.length,
      sample: value.length > 0 ? [compactPromptValue(value[0])] : [],
    };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, compactPromptValue(entry)]),
    );
  }
  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 500)}… [truncated]`;
  }
  return value;
}

function compactPromptFixtures(fixtures: ResponseFixture[]): Array<Record<string, unknown>> {
  return fixtures.map((fixture) => ({
    method: fixture.method,
    url: fixture.url,
    occurrence: fixture.occurrence,
    status: fixture.status,
    bodyPreview: compactPromptValue(fixture.body),
  }));
}

function sameOrigin(url: string, applicationUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
}

const SENSITIVE_RESPONSE_KEY = /token$|^(api[-_]?key|authorization|cookie|password|secret|credential)$/i;

function containsSensitiveResponseField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveResponseField(item));
  if (typeof value === "string") return /^Bearer\s|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => SENSITIVE_RESPONSE_KEY.test(key) || containsSensitiveResponseField(entry));
}

function isAuthenticationEndpoint(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /(^|\/)(auth|login|logout|refresh|token)(\/|$)/.test(pathname);
  } catch {
    return false;
  }
}

function isDynamicPathSegment(segment: string): boolean {
  const decoded = decodeURIComponent(segment);
  return /^\d+$/.test(decoded) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded) || /^[0-9a-f]{16,}$/i.test(decoded);
}

/** Returns a replay glob for resource URLs such as `/orders/920`, while keeping collection URLs exact. */
export function responseFixtureUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/");
    let changed = false;
    parsed.pathname = pathParts
      .map((part) => {
        if (!part || !isDynamicPathSegment(part)) return part;
        changed = true;
        return "*";
      })
      .join("/");
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!isDynamicPathSegment(value)) continue;
      parsed.searchParams.set(key, "*");
      changed = true;
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/** Extracts bounded, replayable JSON responses observed during a flow. */
export function extractResponseFixtures(entries: EvidenceEntry[], applicationUrl: string, maxFixtureBytes?: number): ResponseFixture[] {
  const fixtures: ResponseFixture[] = [];
  const occurrences = new Map<string, number>();
  for (const entry of entries) {
    for (const response of entry.network) {
      if (response.status === undefined || response.status < 200 || response.status >= 400) continue;
      if (response.body === undefined || !sameOrigin(response.url, applicationUrl)) continue;
      // Authentication responses can contain bearer tokens or session material. They are
      // never needed to replay an already authenticated flow and must not enter generated code.
      if (isAuthenticationEndpoint(response.url) || containsSensitiveResponseField(response.body)) continue;
      const fixtureKey = `${response.method} ${response.url}`;
      let serialized: string;
      try {
        serialized = JSON.stringify(response.body);
      } catch {
        continue;
      }
      if (maxFixtureBytes !== undefined && serialized.length > maxFixtureBytes) continue;
      const occurrence = (occurrences.get(fixtureKey) ?? 0) + 1;
      occurrences.set(fixtureKey, occurrence);
      const urlPattern = responseFixtureUrlPattern(response.url);
      fixtures.push({
        method: response.method,
        url: response.url,
        occurrence,
        urlPattern: urlPattern === response.url ? undefined : urlPattern,
        status: response.status,
        body: jsonClone(response.body),
      });
    }
  }
  return fixtures;
}

function parsePath(path: string): Array<string | number> | null {
  if (path === "$" || !path.startsWith("$")) return null;
  const tokens: Array<string | number> = [];
  const expression = path.slice(1);
  let offset = 0;
  while (offset < expression.length) {
    if (expression[offset] === ".") {
      const match = /^\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(expression.slice(offset));
      if (!match) return null;
      tokens.push(match[1]!);
      offset += match[0].length;
      continue;
    }
    if (expression[offset] === "[") {
      const match = /^\[(\d+)\]/.exec(expression.slice(offset));
      if (!match) return null;
      tokens.push(Number(match[1]));
      offset += match[0].length;
      continue;
    }
    return null;
  }
  return tokens.length > 0 ? tokens : null;
}

function setExistingJsonPath(root: unknown, path: string, value: unknown): boolean {
  const tokens = parsePath(path);
  if (!tokens) return false;
  let current: unknown = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    if (current === null || typeof current !== "object" || !(token in current)) return false;
    current = (current as Record<string | number, unknown>)[token];
  }
  const last = tokens[tokens.length - 1]!;
  if (current === null || typeof current !== "object" || !(last in current)) return false;
  (current as Record<string | number, unknown>)[last] = jsonClone(value);
  return true;
}

export function applyResponseVariant(fixtures: ResponseFixture[], variant: ResponseVariant): ResponseFixture[] | null {
  const matches = fixtures.filter((fixture) => fixture.url === variant.sourceUrl);
  const methodMatches = variant.sourceMethod
    ? matches.filter((fixture) => fixture.method === variant.sourceMethod)
    : matches;
  const source = variant.sourceOccurrence !== undefined
    ? methodMatches.find((fixture) => fixture.occurrence === variant.sourceOccurrence)
    : methodMatches.length === 1 ? methodMatches[0] : undefined;
  if (!source) return null;
  const next = fixtures.map((fixture) => ({ ...fixture, body: jsonClone(fixture.body) }));
  const sourceIndex = fixtures.indexOf(source);
  const target = next[sourceIndex];
  if (!target) return null;
  for (const patch of variant.patches) {
    if (!setExistingJsonPath(target.body, patch.path, patch.value)) return null;
  }
  return next;
}

export function responseFixtureMatchesSelector(
  fixture: ResponseFixture,
  selector: ResponseFixtureSelector,
): boolean {
  return fixture.url === selector.url &&
    (!selector.method || fixture.method === selector.method) &&
    (selector.occurrence === undefined || fixture.occurrence === selector.occurrence);
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)?.[1];
  const candidate = fenced ?? text.match(/[\[{][\s\S]*[\]}]/)?.[0];
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export function parseResponseVariantsDetailed(
  text: string,
  fixtures: ResponseFixture[],
  maxVariants?: number,
): ResponseVariantParseResult {
  if (maxVariants !== undefined && maxVariants <= 0) {
    return { variants: [], candidates: 0, rejected: 0, rejectionReasons: [], reason: "Variant planning is disabled." };
  }
  const parsed = extractJson(text);
  let candidates: unknown[];
  let plannerReason: string | undefined;
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).variants)) {
    candidates = (parsed as { variants: unknown[] }).variants;
    plannerReason = typeof (parsed as Record<string, unknown>).reason === "string"
      ? ((parsed as Record<string, unknown>).reason as string).trim()
      : undefined;
  } else {
    return {
      variants: [],
      candidates: 0,
      rejected: 0,
      rejectionReasons: [],
      reason: "Planner response was not a valid response object or array.",
    };
  }
  const knownUrls = new Set(fixtures.map((fixture) => fixture.url));
  const variants: ResponseVariant[] = [];
  const rejectionReasons: string[] = [];
  let rejected = 0;
  const reject = (reason: string) => {
    rejected += 1;
    if (!rejectionReasons.includes(reason)) rejectionReasons.push(reason);
  };
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      reject("proposal was not an object");
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const sourceMethod = typeof value.sourceMethod === "string" ? value.sourceMethod.toUpperCase() : undefined;
    const sourceUrl = typeof value.sourceUrl === "string" ? value.sourceUrl : "";
    const rawSourceOccurrence = value.sourceOccurrence;
    if (rawSourceOccurrence !== undefined && (!Number.isSafeInteger(rawSourceOccurrence) || (rawSourceOccurrence as number) < 1)) {
      reject("sourceOccurrence was invalid");
      continue;
    }
    const sourceOccurrence = rawSourceOccurrence as number | undefined;
    if (!name || !knownUrls.has(sourceUrl) || !Array.isArray(value.patches) || value.patches.length === 0) {
      reject("name, exact sourceUrl, or patches were missing");
      continue;
    }
    if (sourceMethod && !fixtures.some((fixture) => fixture.url === sourceUrl && fixture.method === sourceMethod)) {
      reject("sourceMethod did not match the captured response");
      continue;
    }
    const sourceMatches = fixtures.filter((fixture) => fixture.url === sourceUrl && (!sourceMethod || fixture.method === sourceMethod));
    if (!sourceMethod && new Set(sourceMatches.map((fixture) => fixture.method)).size > 1) {
      reject("sourceMethod was required for an ambiguous URL");
      continue;
    }
    if (sourceOccurrence !== undefined && !sourceMatches.some((fixture) => fixture.occurrence === sourceOccurrence)) {
      reject("sourceOccurrence did not match the captured response");
      continue;
    }
    if (sourceOccurrence === undefined && sourceMatches.length > 1) {
      reject("sourceOccurrence was required for a repeated response");
      continue;
    }
    const rawExpectation = value.expectation;
    if (!rawExpectation || typeof rawExpectation !== "object") {
      reject("expectation was missing");
      continue;
    }
    const expectationValue = rawExpectation as Record<string, unknown>;
    const assertion = expectationValue.assertion;
    if (
      assertion !== "visible" &&
      assertion !== "hidden" &&
      assertion !== "containsText" &&
      assertion !== "urlContains" &&
      assertion !== "urlEquals"
    ) {
      reject("expectation assertion was invalid");
      continue;
    }
    const locator = typeof expectationValue.locator === "string" ? expectationValue.locator : undefined;
    const expectedValue = typeof expectationValue.value === "string" ? expectationValue.value : undefined;
    if ((assertion === "visible" || assertion === "hidden" || assertion === "containsText") && !locator) {
      reject("expectation locator was missing");
      continue;
    }
    if ((assertion === "containsText" || assertion === "urlContains" || assertion === "urlEquals") && expectedValue === undefined) {
      reject("expectation value was missing");
      continue;
    }
    const patches: ResponsePatch[] = [];
    for (const patch of value.patches) {
      if (!patch || typeof patch !== "object") continue;
      const item = patch as Record<string, unknown>;
      if (typeof item.path !== "string" || item.value === undefined || !parsePath(item.path)) continue;
      patches.push({ path: item.path, value: item.value });
    }
    if (patches.length === 0) {
      reject("no patch targeted an existing JSON path");
      continue;
    }
    const variant: ResponseVariant = {
      name,
      sourceMethod,
      sourceUrl,
      sourceOccurrence,
      patches,
      expectation: { assertion, locator, value: expectedValue },
      reason: typeof value.reason === "string" ? value.reason.trim() : undefined,
    };
    if (!applyResponseVariant(fixtures, variant)) {
      reject("patch did not apply to the captured response");
      continue;
    }
    variants.push(variant);
    if (maxVariants !== undefined && variants.length >= maxVariants) break;
  }
  return {
    variants,
    candidates: candidates.length,
    rejected,
    rejectionReasons,
    reason: candidates.length === 0
      ? plannerReason
        ? `Planner returned no variant proposals: ${plannerReason}`
        : "Planner returned no variant proposals."
      : variants.length === 0
        ? "All planner proposals were rejected by Appwalk validation."
        : undefined,
    plannerReason,
  };
}

export function parseResponseVariants(text: string, fixtures: ResponseFixture[], maxVariants?: number): ResponseVariant[] {
  return parseResponseVariantsDetailed(text, fixtures, maxVariants).variants;
}

export function responseVariantPrompt(
  flowName: string,
  fixtures: ResponseFixture[],
  maxVariants: number,
  finalSnapshot = "",
  replayTimeline: Array<{ url: string; snapshot: string }> = [],
): string {
  const timeline = replayTimeline.length
    ? replayTimeline.map((step, index) => `${index + 1}. URL: ${step.url}\n${step.snapshot.slice(0, 1200)}`).join("\n\n")
    : "(No replay timeline was available.)";
  return `You are designing a small set of deterministic UI scenarios from one verified browser flow.

Flow: ${flowName}
Observed same-origin JSON responses (method and exact URL matter):
${JSON.stringify(compactPromptFixtures(fixtures), null, 2)}

The bodyPreview values are structural previews, not replacement bodies. Patch paths must still refer to existing paths in the real captured response.
For an array preview, the sample marker is only an example: use the real path such as $.orders[0].status, never $.orders.sample[0].status.

Replay timeline (each snapshot is after one original browser action):
${timeline}

Observed final UI snapshot for the original flow:
${finalSnapshot}

Return ONLY a JSON object with a "variants" array containing at most ${maxVariants} useful variants and a "reason" string. Each item must have:
{"name":"short scenario name","sourceMethod":"POST","sourceUrl":"exact URL from the input","sourceOccurrence":1,"patches":[{"path":"$.existing.path","value": "new JSON value"}],"expectation":{"assertion":"containsText","locator":"role=heading[name=\"Pending\"]","value":"Pending"},"reason":"why this is a useful UI scenario"}

Rules:
- Patch only existing JSON object properties or existing array elements. Never add or remove fields.
- Keep the response valid and preserve its general shape.
- Prefer meaningful business states visible in the UI: alternate status, empty/non-empty collection, boundary quantity or total.
- Do not patch IDs, timestamps, tokens, credentials, URLs, or pagination cursors unless there is no other meaningful field.
- Do not invent a response URL. Use one of the exact URLs above.
- Always include the exact response method from the input as sourceMethod, because one URL can serve multiple methods.
- Always include sourceOccurrence from the input when the same method and URL appear more than once, so the patch targets the intended response in the captured sequence.
- Do not repeat the original response or produce cosmetic duplicates.
- Include one concrete expectation that should be observable after the selected source response is applied during the same flow, using only visible/hidden/containsText/urlContains/urlEquals. Do not guess a signal unrelated to the response.
- If no meaningful variant is possible, return {"variants":[],"reason":"briefly explain why no reliable observable scenario can be derived"}.`;
}

export async function installResponseFixtures(
  page: Page,
  fixtures: ResponseFixture[],
  options: ResponseFixtureInstallOptions = {},
): Promise<void> {
  type FixtureQueue = { items: ResponseFixture[]; next: number };
  const patternGroups = new Map<string, ResponseFixture[]>();
  for (const fixture of fixtures) {
    const pattern = fixture.urlPattern ?? responseFixtureUrlPattern(fixture.url);
    const group = patternGroups.get(pattern) ?? [];
    group.push(fixture);
    patternGroups.set(pattern, group);
  }

  for (const [pattern, group] of patternGroups) {
    const exactQueues = new Map<string, FixtureQueue>();
    const methodQueues = new Map<string, FixtureQueue>();
    for (const fixture of group) {
      const exactKey = `${fixture.method} ${fixture.url}`;
      const exactQueue = exactQueues.get(exactKey) ?? { items: [], next: 0 };
      exactQueue.items.push(fixture);
      exactQueues.set(exactKey, exactQueue);
      const methodKey = `${fixture.method} *`;
      const methodQueue = methodQueues.get(methodKey) ?? { items: [], next: 0 };
      methodQueue.items.push(fixture);
      methodQueues.set(methodKey, methodQueue);
    }

    await page.route(pattern, async (route) => {
      const method = route.request().method();
      const exactQueue = exactQueues.get(`${method} ${route.request().url()}`);
      const queue = exactQueue ?? methodQueues.get(`${method} *`);
      if (!queue || queue.items.length === 0) {
        await route.continue();
        return;
      }
      const fixture = queue.items[Math.min(queue.next, queue.items.length - 1)]!;
      queue.next += 1;
      await route.fulfill({
        status: fixture.status,
        contentType: "application/json",
        body: JSON.stringify(fixture.body),
      });
      options.onFixtureApplied?.(fixture, route.request().url());
    });
  }
}
