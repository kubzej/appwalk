import { chromium } from 'playwright';
import type { Page, Route } from 'playwright';
import { toStepResult } from './snapshot.js';
import { resolveLocator } from './locator.js';
import type { StepResult } from '../types.js';

const CLICK_SETTLE_MS = 500;
export const ACTION_TIMEOUT_MS = 5000;
export const NAVIGATION_TIMEOUT_MS = 20000;

export type ClickButton = 'left' | 'right' | 'middle';
export type ClickModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
type ClickOptions = { button?: ClickButton; modifiers?: ClickModifier[] };

/** Applies Appwalk's timeout contract to every page, including pages from a new context. */
export function configurePageTimeouts(page: Page): void {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

function viewportDimension(value: unknown, name: string): number {
  const dimension = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(`Viewport ${name} must be a positive integer.`);
  }
  return dimension;
}

/** Lists each IndexedDB database's object stores and record counts — not full row contents, which
 * could be arbitrarily large or contain values that don't serialize cleanly back across `page.evaluate`.
 * Store names + counts are already enough to tell whether an interruption dropped or duplicated data. */
async function summarizeIndexedDb(page: Page): Promise<string> {
  const summary = await page.evaluate(async () => {
    if (!('databases' in indexedDB)) return null;
    const dbInfos = await indexedDB.databases();
    const parts: string[] = [];
    for (const info of dbInfos) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name!);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const storeNames = Array.from(db.objectStoreNames);
      if (storeNames.length === 0) {
        parts.push(`${info.name} (no stores)`);
      } else {
        const tx = db.transaction(storeNames, 'readonly');
        const counts = await Promise.all(
          storeNames.map(
            (storeName) =>
              new Promise<string>((resolve) => {
                const req = tx.objectStore(storeName).count();
                req.onsuccess = () => resolve(`${storeName}=${req.result}`);
                req.onerror = () => resolve(`${storeName}=?`);
              }),
          ),
        );
        parts.push(`${info.name} [${counts.join(', ')}]`);
      }
      db.close();
    }
    return parts;
  });
  if (summary === null) return '(not supported on this page)';
  return summary.length ? summary.join('; ') : '(none)';
}

/** Storage isn't visible in the accessibility tree — appended to disruption actions' results as the
 * only way to observe what survived. Some origins throw on access; degrade to "(unavailable)" per
 * piece rather than failing the whole action. */
async function captureStorageSummary(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const cookieList = cookies.length ? cookies.map((c) => c.name).join(', ') : '(none)';

  let localList: string;
  let sessionList: string;
  try {
    const [localKeys, sessionKeys] = await page.evaluate(() => [
      Object.keys(localStorage),
      Object.keys(sessionStorage),
    ]);
    localList = localKeys.length ? localKeys.join(', ') : '(none)';
    sessionList = sessionKeys.length ? sessionKeys.join(', ') : '(none)';
  } catch {
    localList = '(unavailable on this page)';
    sessionList = '(unavailable on this page)';
  }

  let idbSummary: string;
  try {
    idbSummary = await summarizeIndexedDb(page);
  } catch {
    idbSummary = '(unavailable on this page)';
  }

  return `Storage — cookies: ${cookieList}; localStorage keys: ${localList}; sessionStorage keys: ${sessionList}; indexedDB: ${idbSummary}`;
}

async function stepResultWithStorage(page: Page): Promise<StepResult> {
  const result = await toStepResult(page);
  const storage = await captureStorageSummary(page);
  return { ...result, snapshot: `${result.snapshot}\n\n${storage}` };
}

export async function navigate(page: Page, url: string): Promise<StepResult> {
  await page.goto(url);
  return toStepResult(page);
}

export function isPointerInterceptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /intercepts pointer events|receives pointer events|would receive (?:the )?(?:click|pointer events)/i.test(message);
}

export async function click(page: Page, locator: string, button?: ClickButton, modifiers?: ClickModifier[]): Promise<StepResult> {
  const options: ClickOptions = { button, modifiers };
  try {
    await resolveLocator(page, locator).click(options);
  } catch (err) {
    // A modal/overlay from a previous action can intercept pointer events on the next
    // click. Escape closes most modal libraries — retry once before giving up.
    if (!isPointerInterceptionError(err))
      throw err;
    await page.keyboard.press('Escape');
    await resolveLocator(page, locator).click(options);
  }
  await page.waitForTimeout(CLICK_SETTLE_MS);
  return toStepResult(page);
}

export async function doubleClick(page: Page, locator: string, button?: ClickButton, modifiers?: ClickModifier[]): Promise<StepResult> {
  await resolveLocator(page, locator).dblclick({ button, modifiers });
  await page.waitForTimeout(CLICK_SETTLE_MS);
  return toStepResult(page);
}

export async function fill(
  page: Page,
  locator: string,
  value: string,
): Promise<StepResult> {
  await resolveLocator(page, locator).fill(value);
  return toStepResult(page);
}

export async function select(
  page: Page,
  locator: string,
  value: string | string[],
): Promise<StepResult> {
  await resolveLocator(page, locator).selectOption(value);
  return toStepResult(page);
}

export async function pressKey(
  page: Page,
  locator: string,
  key: string,
): Promise<StepResult> {
  await resolveLocator(page, locator).press(key);
  return toStepResult(page);
}

export async function check(page: Page, locator: string): Promise<StepResult> {
  await resolveLocator(page, locator).check();
  return toStepResult(page);
}

export async function uncheck(
  page: Page,
  locator: string,
): Promise<StepResult> {
  await resolveLocator(page, locator).uncheck();
  return toStepResult(page);
}

export async function hover(page: Page, locator: string): Promise<StepResult> {
  await resolveLocator(page, locator).hover();
  return toStepResult(page);
}

export async function dragAndDrop(page: Page, source: string, target: string): Promise<StepResult> {
  await resolveLocator(page, source).dragTo(resolveLocator(page, target));
  return toStepResult(page);
}

export async function goBack(page: Page): Promise<StepResult> {
  await page.goBack();
  return stepResultWithStorage(page);
}

export async function goForward(page: Page): Promise<StepResult> {
  await page.goForward();
  return stepResultWithStorage(page);
}

export async function reload(page: Page): Promise<StepResult> {
  await page.reload();
  return stepResultWithStorage(page);
}

/** Removes one cookie, or all cookies when no name is supplied, so the next request can exercise
 * the application's handling of a missing or stale session credential. */
export async function clearCookie(page: Page, name?: string): Promise<StepResult> {
  if (name) {
    await page.context().clearCookies({ name });
  } else {
    await page.context().clearCookies();
  }
  return stepResultWithStorage(page);
}

/** A plain `page.reload()` can still serve a page from Chromium's HTTP cache — this forces a real
 * network re-fetch (Chrome's "hard reload"), which Playwright's public Page API has no direct option
 * for, so it goes through a CDP session instead. Chromium-only, matching this project's browser choice. */
export async function hardReload(page: Page): Promise<StepResult> {
  const client = await page.context().newCDPSession(page);
  await client.send('Page.enable');
  await client.send('Page.reload', { ignoreCache: true });
  await page.waitForLoadState();
  await client.detach();
  return stepResultWithStorage(page);
}

/** Opens the current page's URL in a fresh context seeded from the same storageState — the closest
 * simulation of "restart the browser" / "open a bookmark fresh" this codebase can produce for a tab
 * that's meant to be abandoned. Used only by `openInNewTab`, which intentionally wants an independent
 * context (a real page reload from a cold context, not a live-shared one). */
async function cloneIntoNewTab(page: Page): Promise<Page> {
  const url = page.url();
  // `indexedDB: true` is required or the snapshot omits it, unlike a real new tab.
  const storageState = await page.context().storageState({ indexedDB: true });
  const browser = page.context().browser();
  if (!browser) throw new Error('cloneIntoNewTab: page has no browser (persistent context?)');
  const newContext = await browser.newContext({ storageState });
  const newPage = await newContext.newPage();
  configurePageTimeouts(newPage);
  await newPage.goto(url);
  return newPage;
}

/** Opens the current URL in a new tab and switches the active page to it. The old tab is left open —
 * matches a real user, and the caller closes the whole browser at the end of a run regardless. */
export async function openInNewTab(page: Page): Promise<StepResult & { activePage: Page }> {
  const newPage = await cloneIntoNewTab(page);
  const result = await stepResultWithStorage(newPage);
  return { ...result, activePage: newPage };
}

/** Opens the current URL in a genuine second page of the *same* browser context — real, live-shared
 * cookies/localStorage/sessionStorage, exactly like two tabs of one real browser profile. Requires the
 * caller's page to already live in an explicit context (`browser.newContext()`, not the `browser.newPage()`
 * shorthand, which Playwright reserves a single page for). The tools layer registers the result under a
 * stable id so `switchTab` can return to it later. */
export async function openTab(page: Page): Promise<StepResult & { activePage: Page }> {
  const url = page.url();
  const newPage = await page.context().newPage();
  configurePageTimeouts(newPage);
  await newPage.goto(url);
  const result = await stepResultWithStorage(newPage);
  return { ...result, activePage: newPage };
}

/** Makes a previously opened tab (tracked by the tools layer) the active page again. */
export async function switchTab(target: Page): Promise<StepResult & { activePage: Page }> {
  const result = await stepResultWithStorage(target);
  return { ...result, activePage: target };
}

/** Simulates fully closing and reopening the browser: saves the current context's storageState (this
 * captures cookies + localStorage, but NOT sessionStorage — Playwright's storageState API doesn't
 * carry it, which matches how a real browser restart also drops sessionStorage), closes the browser,
 * launches a fresh one from that saved state, and navigates back to the same URL. */
export async function reopenBrowser(page: Page): Promise<StepResult & { activePage: Page }> {
  const url = page.url();
  // Without `indexedDB: true`, Playwright's storageState snapshot omits IndexedDB entirely — that
  // would make this simulation lose IndexedDB data a real browser restart/new-tab actually keeps.
  const storageState = await page.context().storageState({ indexedDB: true });
  const browser = page.context().browser();
  if (!browser) throw new Error('reopenBrowser: page has no browser (persistent context?)');
  await browser.close();
  const newBrowser = await chromium.launch();
  const newPage = await newBrowser.newPage({ storageState });
  configurePageTimeouts(newPage);
  await newPage.goto(url);
  const result = await stepResultWithStorage(newPage);
  return { ...result, activePage: newPage };
}

/** Scrolls a specific element into view, or to the bottom of the page when no locator is given (infinite-scroll pages). */
export async function scroll(
  page: Page,
  locator?: string,
): Promise<StepResult> {
  if (locator) {
    await resolveLocator(page, locator).scrollIntoViewIfNeeded();
  } else {
    await page.mouse.wheel(0, 10000);
  }
  return toStepResult(page);
}

export async function setViewportSize(
  page: Page,
  width: unknown,
  height: unknown,
): Promise<StepResult> {
  await page.setViewportSize({ width: viewportDimension(width, 'width'), height: viewportDimension(height, 'height') });
  return toStepResult(page);
}

export async function uploadFile(
  page: Page,
  locator: string,
  filePaths: string[],
): Promise<StepResult> {
  await resolveLocator(page, locator).setInputFiles(filePaths);
  return toStepResult(page);
}

/** Clicks a download control and waits until Playwright has received the file. The generated test
 * performs the same event handshake without committing an environment-specific filesystem path. */
export async function download(page: Page, locator: string): Promise<StepResult> {
  const downloadPromise = page.waitForEvent('download');
  await resolveLocator(page, locator).click();
  const file = await downloadPromise;
  const result = await toStepResult(page);
  return { ...result, snapshot: `${result.snapshot}\n\nDownload - ${file.suggestedFilename()}` };
}

/** Arms the page's *next* native dialog (alert/confirm/prompt) to auto-accept or auto-dismiss. Call before the action expected to trigger it. */
export function handleDialog(page: Page, behavior: 'accept' | 'dismiss'): void {
  page.once('dialog', (dialog) => {
    if (behavior === 'accept') {
      void dialog.accept();
    } else {
      void dialog.dismiss();
    }
  });
}

export async function waitFor(
  page: Page,
  locator: string,
): Promise<StepResult> {
  // Waiting means that any matching signal is enough. Using the first match avoids
  // failing on useful broad locators such as /Order confirmed|Thank you|success/.
  await resolveLocator(page, locator).first().waitFor({ state: 'visible' });
  return toStepResult(page);
}

const BURSTABLE_ACTIONS = new Set(['click', 'pressKey', 'check', 'uncheck']);
// Short on purpose: by the time burst is called, the target was already visible in the page snapshot
// the model just saw, so a repetition should resolve near-instantly. The real reason to keep this
// short is the common, *expected* case where an early repetition navigates away or removes the
// element — waiting the default 5s per repetition to discover that wastes real time for no benefit.
const BURST_REPEAT_TIMEOUT_MS = 1000;

/** Fires one action `count` times back-to-back with no settle wait between repetitions — closer to a
 * real impatient double-click than N separate turns could simulate. Only actions where repeating makes
 * sense (`fill`/navigation don't).
 *
 * A repetition that can't find its target usually means an earlier one already navigated away or
 * removed the element — that's the useful signal, so it's reported, not thrown as an exception. */
export async function burst(
  page: Page,
  action: string,
  locator: string,
  count: number,
  key?: string,
): Promise<StepResult> {
  if (!BURSTABLE_ACTIONS.has(action)) {
    throw new Error(`burst: "${action}" can't be repeated this way — only ${[...BURSTABLE_ACTIONS].join(', ')} are supported.`);
  }
  const target = resolveLocator(page, locator);
  let completed = 0;
  let stoppedReason: string | null = null;
  for (let i = 0; i < count; i++) {
    try {
      switch (action) {
        case 'click':
          await target.click({ timeout: BURST_REPEAT_TIMEOUT_MS });
          break;
        case 'pressKey':
          await target.press(key ?? 'Enter', { timeout: BURST_REPEAT_TIMEOUT_MS });
          break;
        case 'check':
          await target.check({ timeout: BURST_REPEAT_TIMEOUT_MS });
          break;
        case 'uncheck':
          await target.uncheck({ timeout: BURST_REPEAT_TIMEOUT_MS });
          break;
      }
      completed++;
    } catch (err) {
      stoppedReason = (err as Error).message.split('\n')[0] ?? (err as Error).message;
      break;
    }
  }
  await page.waitForTimeout(CLICK_SETTLE_MS);
  const result = await toStepResult(page);
  const summary =
    stoppedReason === null
      ? `Burst: completed all ${completed}/${count} repetitions.`
      : `Burst: completed ${completed}/${count} repetitions, then stopped — the target became unavailable (${stoppedReason}), most likely because an earlier repetition already navigated away or removed it.`;
  return { ...result, snapshot: `${result.snapshot}\n\n${summary}` };
}

export type FailureMode = '500' | '503' | '404' | 'malformed' | 'offline' | 'connectionReset' | 'timeout';
const FAILURE_MODES = new Set<string>(['500', '503', '404', 'malformed', 'offline', 'connectionReset', 'timeout']);

/** Arms the next request matching `urlPattern` to fail in a specific way — call before the action
 * expected to trigger it, same pattern as `handleDialog`. One-shot: unroutes itself after firing.
 *
 * `500`/`503`/`404`/`malformed` fabricate a response; the real server never sees the request.
 * `offline`/`connectionReset` abort before any response reaches the server.
 * `timeout` is the exception: the request genuinely completes via `route.fetch()`, only the response is
 * hidden from the page — the shape most likely to expose an idempotency bug on retry. */
export async function simulateFailure(page: Page, urlPattern: string, mode: FailureMode): Promise<void> {
  if (!FAILURE_MODES.has(mode)) {
    throw new Error(`simulateFailure: unknown mode "${mode}" — expected one of ${[...FAILURE_MODES].join(', ')}.`);
  }
  // Unroute happens *after* the route settles, not before — unrouting mid-flight (before fulfill/abort
  // resolves) makes Playwright treat the route as already handled and throw on the fulfill/abort call
  // that was actually meant to settle it.
  const handler = async (route: Route) => {
    switch (mode) {
      case '500':
      case '503':
      case '404':
        await route.fulfill({ status: Number(mode), contentType: 'application/json', body: '{"error":"simulated failure"}' });
        break;
      case 'malformed':
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{not valid json' });
        break;
      case 'offline':
        await route.abort('internetdisconnected');
        break;
      case 'connectionReset':
        await route.abort('connectionreset');
        break;
      case 'timeout':
        await route.fetch();
        await route.abort('timedout');
        break;
    }
    await page.unroute(urlPattern, handler);
  };
  await page.route(urlPattern, handler);
}

/** Arms the next request matching a URL pattern to wait before continuing. This is intentionally
 * one-shot, so a broad pattern cannot slow every later flow in the session. */
export async function simulateLatency(page: Page, urlPattern: string, delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error('simulateLatency: delayMs must be a finite number between 0 and 60000.');
  }
  const handler = async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.continue();
    await page.unroute(urlPattern, handler);
  };
  await page.route(urlPattern, handler);
}
