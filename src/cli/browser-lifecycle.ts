import {
  chromium,
  devices,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright';
import type { BrowserEngine } from '../config.js';
import type { Persona } from '../agent/personas.js';
import { configurePageTimeouts, type BrowserLifecycle } from '../browser/actions.js';
import { logError, type Logger } from '../logging/logger.js';

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

export async function closeBrowserWithTimeout(
  browser: Browser | null | undefined,
  logger: Logger,
  phase: string,
): Promise<void> {
  if (!browser || !browser.isConnected()) return;

  logger.debug('browser.close_started', `Closing browser after ${phase}`, { phase });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const closePromise = browser.close().then(
    () => true,
    (error: unknown) => {
      logger.debug('browser.close_failed', 'Browser close returned an error', { phase, error: logError(error) });
      return true;
    },
  );
  const closed = await Promise.race([
    closePromise,
    new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), BROWSER_CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (!closed) {
    logger.warn(`Browser cleanup exceeded ${BROWSER_CLOSE_TIMEOUT_MS}ms; continuing finalization`);
    logger.debug('browser.close_timeout', 'Browser close did not finish before the cleanup deadline', {
      phase,
      timeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
    });
  } else {
    logger.debug('browser.close_completed', 'Browser cleanup completed', { phase });
  }
}

export async function closeContextWithTimeout(context: BrowserContext, logger: Logger, phase: string): Promise<void> {
  logger.debug('browser.context_close_started', `Closing browser context after ${phase}`, { phase });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const closePromise = context.close().then(
    () => true,
    (error: unknown) => {
      logger.debug('browser.context_close_failed', 'Browser context close returned an error', {
        phase,
        error: logError(error),
      });
      return true;
    },
  );
  const closed = await Promise.race([
    closePromise,
    new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), BROWSER_CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (!closed) {
    logger.warn(`Browser context cleanup exceeded ${BROWSER_CLOSE_TIMEOUT_MS}ms; continuing finalization`);
    logger.debug('browser.context_close_timeout', 'Browser context close did not finish before the cleanup deadline', {
      phase,
      timeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
    });
  } else {
    logger.debug('browser.context_close_completed', 'Browser context cleanup completed', { phase });
  }
}

export async function closeTrackedContexts(
  contexts: Set<BrowserContext>,
  logger: Logger,
  phase: string,
): Promise<void> {
  const ownedContexts = [...contexts];
  contexts.clear();
  for (const context of ownedContexts) {
    await closeContextWithTimeout(context, logger, phase);
  }
}

/** Maps the configured engine name to the Playwright BrowserType that launches it. */
export function resolveBrowserType(engine: BrowserEngine): BrowserType {
  switch (engine) {
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    default:
      return chromium;
  }
}

/** Converts a persona's device preset into BrowserContext options without letting the descriptor
 * silently override the engine selected by the run. */
export function deviceContextOptions(persona?: Persona): Record<string, unknown> {
  if (!persona?.devicePreset) return {};
  const device = devices[persona.devicePreset];
  if (!device) throw new Error(`Unknown device preset "${persona.devicePreset}" for persona "${persona.name}".`);
  const { defaultBrowserType: _defaultBrowserType, ...contextOptions } = device;
  return contextOptions;
}

export interface BrowserLifecycleOptions {
  browserEngine: BrowserEngine;
  storageStatePath?: string;
  persona?: Persona;
  prepareContext?: (context: BrowserContext) => Promise<void>;
  preparePage?: (page: Page) => Promise<void>;
}

/**
 * Creates the one lifecycle adapter used by the run's initial, same-context, cloned-context, and
 * restarted-browser paths. The storage snapshot is the only intentionally changing input; all
 * configured context settings and runtime preparation stay centralized here.
 */
export function createBrowserLifecycle(options: BrowserLifecycleOptions): BrowserLifecycle {
  const browserType = resolveBrowserType(options.browserEngine);
  const contextOptions = deviceContextOptions(options.persona);
  return {
    launchBrowser: () => browserType.launch(),
    createContext: (browser, storageState) =>
      browser.newContext({
        ...contextOptions,
        ...(storageState
          ? { storageState }
          : options.storageStatePath
            ? { storageState: options.storageStatePath }
            : {}),
      }),
    createPage: async (context) => {
      const page = await context.newPage();
      configurePageTimeouts(page);
      return page;
    },
    prepareContext: options.prepareContext ?? (async () => undefined),
    preparePage: options.preparePage ?? (async () => undefined),
  };
}
