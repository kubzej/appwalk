import type { EvidenceEntry } from "../evidence/log.js";
import { assertValidBurstCount } from "../limits.js";
import { type ResponseFixture, type ResponseVariant } from "../response/variants.js";
import { escapeJsString, serializeJsValue, toLocatorExpression } from "./locator.js";
import { assertValidWebUrl } from "../url.js";
import { LOGIN_CONTRACT } from "../browser/login-contract.js";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { validateToolInput } from "../agent/validation.js";
import type { ExpectationObservation } from "../types.js";

export interface CodegenOptions {
  url: string;
  username?: string;
  password?: string;
  storageStatePath?: string;
  /** Set by writeGeneratedSuite when storage state has been copied beside the generated spec. */
  storageStateArtifactPath?: string;
}

export interface FlowEntries {
  /** Human-readable flow summary — codegen turns it into a stable test title. */
  name: string;
  /** Short stable title supplied by the agent, when available. */
  title?: string;
  entries: EvidenceEntry[];
  /** URL captured at the flow's starting point, when it differs from the global CLI URL. */
  startUrl?: string;
  /** JSON-serialized browser storage from the flow's starting point, when it differs from global setup. */
  startStorageState?: string;
  /** Observed JSON responses to replay deterministically before the flow starts. */
  responseFixtures?: ResponseFixture[];
  /** Stable identity of the baseline fixture set shared by this flow and its variants. */
  fixtureBaseId?: string;
  /** Original fixtures used to derive a variant. Present when a variant is generated standalone. */
  baseResponseFixtures?: ResponseFixture[];
  /** Validated response patch that produced this derived flow. */
  responseVariant?: ResponseVariant;
  origin?: "discovered" | "derived";
  /** Name of a Playwright `devices` entry the flow was discovered/replayed under (e.g. "iPhone 17").
   * A device profile is only settable at context creation, so a flow that needs one gets its own
   * explicit context in the generated test instead of the shared ambient `page` fixture — otherwise
   * the regression test would silently run on a plain desktop context. */
  devicePreset?: string;
}

export interface GeneratedSpecArtifact {
  relativePath: string;
  content: string;
}

export interface GeneratedSpecBundle {
  spec: string;
  artifacts: GeneratedSpecArtifact[];
}

/**
 * Flow summaries are useful in reports, but they often contain agent/persona labels and concrete
 * data from one run. Keep those details out of generated test titles while retaining the full
 * summary in the report and evidence.
 */
export function formatTestTitle(name: string): string {
  let title = name.replace(/\s+/g, " ").trim();

  // `run` and some models commonly prefix the summary with e.g. "mia baseline:".
  title = title.replace(/^[^:]{1,80}\b(?:baseline|persona)\s*:\s*/i, "");

  // IDs and other run-specific values make titles noisy and unstable.
  title = title
    .replace(/\b(?:order|transaction|request|session)\s*#\s*[a-z0-9-]+\b/gi, "")
    .replace(/\border(?: number)?\s+[0-9]+\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,;:.!?-]+$/, "")
    .trim();

  // Prefer an intentional high-level label when a summary uses `label: details` form.
  const label = title.match(/^([^:]{1,100}):/i)?.[1]?.trim();
  if (label && /(?:flow|journey|scenario)$/i.test(label) && !/^(?:flow|journey|scenario|test)$/i.test(label)) {
    title = label;
  }

  title = title
    .replace(/\s+(?:flow|journey|scenario|test)$/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:for|with|in|on)$/, "")
    .replace(/[\s,;:.!?-]+$/, "")
    .trim();

  if (!title) return "Verified user flow";
  if (title.length <= 100) return title;

  const shortened = title.slice(0, 100).replace(/\s+\S*$/, "").trim();
  return shortened || "Verified user flow";
}

// Generated login stays standalone for the user's test project. Its selectors and route rules
// come from LOGIN_CONTRACT, so the runtime and generated helper share the same login assumptions.
// English label text only works on English-language UIs; HTML input types are language-independent,
// so structural signals are tried first, with English text as a fallback.
export const GENERATED_CREDENTIALS_FILE = ".secrets.json";
export const GENERATED_STORAGE_STATE_FILE = ".storage-state.json";

const GENERATED_AUTH_HELPER = `import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Credentials = { username: string; password: string };

function readLocalCredentials(): Credentials | null {
  const credentialsPath = join(dirname(fileURLToPath(import.meta.url)), '${GENERATED_CREDENTIALS_FILE}');
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Partial<Credentials>;
    if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
      throw new Error('must contain string username and password fields');
    }
    return { username: parsed.username, password: parsed.password };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error('Unable to read ${GENERATED_CREDENTIALS_FILE}: ' + detail);
  }
}

function readCredentials(): Credentials {
  const localCredentials = readLocalCredentials();
  if (localCredentials) return localCredentials;

  const username = process.env.APPWALK_USERNAME;
  const password = process.env.APPWALK_PASSWORD;
  if (username && password) return { username, password };
  throw new Error('Credentials not found. Keep ${GENERATED_CREDENTIALS_FILE} next to auth.ts or set APPWALK_USERNAME and APPWALK_PASSWORD.');
}

async function findLoginField(root: Page | Locator, ...patterns: RegExp[]): Promise<Locator | null> {
  for (const pattern of patterns) {
    const byLabel = root.getByLabel(pattern);
    if ((await byLabel.count()) > 0) return byLabel.first();
  }
  for (const pattern of patterns) {
    const byRole = root.getByRole('textbox', { name: pattern });
    if ((await byRole.count()) > 0) return byRole.first();
  }
  return null;
}

export async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  let passwordField = page.locator('${LOGIN_CONTRACT.passwordSelector}').first();
  if ((await passwordField.count()) === 0) {
    const loginTrigger = page.getByRole('button', { name: /${LOGIN_CONTRACT.triggerPattern}/i })
      .or(page.getByRole('link', { name: /${LOGIN_CONTRACT.triggerPattern}/i })).first();
    if ((await loginTrigger.count()) > 0) {
      await loginTrigger.click();
      await passwordField.waitFor({ state: 'visible' });
    }
  }
  const loginPageUrl = page.url();
  if ((await passwordField.count()) === 0) {
    const byLabel = await findLoginField(page, /password/i);
    if (!byLabel) throw new Error('Login form not found. Use --storage-state if the site uses SSO, 2FA, or has no password login.');
    passwordField = byLabel;
  }

  const form = page.locator('${LOGIN_CONTRACT.formSelector}').first();
  const loginScope = (await form.count()) > 0
    ? form
    : passwordField.locator("xpath=ancestor::*[.//button or .//input[@type='submit']][1]");

  let usernameField = loginScope.locator('${LOGIN_CONTRACT.usernameSelector}').first();
  if ((await usernameField.count()) === 0) {
    const byLabel = await findLoginField(loginScope, /username/i, /e-?mail/i);
    if (byLabel) {
      usernameField = byLabel;
    } else {
      usernameField = loginScope.locator('${LOGIN_CONTRACT.usernameFallbackSelector}').first();
    }
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  const loginPattern = /${LOGIN_CONTRACT.triggerPattern}/i;
  const localLoginButtons = loginScope.getByRole('button', { name: loginPattern });
  if ((await localLoginButtons.count()) > 0) {
    await localLoginButtons.last().click();
  } else {
    const formSubmit = loginScope.locator('${LOGIN_CONTRACT.submitSelector}').first();
    if ((await formSubmit.count()) > 0) {
      await formSubmit.click();
    } else {
      const pageLoginButtons = page.getByRole('button', { name: loginPattern });
      if ((await pageLoginButtons.count()) === 0) {
        throw new Error('Login submit control not found. Use --storage-state if the site uses a custom login flow.');
      }
      await pageLoginButtons.last().click();
    }
  }

  await Promise.race([
    page.waitForURL((nextUrl: URL) => nextUrl.toString() !== loginPageUrl, { timeout: 10000 }),
    passwordField.waitFor({ state: 'hidden', timeout: 10000 }),
  ]).catch(() => undefined);

  let stillOnPasswordField = await page
    .locator('${LOGIN_CONTRACT.passwordSelector}')
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnPasswordField && page.url() !== loginPageUrl) {
    await page.locator('${LOGIN_CONTRACT.passwordSelector}').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
    stillOnPasswordField = await page
      .locator('${LOGIN_CONTRACT.passwordSelector}')
      .first()
      .isVisible()
      .catch(() => false);
  }
  const finalPath = new URL(page.url()).pathname.toLowerCase();
  const remainsOnLoginRoute = /${LOGIN_CONTRACT.loginRoutePattern}/.test(finalPath);
  if (stillOnPasswordField || page.url() === loginPageUrl || remainsOnLoginRoute) {
    const message = stillOnPasswordField
      ? 'Login did not complete. Check credentials or use --storage-state for 2FA, SSO, or CAPTCHA.'
      : 'Login outcome could not be verified. Use --storage-state if the app keeps the login route after authentication.';
    throw new Error(message);
  }
}

export async function loginWithConfiguredCredentials(page: Page): Promise<void> {
  const { username, password } = readCredentials();
  await loginWithCredentials(page, username, password);
}`;

const GENERATED_FIXTURES_HELPER = `import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';

type ResponseFixture = {
  method: string;
  url: string;
  occurrence?: number;
  urlPattern?: string;
  status: number;
  body: unknown;
};

type ResponsePatch = { path: string; value: unknown };
type VariantScenario = {
  base: string;
  sourceMethod?: string;
  sourceUrl: string;
  sourceOccurrence?: number;
  patches: ResponsePatch[];
};
type FixtureQueue = { items: ResponseFixture[]; next: number };

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parsePath(path: string): Array<string | number> | null {
  if (path === '$' || !path.startsWith('$')) return null;
  const tokens: Array<string | number> = [];
  let offset = 1;
  while (offset < path.length) {
    if (path[offset] === '.') {
      const match = /^\\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(path.slice(offset));
      if (!match) return null;
      tokens.push(match[1]!);
      offset += match[0].length;
      continue;
    }
    if (path[offset] === '[') {
      const match = /^\\[(\\d+)\\]/.exec(path.slice(offset));
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
    if (current === null || typeof current !== 'object' || !(token in current)) return false;
    current = (current as Record<string | number, unknown>)[token];
  }
  const last = tokens[tokens.length - 1]!;
  if (current === null || typeof current !== 'object' || !(last in current)) return false;
  (current as Record<string | number, unknown>)[last] = clone(value);
  return true;
}

export function loadScenario(name: string): ResponseFixture[] {
  const source = readJson<ResponseFixture[] | VariantScenario>(join(fixtureDirectory, name + '.json'));
  if (Array.isArray(source)) return source;
  const fixtures = readJson<ResponseFixture[]>(join(fixtureDirectory, source.base)).map((fixture) => ({ ...fixture, body: clone(fixture.body) }));
  const matches = fixtures.filter((fixture) => fixture.url === source.sourceUrl && (!source.sourceMethod || fixture.method === source.sourceMethod));
  const target = source.sourceOccurrence === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : matches.find((fixture) => fixture.occurrence === source.sourceOccurrence);
  if (!target) throw new Error('Response variant could not locate its captured source response.');
  for (const patch of source.patches) {
    if (!setExistingJsonPath(target.body, patch.path, patch.value)) {
      throw new Error('Response variant patch could not be applied: ' + patch.path);
    }
  }
  return fixtures;
}

export async function installFixtures(context: BrowserContext, fixtures: ResponseFixture[]): Promise<void> {
  const patternGroups = new Map<string, ResponseFixture[]>();
  for (const fixture of fixtures) {
    const pattern = fixture.urlPattern ?? fixture.url;
    const group = patternGroups.get(pattern) ?? [];
    group.push(fixture);
    patternGroups.set(pattern, group);
  }
  for (const [pattern, group] of patternGroups) {
    const exactQueues = new Map<string, FixtureQueue>();
    for (const fixture of group) {
      const exactKey = fixture.method + ' ' + fixture.url;
      const exactQueue = exactQueues.get(exactKey) ?? { items: [], next: 0 };
      exactQueue.items.push(fixture);
      exactQueues.set(exactKey, exactQueue);
    }
    await context.route(pattern, async (route) => {
      const method = route.request().method();
      const queue = exactQueues.get(method + ' ' + route.request().url());
      if (!queue || queue.items.length === 0) {
        await route.continue();
        return;
      }
      const fixture = queue.items[Math.min(queue.next++, queue.items.length - 1)]!;
      await route.fulfill({ status: fixture.status, contentType: 'application/json', body: JSON.stringify(fixture.body) });
    });
  }
}
`;

function actionToStatement(
  name: string,
  input: Record<string, unknown>,
  fixtureScenario?: string,
  trackPopups = false,
): string | null {
  const locatorExpr = () => toLocatorExpression(input.locator as string);
  const sourceLocatorExpr = () => toLocatorExpression(input.source as string);
  const targetLocatorExpr = () => toLocatorExpression(input.target as string);
  const clickOptionsStatement = (): string => {
    const options: string[] = [];
    if (input.button === "left" || input.button === "right" || input.button === "middle") {
      options.push(`button: '${input.button}'`);
    }
    if (Array.isArray(input.modifiers)) {
      const modifiers = input.modifiers.filter((modifier): modifier is string =>
        typeof modifier === "string" && ["Alt", "Control", "Meta", "Shift"].includes(modifier),
      );
      if (modifiers.length > 0) options.push(`modifiers: ${JSON.stringify(modifiers)}`);
    }
    return options.length > 0 ? `{ ${options.join(", ")} }` : "";
  };

  switch (name) {
    case "navigate":
      assertValidWebUrl(input.url, "Generated navigate URL");
      return `await page.goto('${escapeJsString(input.url as string)}');`;
    case "click":
      return `await ${locatorExpr()}.click(${clickOptionsStatement()});`;
    case "doubleClick":
      return `await ${locatorExpr()}.dblclick(${clickOptionsStatement()});`;
    case "fill":
      return `await ${locatorExpr()}.fill('${escapeJsString(input.value as string)}');`;
    case "select":
      return `await ${locatorExpr()}.selectOption(${Array.isArray(input.value)
        ? `[${input.value.map((value) => `'${escapeJsString(String(value))}'`).join(", ")}]`
        : `'${escapeJsString(input.value as string)}'`});`;
    case "pressKey":
      return `await ${locatorExpr()}.press('${escapeJsString(input.key as string)}');`;
    case "check":
      return `await ${locatorExpr()}.check();`;
    case "uncheck":
      return `await ${locatorExpr()}.uncheck();`;
    case "hover":
      return `await ${locatorExpr()}.hover();`;
    case "dragAndDrop":
      return `await ${sourceLocatorExpr()}.dragTo(${targetLocatorExpr()});`;
    case "goBack":
      return `await page.goBack();`;
    case "goForward":
      return `await page.goForward();`;
    case "reload":
      return `await page.reload();`;
    case "clearCookie":
      return input.name
        ? `await page.context().clearCookies({ name: '${escapeJsString(input.name as string)}' });`
        : `await page.context().clearCookies();`;
    // `page` is reassigned in place — it's a normal (destructured) function parameter in the generated
    // test, not a const, so every later statement in the test picks up the new active page for free.
    // Goes through a fresh `browser.newContext()` seeded from the current storageState rather than
    // `page.context().newPage()` — Playwright rejects a second page on the implicit context every page
    // in this codebase is created with ("Please use browser.newContext()").
    case "openInNewTab":
      return `{ const url = page.url(); const storageState = await page.context().storageState({ indexedDB: true }); const newContext = await browser.newContext({ storageState }); ${fixtureScenario ? `await installFixtures(newContext, loadScenario('${escapeJsString(fixtureScenario)}'));` : ''} page = await newContext.newPage(); await page.goto(url);${trackPopups ? " registerPopupPage(page);" : ""} }`;
    // A genuine second page of the *same* context — real, live-shared cookies/localStorage, like two
    // real browser tabs — rather than a storageState clone into a fresh context. `tabs` maps every tab
    // id ever opened to its page, mirroring the runtime tab registry: the id formula
    // (`tab-${count so far}`) must match it exactly, since a later switchTab statement was recorded
    // against the id the runtime assigned.
    case "openTab":
      return `{ const url = page.url(); const newPage = await page.context().newPage(); await newPage.goto(url); tabs[\`tab-\${Object.keys(tabs).length}\`] = page = newPage;${trackPopups ? " registerPopupPage(newPage);" : ""} }`;
    case "switchTab":
      return `page = tabs['${escapeJsString(input.tabId as string)}'];`;
    // Closes just the context, not the shared `browser` fixture the test runner owns — closing that
    // would break the runner, not just this one test's simulated "browser restart".
    case "reopenBrowser":
      return `{ const url = page.url(); const storageState = await page.context().storageState({ indexedDB: true }); await page.context().close(); const newContext = await browser.newContext({ storageState }); ${fixtureScenario ? `await installFixtures(newContext, loadScenario('${escapeJsString(fixtureScenario)}'));` : ''} page = await newContext.newPage(); await page.goto(url);${trackPopups ? " registerPopupPage(page);" : ""} }`;
    case "scroll":
      return input.locator ? `await ${locatorExpr()}.scrollIntoViewIfNeeded();` : `await page.mouse.wheel(0, 10000);`;
    case "setViewportSize":
      return `await page.setViewportSize({ width: ${codegenViewportDimension(input.width, "width")}, height: ${codegenViewportDimension(input.height, "height")} });`;
    case "waitFor":
      return `await ${locatorExpr()}.first().waitFor({ state: 'visible' });`;
    case "uploadFile":
      return `await ${locatorExpr()}.setInputFiles(${serializeJsValue(input.filePaths)});`;
    case "download":
      // A real, non-empty saved file, not just the event having fired — the same distinction the
      // live download() action checks (suggestedFilename() alone can't tell a real file from a
      // broken/empty one).
      return `{ const downloadPromise = page.waitForEvent('download'); await ${locatorExpr()}.click(); const download = await downloadPromise; expect(await download.failure()).toBeNull(); const downloadPath = await download.path(); expect(downloadPath).toBeTruthy(); if (downloadPath) { const downloadStats = await stat(downloadPath); expect(downloadStats.size).toBeGreaterThan(0); } }`;
    case "handleDialog":
      if (input.behavior !== "accept" && input.behavior !== "dismiss") {
        throw new Error("Cannot generate handleDialog: behavior must be accept or dismiss.");
      }
      return `page.once('dialog', (dialog) => dialog.${input.behavior}());`;
    case "burst": {
      // Short on purpose, matching the real `burst()` — a repetition whose target is already gone
      // (an earlier one navigated away) should fail fast, not wait out Playwright's much longer default.
      const count = input.count;
      const innerAction = input.action as string;
      const innerStatement =
        innerAction === "click"
          ? `await ${locatorExpr()}.click({ timeout: 1000 });`
          : innerAction === "pressKey"
            ? `await ${locatorExpr()}.press('${escapeJsString(input.key as string)}', { timeout: 1000 });`
            : innerAction === "check"
              ? `await ${locatorExpr()}.check({ timeout: 1000 });`
              : innerAction === "uncheck"
                ? `await ${locatorExpr()}.uncheck({ timeout: 1000 });`
                : null;
      if (innerStatement === null) return null;
      // A repetition failing to find its target (typically because an earlier one already navigated
      // away) is the expected, informative case for a burst-tested flow, not a broken test — stopping
      // early here instead of letting the exception fail the whole test mirrors the real `burst()`.
      return `for (let i = 0; i < ${count}; i++) { try { ${innerStatement} } catch { break; } }`;
    }
    case "simulateFailure": {
      const pattern = escapeJsString(input.urlPattern as string);
      const mode = input.mode as string;
      const modeCode =
        mode === "500" || mode === "503" || mode === "404"
          ? `await route.fulfill({ status: ${mode}, contentType: 'application/json', body: '{"error":"simulated failure"}' });`
          : mode === "malformed"
            ? `await route.fulfill({ status: 200, contentType: 'application/json', body: '{not valid json' });`
            : mode === "offline"
              ? `await route.abort('internetdisconnected');`
              : mode === "connectionReset"
                ? `await route.abort('connectionreset');`
                : mode === "timeout"
                  ? `await route.fetch(); await route.abort('timedout');`
                  : null;
      if (modeCode === null) return null;
      // Unroute after the route settles, not before — unrouting mid-flight makes Playwright treat the
      // route as already handled and throw on the fulfill/abort call meant to actually settle it.
      return `await page.route('${pattern}', async (route) => { ${modeCode} await page.unroute('${pattern}'); });`;
    }
    case "simulateLatency": {
      const pattern = escapeJsString(input.urlPattern as string);
      const delayMs = Number(input.delayMs);
      if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) return null;
      return `await page.route('` + pattern + `', async (route) => { await new Promise((resolve) => setTimeout(resolve, ${delayMs})); await route.continue(); await page.unroute('` + pattern + `'); });`;
    }
    case "setOffline":
      return `await page.context().setOffline(${input.offline ? "true" : "false"});`;
    case "apiRequest": {
      const method = escapeJsString((input.method as string) ?? "GET");
      const requestUrl = escapeJsString(input.url as string);
      const headers = input.headers && typeof input.headers === "object" ? serializeJsValue(input.headers) : undefined;
      return `await page.request.fetch('${requestUrl}', { method: '${method}'${headers ? `, headers: ${headers}` : ""} });`;
    }
    case "verifyExpectation":
      return null;
    default:
      return null;
  }
}

function expectationToStatement(entry: EvidenceEntry): string | null {
  const observation = validateCodegenExpectation(entry.result?.expectation);
  if (!observation) return null;
  const locator = observation.locator ? toLocatorExpression(observation.locator) : null;
  switch (observation.assertion) {
    case "visible":
      return locator ? `await expect(${locator}).toBeVisible();` : null;
    case "hidden":
      return locator ? `await expect(${locator}).not.toBeVisible();` : null;
    case "containsText":
      return locator && observation.value !== undefined
        ? `await expect(${locator}).toContainText('${escapeJsString(observation.value)}');`
        : null;
    case "urlContains":
      return observation.value !== undefined
        ? `await expect(page).toHaveURL(new RegExp('${escapeJsString(observation.value)}'));`
        : null;
    case "urlEquals":
      return observation.value !== undefined
        ? `await expect(page).toHaveURL('${escapeJsString(observation.value)}');`
        : null;
    case "value":
      return locator && observation.value !== undefined
        ? `await expect(${locator}).toHaveValue('${escapeJsString(observation.value)}');`
        : null;
    case "checked":
      return locator ? `await expect(${locator}).toBeChecked();` : null;
    case "unchecked":
      return locator ? `await expect(${locator}).not.toBeChecked();` : null;
    case "disabled":
      return locator ? `await expect(${locator}).toBeDisabled();` : null;
    case "enabled":
      return locator ? `await expect(${locator}).toBeEnabled();` : null;
    case "count":
      return locator && observation.expectedCount !== undefined
        ? `await expect(${locator}).toHaveCount(${observation.expectedCount});`
        : null;
    default:
      return null;
  }
}

function validateCodegenExpectation(value: unknown): ExpectationObservation | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cannot generate expectation: expected an object.");
  }

  const observation = value as Record<string, unknown>;
  if (observation.status !== "met") return null;

  const assertions = new Set([
    "visible", "hidden", "containsText", "urlContains", "urlEquals", "value",
    "checked", "unchecked", "disabled", "enabled", "count", "unknown",
  ]);
  if (typeof observation.assertion !== "string" || !assertions.has(observation.assertion)) {
    throw new Error("Cannot generate expectation: assertion is invalid.");
  }
  if (observation.locator !== undefined && typeof observation.locator !== "string") {
    throw new Error("Cannot generate expectation: locator must be a string.");
  }
  if (observation.value !== undefined && typeof observation.value !== "string") {
    throw new Error("Cannot generate expectation: value must be a string.");
  }
  if (
    observation.expectedCount !== undefined
    && (typeof observation.expectedCount !== "number"
      || !Number.isSafeInteger(observation.expectedCount)
      || observation.expectedCount < 0)
  ) {
    throw new Error("Cannot generate expectation: expectedCount must be a non-negative safe integer.");
  }
  return observation as unknown as ExpectationObservation;
}

function codegenViewportDimension(value: unknown, name: string): number {
  const dimension = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(`Invalid viewport ${name}: expected a positive integer.`);
  }
  return dimension;
}

/** Picks the flow's confirmation assertion from the last successful step — prefers a heading (usually the clearest "this is done" signal), falls back to the final URL. */
function findConfirmationAssertion(entries: EvidenceEntry[]): string | null {
  const lastWithResult = [...entries].reverse().find((e) => e.result);
  if (!lastWithResult?.result) return null;

  // A heading with nested children renders wrapped in a quote ("- 'heading "..." [level=N]':") instead
  // of the plain form — the quote must stay optional or such headings never match.
  const headingMatch = lastWithResult.result.snapshot.match(/-\s*'?heading "([^"]+)"/);
  if (headingMatch) {
    // A literal single quote inside the heading text gets YAML-doubled to avoid ending the outer
    // single-quoted wrapper early — undo it, or the assertion targets text the page never renders.
    const headingText = headingMatch[1]!.replace(/''/g, "'");
    return `await expect(page.getByRole('heading', { name: '${escapeJsString(headingText)}' })).toBeVisible();`;
  }
  return `await expect(page).toHaveURL('${escapeJsString(lastWithResult.result.url)}');`;
}

function flowToTest(
  flow: FlowEntries,
  options: CodegenOptions,
  testTitle = formatTestTitle(flow.title ?? flow.name),
  fixtureScenario?: string,
): string {
  const toolCalls = flow.entries.filter((entry) => entry.toolCall && !entry.error && entry.toolCall.name !== "flowComplete");
  // The runtime registers app-opened popups as tab-1, tab-2, ... so a later switchTab can reach
  // them. Generated tests need the same registry whenever a flow switches tabs.
  const needsTabRegistry = toolCalls.some(
    (entry) => entry.toolCall!.name === "openTab" || entry.toolCall!.name === "switchTab",
  );
  const tabRegistrySetup = needsTabRegistry ? [
    "const tabs: Record<string, typeof page> = { 'tab-0': page };",
    "const popupPages = new WeakSet<typeof page>();",
    "function registerPopupPage(sourcePage: typeof page): void {",
    "  if (popupPages.has(sourcePage)) return;",
    "  popupPages.add(sourcePage);",
    "  sourcePage.on('popup', (popup) => {",
    "    const newId = 'tab-' + Object.keys(tabs).length;",
    "    tabs[newId] = popup;",
    "    registerPopupPage(popup);",
    "  });",
    "}",
    "registerPopupPage(page);",
  ] : [];
  // Preserve the original timeline: an expectation may describe an intermediate state (e.g. an
  // item is present in the cart) and must run before later actions navigate away from that state.
  const bodyLines = toolCalls
    .flatMap((entry) => [
      actionToStatement(entry.toolCall!.name, validateCodegenToolInput(entry.toolCall!.name, entry.toolCall!.input), fixtureScenario, needsTabRegistry),
      expectationToStatement(entry),
    ])
    .filter((line): line is string => line !== null);

  const assertion = findConfirmationAssertion(flow.entries);
  // A recorded final expectation can already express the flow completion signal. Avoid emitting
  // the same assertion again as a generic confirmation fallback.
  const finalAssertion = assertion && bodyLines.includes(assertion) ? null : assertion;
  const body = [...bodyLines, finalAssertion].filter((line): line is string => line !== null).map((line) => `  ${line}`).join("\n");

  // `openInNewTab`/`reopenBrowser` need the `browser` fixture to open a fresh context from; `openTab`
  // only needs `page.context()`, since it stays in the same context. Every other action only ever
  // needs `page` (reassigned in place when one of those switches it).
  const needsBrowserFixture = toolCalls.some(
    (entry) => entry.toolCall!.name === "openInNewTab" || entry.toolCall!.name === "reopenBrowser",
  );
  // A device profile is a newContext()-time-only option (viewport alone can change mid-session,
  // but user agent/touch/scale factor cannot) — a flow discovered under one needs its own explicit
  // context too, exactly like storageState, even when it has no storageState of its own.
  const needsOwnContext = Boolean(flow.devicePreset);
  const fixtureParams = needsOwnContext || needsBrowserFixture ? (needsOwnContext ? "{ browser }" : "{ page, browser }") : "{ page }";
  const setupNavigationLines = options.username && options.password
    ? [
      `await page.goto('${escapeJsString(options.url)}');`,
      "await loginWithConfiguredCredentials(page);",
      ...(flow.startUrl && flow.startUrl !== options.url ? [`await page.goto('${escapeJsString(flow.startUrl)}');`] : []),
    ]
    : [`await page.goto('${escapeJsString(flow.startUrl ?? options.url)}');`];
  if (needsOwnContext) {
    const contextOptionEntries = [
      ...(flow.devicePreset ? [`...devices['${escapeJsString(flow.devicePreset)}']`] : []),
      ...(options.storageStatePath
        ? [options.storageStateArtifactPath
          ? `storageState: join(generatedSuiteDirectory, '${escapeJsString(options.storageStateArtifactPath)}')`
          : `storageState: '${escapeJsString(options.storageStatePath)}'`]
        : []),
    ];
    const contextOptions = contextOptionEntries.length ? `{ ${contextOptionEntries.join(", ")} }` : "";
    const indentedBody = body
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    const setupLines = [
      ...tabRegistrySetup,
      ...(fixtureScenario ? [`await installFixtures(page.context(), loadScenario('${escapeJsString(fixtureScenario)}'));`] : []),
      ...setupNavigationLines,
    ].map((line) => `  ${line}`).join("\n");
  return `test('${escapeJsString(testTitle)}', async (${fixtureParams}) => {
  const flowContext = await browser.newContext(${contextOptions});
  let page = await flowContext.newPage();
${setupLines}
  try {
${indentedBody}
  } finally {
    await flowContext.close();
  }
});`;
  }

  const setup = [
    ...tabRegistrySetup,
    ...(fixtureScenario ? [
      `const responseFixtures = loadScenario('${escapeJsString(fixtureScenario)}');`,
      "await installFixtures(page.context(), responseFixtures);",
    ] : []),
    ...setupNavigationLines,
  ].map((line) => `  ${line}`).join("\n");
  return `test('${escapeJsString(testTitle)}', async (${fixtureParams}) => {\n${setup}\n${body}\n});`;
}

function validateCodegenToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Cannot generate ${name}: unknown tool.`);
  if (name === "burst") assertValidBurstCount(input.count, "Cannot generate burst");
  try {
    return validateToolInput(definition, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot generate ${name}: ${detail}`);
  }
}

function fixtureFileContent(fixtures: ResponseFixture[]): string {
  return JSON.stringify(fixtures, null, 2) + "\n";
}

function variantFileContent(
  baselineFile: string,
  variant: ResponseVariant,
): string {
  return JSON.stringify({
    base: baselineFile,
    sourceMethod: variant.sourceMethod,
    sourceUrl: variant.sourceUrl,
    sourceOccurrence: variant.sourceOccurrence,
    patches: variant.patches,
  }, null, 2) + "\n";
}

interface FixtureScenarioPlan {
  scenarioNames: string[];
  artifacts: GeneratedSpecArtifact[];
}

function planFixtureScenarios(flows: FlowEntries[]): FixtureScenarioPlan {
  const scenarioNames = new Array<string>(flows.length);
  const artifacts: GeneratedSpecArtifact[] = [];
  const baseFiles = new Map<string, string>();
  const baseScenarioNames = new Map<string, string>();
  const variantCounts = new Map<string, number>();

  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index]!;
    const hasFixtures = (flow.responseFixtures?.length ?? 0) > 0;
    const hasBaseFixtures = (flow.baseResponseFixtures?.length ?? 0) > 0;
    if (!hasFixtures && !hasBaseFixtures) continue;

    const baseKey = flow.fixtureBaseId ?? `flow-${index + 1}`;
    let baseScenario = baseScenarioNames.get(baseKey);
    if (!baseScenario) {
      const baseNumber = baseScenarioNames.size + 1;
      baseScenario = `flow-${String(baseNumber).padStart(3, "0")}.base`;
      baseScenarioNames.set(baseKey, baseScenario);
      const baseFixtures = flow.baseResponseFixtures ?? flow.responseFixtures ?? [];
      const baseFile = `${baseScenario}.json`;
      baseFiles.set(baseKey, baseFile);
      artifacts.push({ relativePath: `fixtures/${baseFile}`, content: fixtureFileContent(baseFixtures) });
    }

    if (flow.origin === "derived" && flow.responseVariant) {
      const variantNumber = (variantCounts.get(baseKey) ?? 0) + 1;
      variantCounts.set(baseKey, variantNumber);
      const scenario = `${baseScenario.replace(/\.base$/, "")}-variant-${String(variantNumber).padStart(3, "0")}`;
      const baseFile = baseFiles.get(baseKey)!;
      artifacts.push({
        relativePath: `fixtures/${scenario}.json`,
        content: variantFileContent(baseFile, flow.responseVariant),
      });
      scenarioNames[index] = scenario;
    } else {
      scenarioNames[index] = baseScenario;
    }
  }

  return { scenarioNames, artifacts };
}

/** One session can discover several distinct flows — each becomes its own independent `test()` with its own setup and response fixtures. */
export function generateSpecBundle(flows: FlowEntries[], options: CodegenOptions): GeneratedSpecBundle {
  assertValidWebUrl(options.url, "Codegen target URL");
  for (const [index, flow] of flows.entries()) {
    if (flow.startUrl !== undefined) assertValidWebUrl(flow.startUrl, `Codegen flow ${index + 1} start URL`);
  }
  const fixturePlan = planFixtureScenarios(flows);
  const hasStorageState = Boolean(options.storageStatePath);
  const hasLogin = !hasStorageState && Boolean(options.username && options.password);
  const hasFixtures = fixturePlan.artifacts.length > 0;
  const hasDeviceProfile = flows.some((flow) => Boolean(flow.devicePreset));
  const hasDownload = flows.some((flow) => flow.entries.some((entry) => entry.toolCall?.name === "download"));

  const parts: string[] = [
    hasDeviceProfile
      ? "import { test, expect, devices } from '@playwright/test';"
      : "import { test, expect } from '@playwright/test';",
  ];
  if (hasLogin) parts.push("import { loginWithConfiguredCredentials } from './auth.js';");
  if (hasFixtures) parts.push("import { installFixtures, loadScenario } from './fixtures.js';");
  if (hasDownload) parts.push("import { stat } from 'node:fs/promises';");

  if (hasStorageState) {
    if (options.storageStateArtifactPath) {
      parts.push("import { dirname, join } from 'node:path';");
      parts.push("import { fileURLToPath } from 'node:url';");
      parts.push("const generatedSuiteDirectory = dirname(fileURLToPath(import.meta.url));");
      parts.push(`test.use({ storageState: join(generatedSuiteDirectory, '${escapeJsString(options.storageStateArtifactPath)}') });`);
    } else {
      parts.push(`test.use({ storageState: '${escapeJsString(options.storageStatePath!)}' });`);
    }
  }
  const baseTitleCounts = new Map<string, number>();
  for (const flow of flows) {
    const baseTitle = formatTestTitle(flow.title ?? flow.name);
    baseTitleCounts.set(baseTitle, (baseTitleCounts.get(baseTitle) ?? 0) + 1);
  }

  const usedTitles = new Set<string>();
  for (const [index, flow] of flows.entries()) {
    const baseTitle = formatTestTitle(flow.title ?? flow.name);
    const detailTitle = formatTestTitle(flow.name);
    let testTitle = baseTitleCounts.get(baseTitle) === 1 || detailTitle === baseTitle
      ? baseTitle
      : `${baseTitle} - ${detailTitle}`;
    const titleRoot = testTitle;
    let suffix = 2;
    while (usedTitles.has(testTitle)) {
      testTitle = `${titleRoot} (${suffix++})`;
    }
    usedTitles.add(testTitle);
    parts.push(flowToTest(flow, options, testTitle, fixturePlan.scenarioNames[index]));
  }

  return {
    spec: parts.join("\n\n") + "\n",
    artifacts: [
      ...(hasLogin ? [
        { relativePath: "auth.ts", content: GENERATED_AUTH_HELPER },
        { relativePath: GENERATED_CREDENTIALS_FILE, content: JSON.stringify({ username: options.username, password: options.password }, null, 2) + "\n" },
      ] : []),
      ...(hasFixtures ? [{ relativePath: "fixtures.ts", content: GENERATED_FIXTURES_HELPER }, ...fixturePlan.artifacts] : []),
    ],
  };
}

export function generateSpec(flows: FlowEntries[], options: CodegenOptions): string {
  return generateSpecBundle(flows, options).spec;
}
