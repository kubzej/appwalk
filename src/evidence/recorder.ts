import type { BrowserContext, ConsoleMessage, Page } from 'playwright';
import { type Logger } from '../logging/logger.js';
import { defaultRedactor, type Redactor } from '../security/redaction.js';

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  /** Parsed JSON response body — only populated when content-type is application/json, and only once the async read settles (see waitForPendingBodies). */
  body?: unknown;
  /** True when the body read exceeded the configured timeout and the entry was finalized without a body. */
  bodyReadTimedOut?: boolean;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export interface WebSocketFrameEntry {
  url: string;
  direction: 'sent' | 'received';
  /** Binary frames are summarized rather than serialized raw, to stay JSON-safe in evidence.jsonl. */
  payload: string;
}

export type RuntimeErrorKind = 'console_error' | 'page_error' | 'request_failed' | 'http_error' | 'page_crash';

export interface RuntimeErrorEntry {
  kind: RuntimeErrorKind;
  message: string;
  method?: string;
  url?: string;
  status?: number;
  /** True when the browser error is a direct side effect of Appwalk's safety guard. */
  safetyRelated?: boolean;
  /** True when the browser cancelled a request as part of normal navigation or page teardown. */
  lifecycle?: boolean;
}

export interface EvidenceRecorderOptions {
  /** Maximum time to wait for an individual JSON response body before leaving it unset. */
  bodyReadTimeoutMs?: number;
  /** Shared redaction policy applied while browser evidence is collected. */
  redactor?: Redactor;
}

const DEFAULT_BODY_READ_TIMEOUT_MS = 5_000;

/**
 * Attaches to a browser context and keeps a running log of network + console activity across
 * every page in it — a new tab opened via `openTab`, or one the target app opens itself, is
 * covered automatically without any reattachment.
 * - `network`/`consoleLog`: read non-destructively at any time (used by the loop's success heuristic).
 * - `drain()`: a separate, cumulative cursor for per-step evidence capture — the two don't interfere.
 */
export class EvidenceRecorder {
  readonly network: NetworkEntry[] = [];
  readonly consoleLog: ConsoleEntry[] = [];
  readonly runtimeErrors: RuntimeErrorEntry[] = [];
  readonly webSocketFrames: WebSocketFrameEntry[] = [];

  private drainedNetwork = 0;
  private drainedConsole = 0;
  private drainedRuntimeErrors = 0;
  private drainedWebSocketFrames = 0;
  private pendingBodyReads: Promise<void>[] = [];
  private readonly pendingSafetyBlocks = new Map<string, number>();
  private safetyBlocksSeen = 0;
  private lastSafetyBlockAt = 0;
  private readonly bodyReadTimeoutMs: number;
  private readonly redactor: Redactor;
  // A same-context page switch (openTab, switchTab) is already covered by the constructor's
  // attachment; only a genuinely different context (openInNewTab, reopenBrowser both create one)
  // needs a fresh attachment. Tracking which contexts are already attached keeps `reattach` safe
  // to call on every activePage switch without double-counting a single event twice.
  private readonly attachedContexts = new WeakSet<BrowserContext>();

  constructor(
    context: BrowserContext,
    private readonly logger?: Logger,
    options: EvidenceRecorderOptions = {},
  ) {
    this.bodyReadTimeoutMs = Math.max(0, options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS);
    this.redactor = options.redactor ?? defaultRedactor;
    this.attach(context);
  }

  /** Attaches to the active page's context — a no-op if that context is already covered (the
   * common case: openTab/switchTab stay within the same context as the constructor's). Only a
   * page that landed in a genuinely new context (openInNewTab, reopenBrowser) causes real work
   * here. */
  reattach(page: Page): void {
    this.attach(page.context());
  }

  /** Associates the next failed browser request with an intentional safety abort. */
  markSafetyBlocked(request: { method: string; url: string }): void {
    const key = this.requestKey(request.method, request.url);
    this.pendingSafetyBlocks.set(key, (this.pendingSafetyBlocks.get(key) ?? 0) + 1);
    this.safetyBlocksSeen += 1;
    this.lastSafetyBlockAt = Date.now();
  }

  /** Records a renderer-process crash as its own diagnosable kind, distinct from every other
   * failure that can follow one — `page.on('crash')` is page-scoped (there is no context-level
   * equivalent), so the caller attaches it directly rather than through `attach()`. */
  recordCrash(url?: string): void {
    this.runtimeErrors.push({
      kind: 'page_crash',
      message: "The page's renderer process crashed.",
      url: url ? this.redactor.diagnosticUrl(url) : undefined,
    });
    this.logger?.debug('browser.page_crash', "The page's renderer process crashed", { url });
  }

  /** Records one WebSocket frame — the caller (`attachWebSocketCapture` in orchestrate.ts) owns
   * the actual `page.on('websocket')` wiring, the same split as `recordCrash`, since `websocket`
   * is page-scoped with no context-level equivalent either. */
  recordWebSocketFrame(entry: WebSocketFrameEntry): void {
    this.webSocketFrames.push({
      ...entry,
      url: this.redactor.url(entry.url),
      payload: this.redactor.text(entry.payload),
    });
  }

  private consumeSafetyBlock(request: { method: string; url: string }): boolean {
    const key = this.requestKey(request.method, request.url);
    const count = this.pendingSafetyBlocks.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.pendingSafetyBlocks.delete(key);
    else this.pendingSafetyBlocks.set(key, count - 1);
    return true;
  }

  private attach(context: BrowserContext): void {
    if (this.attachedContexts.has(context)) return;
    this.attachedContexts.add(context);

    context.on('response', (response) => {
      const entry: NetworkEntry = {
        method: response.request().method(),
        url: this.redactor.url(response.url()),
        status: response.status(),
      };
      this.network.push(entry); // pushed synchronously — preserves arrival order

      if (response.status() >= 500) {
        const error: RuntimeErrorEntry = {
          kind: 'http_error',
          message: this.redactor.text(`HTTP ${response.status()} response`),
          method: response.request().method(),
          url: this.redactor.diagnosticUrl(response.url()),
          status: response.status(),
        };
        this.runtimeErrors.push(error);
      }

      const contentType = response.headers()['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        this.pendingBodyReads.push(this.readJsonBody(response, entry));
      }
    });

    context.on('console', (msg: ConsoleMessage) => {
      const text = this.redactor.text(msg.text());
      this.consoleLog.push({ type: msg.type(), text });
      if (msg.type() === 'error') {
        this.runtimeErrors.push({
          kind: 'console_error',
          message: text,
          safetyRelated: this.isSafetyRelatedConsoleError(msg.text()),
        });
      }
      this.logger?.debug('browser.console', 'Page console message', { type: msg.type(), text });
    });
    // Context-level equivalent of page.on("pageerror") — the same uncaught-exception signal,
    // aggregated across every page in the context instead of bound to just one.
    context.on('weberror', (webError) => {
      const error = webError.error();
      this.runtimeErrors.push({ kind: 'page_error', message: this.redactor.text(error.message) });
      this.logger?.debug('browser.page_error', 'Page JavaScript error', { error: error.message });
    });
    context.on('requestfailed', (request) => {
      const safetyRelated = this.consumeSafetyBlock({ method: request.method(), url: request.url() });
      const message = request.failure()?.errorText ?? 'Request failed';
      const lifecycle = isLifecycleRequestFailure(message);
      this.runtimeErrors.push({
        kind: 'request_failed',
        message: this.redactor.text(message),
        method: request.method(),
        url: this.redactor.diagnosticUrl(request.url()),
        safetyRelated,
        lifecycle,
      });
      this.logger?.debug(
        lifecycle ? 'browser.lifecycle_noise' : 'browser.request_failed',
        lifecycle ? 'Browser cancelled a request during navigation or cleanup' : 'Browser request failed',
        {
          method: request.method(),
          url: request.url(),
          error: message,
          lifecycle,
        },
      );
    });
  }

  private async readJsonBody(
    response: { json: () => Promise<unknown>; url: () => string },
    entry: NetworkEntry,
  ): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let finalized = false;
    try {
      await new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          if (finalized) return;
          finalized = true;
          timedOut = true;
          entry.bodyReadTimedOut = true;
          resolve();
        }, this.bodyReadTimeoutMs);
        try {
          response
            .json()
            .then((body) => {
              if (finalized) return;
              finalized = true;
              entry.body = this.redactor.redact(body); // mutates the already-pushed entry, order unaffected
              resolve();
            })
            .catch(() => {
              if (finalized) return;
              finalized = true;
              resolve();
            });
        } catch {
          // Not actually available (redirected, empty, malformed despite the header) — leave unset.
          finalized = true;
          resolve();
        }
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (timedOut) {
      this.logger?.debug('evidence.body_read_timeout', 'JSON response body was not available before cleanup', {
        url: this.redactor.diagnosticUrl(response.url()),
        timeoutMs: this.bodyReadTimeoutMs,
      });
    }
  }

  private isSafetyRelatedConsoleError(message: string): boolean {
    if (this.safetyBlocksSeen === 0) return false;
    const isNetworkFailure = /Failed to load resource: net::ERR_FAILED|Failed to fetch|NetworkError|Load failed/i.test(
      message,
    );
    return isNetworkFailure && Date.now() - this.lastSafetyBlockAt <= 2000;
  }

  /** Waits for any in-flight JSON body reads to settle. Call before relying on `.body` being populated everywhere it can be (e.g. before diffing two runs). */
  async waitForPendingBodies(): Promise<void> {
    const pending = this.pendingBodyReads.splice(0);
    if (pending.length === 0) return;
    this.logger?.debug('evidence.body_reads_wait_started', 'Finalizing captured response bodies', {
      pending: pending.length,
    });
    await Promise.allSettled(pending);
    this.logger?.debug('evidence.body_reads_finalized', 'Captured response bodies finalized', {
      pending: pending.length,
    });
  }

  drain(): {
    network: NetworkEntry[];
    console: ConsoleEntry[];
    runtimeErrors: RuntimeErrorEntry[];
    webSocketFrames: WebSocketFrameEntry[];
  } {
    const network = this.network.slice(this.drainedNetwork);
    const consoleEntries = this.consoleLog.slice(this.drainedConsole);
    const runtimeErrors = this.runtimeErrors.slice(this.drainedRuntimeErrors);
    const webSocketFrames = this.webSocketFrames.slice(this.drainedWebSocketFrames);
    this.drainedNetwork = this.network.length;
    this.drainedConsole = this.consoleLog.length;
    this.drainedRuntimeErrors = this.runtimeErrors.length;
    this.drainedWebSocketFrames = this.webSocketFrames.length;
    return { network, console: consoleEntries, runtimeErrors, webSocketFrames };
  }

  private requestKey(method: string, url: string): string {
    return `${method.toUpperCase()} ${this.redactor.diagnosticUrl(url)}`;
  }
}

function isLifecycleRequestFailure(message: string): boolean {
  return /ERR_ABORTED|ERR_CANCELED|ERR_CANCELLED|ERR_ABORT/i.test(message);
}
