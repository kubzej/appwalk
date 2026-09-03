import type { BrowserContext, Page } from "playwright";
import type { TabRegistryHandle } from "../agent/tools.js";
import { configurePageTimeouts } from "../browser/actions.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import { logError, type Logger } from "../logging/logger.js";

// A page can become active more than once during a flow. Keep listeners idempotent so switching
// back to a tab never duplicates popup, crash, or WebSocket evidence.
const popupInstrumentedPages = new WeakSet<Page>();
const crashInstrumentedPages = new WeakSet<Page>();
const webSocketInstrumentedPages = new WeakSet<Page>();

/** Logs a new tab the target app opens on its own — a target="_blank" link, window.open(), an OAuth
 * popup — and optionally registers it under the current flow's stable tab-N registry. */
export function attachPopupDetection(page: Page, logger: Logger, tabRegistryHandle?: TabRegistryHandle): void {
  if (popupInstrumentedPages.has(page)) return;
  popupInstrumentedPages.add(page);
  page.on("popup", (popup) => {
    configurePageTimeouts(popup);
    logger.verbose(`  The page opened a new tab on its own: ${popup.url()}`);
    logger.debug("browser.popup_opened", "The page opened a popup", { url: popup.url() });
    if (tabRegistryHandle) {
      const newId = `tab-${tabRegistryHandle.tabs.size}`;
      tabRegistryHandle.tabs.set(newId, popup);
      logger.verbose(`  Registered as ${newId}; switchTab can reach it.`);
      logger.debug("browser.popup_registered", "Popup registered as an addressable tab", { tabId: newId, url: popup.url() });
    }
  });
}

/** Records renderer crashes on every page that becomes active. */
export function attachCrashDetection(page: Page, recorder: EvidenceRecorder): void {
  if (crashInstrumentedPages.has(page)) return;
  crashInstrumentedPages.add(page);
  page.on("crash", () => recorder.recordCrash(page.url()));
}

/** Captures WebSocket traffic frame-by-frame; binary frames are summarized to keep evidence JSON-safe. */
export function attachWebSocketCapture(page: Page, recorder: EvidenceRecorder): void {
  if (webSocketInstrumentedPages.has(page)) return;
  webSocketInstrumentedPages.add(page);
  page.on("websocket", (ws) => {
    const url = ws.url();
    ws.on("framesent", ({ payload }) => recorder.recordWebSocketFrame({ url, direction: "sent", payload: webSocketPayloadToText(payload) }));
    ws.on("framereceived", ({ payload }) => recorder.recordWebSocketFrame({ url, direction: "received", payload: webSocketPayloadToText(payload) }));
  });
}

function webSocketPayloadToText(payload: string | Buffer): string {
  return typeof payload === "string" ? payload : `(binary, ${payload.length} bytes)`;
}

/** Starts a diagnostic trace without making tracing failure fatal to the run. */
export async function startTracing(context: BrowserContext, logger: Logger): Promise<void> {
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  } catch (error) {
    logger.debug("tracing.start_failed", "Failed to start Playwright tracing", { error: logError(error) });
  }
}

/** Stops a trace and tolerates a context already closed by a browser restart. */
export async function stopTracing(context: BrowserContext, path: string, logger: Logger): Promise<void> {
  try {
    await context.tracing.stop({ path });
    logger.debug("tracing.saved", "Playwright trace saved", { path });
  } catch (error) {
    logger.debug("tracing.stop_failed", "Failed to save Playwright trace", { error: logError(error) });
  }
}
