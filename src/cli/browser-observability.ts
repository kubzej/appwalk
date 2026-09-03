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

export interface TraceSession {
  beforeRestart: (page: Page) => Promise<void>;
  afterRestart: (page: Page) => Promise<void>;
  switchTo: (page: Page) => Promise<void>;
  finish: () => Promise<void>;
}

/** Keeps an opt-in trace alive across `reopenBrowser`, which replaces the traced context. */
export async function createTraceSession(
  initialContext: BrowserContext,
  basePath: string,
  logger: Logger,
): Promise<TraceSession> {
  let currentContext: BrowserContext | undefined = initialContext;
  let segment = 1;
  await startTracing(initialContext, logger);

  const segmentPath = () => segment === 1
    ? basePath
    : basePath.replace(/\.zip$/i, `-part-${segment}.zip`);

  return {
    beforeRestart: async () => {
      if (!currentContext) return;
      const context = currentContext;
      currentContext = undefined;
      await stopTracing(context, segmentPath(), logger);
    },
    afterRestart: async (page) => {
      segment += 1;
      currentContext = page.context();
      await startTracing(currentContext, logger);
    },
    switchTo: async (page) => {
      const nextContext = page.context();
      if (currentContext === nextContext) return;
      if (currentContext) {
        const previousContext = currentContext;
        currentContext = undefined;
        await stopTracing(previousContext, segmentPath(), logger);
      }
      segment += 1;
      currentContext = nextContext;
      await startTracing(currentContext, logger);
    },
    finish: async () => {
      if (!currentContext) return;
      const context = currentContext;
      currentContext = undefined;
      await stopTracing(context, segmentPath(), logger);
    },
  };
}
