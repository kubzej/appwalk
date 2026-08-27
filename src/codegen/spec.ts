import type { EvidenceEntry } from "../evidence/log.js";
import { type ResponseFixture, type ResponseVariant } from "../response/variants.js";
import { escapeJsString, toLocatorExpression } from "./locator.js";

export interface CodegenOptions {
  url: string;
  username?: string;
  password?: string;
  storageStatePath?: string;
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

// Mirrors src/browser/login.ts exactly — keep the two in sync. English label text only works
// on English-language UIs; HTML input types (type="password", type="email", type="submit") are
// language-independent, so structural signals are tried first, English text as a fallback.
const GENERATED_AUTH_HELPER = `import type { Locator, Page } from '@playwright/test';

async function findLoginField(page: Page, ...patterns: RegExp[]): Promise<Locator | null> {
  for (const pattern of patterns) {
    const byLabel = page.getByLabel(pattern);
    if ((await byLabel.count()) > 0) return byLabel.first();
  }
  for (const pattern of patterns) {
    const byRole = page.getByRole('textbox', { name: pattern });
    if ((await byRole.count()) > 0) return byRole.first();
  }
  return null;
}

export async function loginWithCredentials(page: Page, username: string, password: string): Promise<void> {
  let passwordField = page.locator('input[type="password"]').first();
  const loginUrl = page.url();
  if ((await passwordField.count()) === 0) {
    const loginTrigger = page.getByRole('button', { name: /log ?in|sign ?in/i })
      .or(page.getByRole('link', { name: /log ?in|sign ?in/i })).first();
    if ((await loginTrigger.count()) > 0) {
      await loginTrigger.click();
      await passwordField.waitFor({ state: 'visible' });
    }
  }
  if ((await passwordField.count()) === 0) {
    const byLabel = await findLoginField(page, /password/i);
    if (!byLabel) throw new Error('No password field found');
    passwordField = byLabel;
  }

  let usernameField = page.locator('input[type="email"]').first();
  if ((await usernameField.count()) === 0) {
    const byLabel = await findLoginField(page, /username/i, /e-?mail/i);
    if (byLabel) {
      usernameField = byLabel;
    } else {
      const form = page.locator('form:has(input[type="password"])').first();
      usernameField = form.locator('input[type="text"], input:not([type])').first();
    }
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  const form = page.locator('form:has(input[type="password"])').first();
  const formSubmit = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await formSubmit.count()) > 0) {
    await formSubmit.click();
  } else {
    await page.getByRole('button', { name: /log ?in|sign ?in/i }).click();
  }

  await Promise.race([
    page.waitForURL((nextUrl: URL) => nextUrl.toString() !== loginUrl, { timeout: 10000 }),
    passwordField.waitFor({ state: 'hidden', timeout: 10000 }),
  ]).catch(() => undefined);
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
    const methodQueues = new Map<string, FixtureQueue>();
    for (const fixture of group) {
      const exactKey = fixture.method + ' ' + fixture.url;
      const exactQueue = exactQueues.get(exactKey) ?? { items: [], next: 0 };
      exactQueue.items.push(fixture);
      exactQueues.set(exactKey, exactQueue);
      const methodKey = fixture.method + ' *';
      const methodQueue = methodQueues.get(methodKey) ?? { items: [], next: 0 };
      methodQueue.items.push(fixture);
      methodQueues.set(methodKey, methodQueue);
    }
    await context.route(pattern, async (route) => {
      const method = route.request().method();
      const queue = exactQueues.get(method + ' ' + route.request().url()) ?? methodQueues.get(method + ' *');
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

function actionToStatement(name: string, input: Record<string, unknown>, fixtureScenario?: string): string | null {
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
    // Wrapped in its own block so a flow using this action more than once doesn't redeclare `client`
    // in the same test-body scope.
    case "hardReload":
      return `{ const client = await page.context().newCDPSession(page); await client.send('Page.enable'); await client.send('Page.reload', { ignoreCache: true }); await page.waitForLoadState(); await client.detach(); }`;
    // `page` is reassigned in place — it's a normal (destructured) function parameter in the generated
    // test, not a const, so every later statement in the test picks up the new active page for free.
    // Goes through a fresh `browser.newContext()` seeded from the current storageState rather than
    // `page.context().newPage()` — Playwright rejects a second page on the implicit context every page
    // in this codebase is created with ("Please use browser.newContext()").
    case "openInNewTab":
      return `{ const url = page.url(); const storageState = await page.context().storageState({ indexedDB: true }); const newContext = await browser.newContext({ storageState }); ${fixtureScenario ? `await installFixtures(newContext, loadScenario('${escapeJsString(fixtureScenario)}'));` : ''} page = await newContext.newPage(); await page.goto(url); }`;
    // Closes just the context, not the shared `browser` fixture the test runner owns — closing that
    // would break the runner, not just this one test's simulated "browser restart".
    case "reopenBrowser":
      return `{ const url = page.url(); const storageState = await page.context().storageState({ indexedDB: true }); await page.context().close(); const newContext = await browser.newContext({ storageState }); ${fixtureScenario ? `await installFixtures(newContext, loadScenario('${escapeJsString(fixtureScenario)}'));` : ''} page = await newContext.newPage(); await page.goto(url); }`;
    case "scroll":
      return input.locator ? `await ${locatorExpr()}.scrollIntoViewIfNeeded();` : `await page.mouse.wheel(0, 10000);`;
    case "setViewportSize":
      return `await page.setViewportSize({ width: ${codegenViewportDimension(input.width, "width")}, height: ${codegenViewportDimension(input.height, "height")} });`;
    case "waitFor":
      return `await ${locatorExpr()}.first().waitFor({ state: 'visible' });`;
    case "uploadFile":
      return `await ${locatorExpr()}.setInputFiles(${JSON.stringify(input.filePaths)});`;
    case "download":
      return `{ const downloadPromise = page.waitForEvent('download'); await ${locatorExpr()}.click(); const download = await downloadPromise; await download.path(); }`;
    case "handleDialog":
      return `page.once('dialog', (dialog) => dialog.${input.behavior as string}());`;
    case "burst": {
      // Short on purpose, matching the real `burst()` — a repetition whose target is already gone
      // (an earlier one navigated away) should fail fast, not wait out Playwright's much longer default.
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
      return `for (let i = 0; i < ${Number(input.count)}; i++) { try { ${innerStatement} } catch { break; } }`;
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
    case "verifyExpectation":
      return null;
    default:
      return null;
  }
}

function expectationToStatement(entry: EvidenceEntry): string | null {
  const observation = entry.result?.expectation;
  if (!observation || observation.status !== "met") return null;
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
  // Preserve the original timeline: an expectation may describe an intermediate state (e.g. an
  // item is present in the cart) and must run before later actions navigate away from that state.
  const bodyLines = toolCalls
    .flatMap((entry) => [
      actionToStatement(entry.toolCall!.name, entry.toolCall!.input, fixtureScenario),
      expectationToStatement(entry),
    ])
    .filter((line): line is string => line !== null);

  const assertion = findConfirmationAssertion(flow.entries);
  // A recorded final expectation can already express the flow completion signal. Avoid emitting
  // the same assertion again as a generic confirmation fallback.
  const finalAssertion = assertion && bodyLines.includes(assertion) ? null : assertion;
  const body = [...bodyLines, finalAssertion].filter((line): line is string => line !== null).map((line) => `  ${line}`).join("\n");

  // `openInNewTab`/`reopenBrowser` both need the `browser` fixture to open a fresh context from; every
  // other action only ever needs `page` (reassigned in place when one of those switches it).
  const needsBrowserFixture = toolCalls.some(
    (entry) => entry.toolCall!.name === "openInNewTab" || entry.toolCall!.name === "reopenBrowser",
  );
  // Explicit credentials are an intentional override for a captured flow state. This matters when
  // discovery started on a login screen or captured an unauthenticated state after a failed login.
  const hasFlowStorageState = Boolean(flow.startStorageState) && !(options.username && options.password);
  const fixtureParams = hasFlowStorageState || needsBrowserFixture ? (hasFlowStorageState ? "{ browser }" : "{ page, browser }") : "{ page }";
  if (hasFlowStorageState) {
    const storageState = JSON.stringify(JSON.parse(flow.startStorageState!));
    const indentedBody = body
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  return `test('${escapeJsString(testTitle)}', async (${fixtureParams}) => {
  const flowContext = await browser.newContext({ storageState: ${storageState} });
  let page = await flowContext.newPage();
${fixtureScenario ? `  await installFixtures(page.context(), loadScenario('${escapeJsString(fixtureScenario)}'));\n` : ''}
  await page.goto('${escapeJsString(flow.startUrl!)}');
  try {
${indentedBody}
  } finally {
    await flowContext.close();
  }
});`;
  }

  const setup = [
    ...(fixtureScenario ? [
      `const responseFixtures = loadScenario('${escapeJsString(fixtureScenario)}');`,
      "await installFixtures(page.context(), responseFixtures);",
    ] : []),
    `await page.goto('${escapeJsString(options.url)}');`,
    ...(options.username && options.password
      ? [`await loginWithCredentials(page, '${escapeJsString(options.username)}', '${escapeJsString(options.password)}');`]
      : []),
  ].map((line) => `  ${line}`).join("\n");
  return `test('${escapeJsString(testTitle)}', async (${fixtureParams}) => {\n${setup}\n${body}\n});`;
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
  const fixturePlan = planFixtureScenarios(flows);
  const hasStorageState = Boolean(options.storageStatePath);
  const hasLogin = !hasStorageState && Boolean(options.username && options.password);
  const hasFixtures = fixturePlan.artifacts.length > 0;

  const parts: string[] = ["import { test, expect } from '@playwright/test';"];
  if (hasLogin) parts.push("import { loginWithCredentials } from './auth.js';");
  if (hasFixtures) parts.push("import { installFixtures, loadScenario } from './fixtures.js';");

  if (hasStorageState) {
    parts.push(`test.use({ storageState: '${escapeJsString(options.storageStatePath!)}' });`);
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
      ...(hasLogin ? [{ relativePath: "auth.ts", content: GENERATED_AUTH_HELPER }] : []),
      ...(hasFixtures ? [{ relativePath: "fixtures.ts", content: GENERATED_FIXTURES_HELPER }, ...fixturePlan.artifacts] : []),
    ],
  };
}

export function generateSpec(flows: FlowEntries[], options: CodegenOptions): string {
  return generateSpecBundle(flows, options).spec;
}
