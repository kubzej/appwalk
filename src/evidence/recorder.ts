import type { ConsoleMessage, Page } from "playwright";
import { redact, type Logger } from "../logging/logger.js";

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  /** Parsed JSON response body — only populated when content-type is application/json, and only once the async read settles (see waitForPendingBodies). */
  body?: unknown;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export type RuntimeErrorKind = "console_error" | "page_error" | "request_failed" | "http_error";

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
}

const DEFAULT_BODY_READ_TIMEOUT_MS = 5_000;

/**
 * Attaches to a page and keeps a running log of network + console activity.
 * - `network`/`consoleLog`: read non-destructively at any time (used by the loop's success heuristic).
 * - `drain()`: a separate, cumulative cursor for per-step evidence capture — the two don't interfere.
 */
export class EvidenceRecorder {
  readonly network: NetworkEntry[] = [];
  readonly consoleLog: ConsoleEntry[] = [];
  readonly runtimeErrors: RuntimeErrorEntry[] = [];

  private drainedNetwork = 0;
  private drainedConsole = 0;
  private drainedRuntimeErrors = 0;
  private pendingBodyReads: Promise<void>[] = [];
  private readonly pendingSafetyBlocks = new Map<string, number>();
  private safetyBlocksSeen = 0;
  private lastSafetyBlockAt = 0;
  private readonly bodyReadTimeoutMs: number;

  constructor(page: Page, private readonly logger?: Logger, options: EvidenceRecorderOptions = {}) {
    this.bodyReadTimeoutMs = Math.max(0, options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS);
    this.attach(page);
  }

  /** Re-attaches these same listeners to a different page, appending to the same running `network`/
   * `consoleLog` arrays — needed when the active page changes mid-run (a new tab, a reopened browser),
   * since the listeners set up in the constructor are bound to the original page object only. */
  reattach(page: Page): void {
    this.attach(page);
  }

  /** Associates the next failed browser request with an intentional safety abort. */
  markSafetyBlocked(request: { method: string; url: string }): void {
    const key = requestKey(request.method, request.url);
    this.pendingSafetyBlocks.set(key, (this.pendingSafetyBlocks.get(key) ?? 0) + 1);
    this.safetyBlocksSeen += 1;
    this.lastSafetyBlockAt = Date.now();
  }

  private consumeSafetyBlock(request: { method: string; url: string }): boolean {
    const key = requestKey(request.method, request.url);
    const count = this.pendingSafetyBlocks.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.pendingSafetyBlocks.delete(key);
    else this.pendingSafetyBlocks.set(key, count - 1);
    return true;
  }

  private attach(page: Page): void {
    page.on("response", (response) => {
      const entry: NetworkEntry = {
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      };
      this.network.push(entry); // pushed synchronously — preserves arrival order

      if (response.status() >= 500) {
        const error: RuntimeErrorEntry = {
          kind: "http_error",
          message: String(redact(`HTTP ${response.status()} response`)),
          method: response.request().method(),
          url: safeUrl(response.url()),
          status: response.status(),
        };
        this.runtimeErrors.push(error);
      }

      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        this.pendingBodyReads.push(this.readJsonBody(response, entry));
      }
    });

    page.on("console", (msg: ConsoleMessage) => {
      this.consoleLog.push({ type: msg.type(), text: msg.text() });
      if (msg.type() === "error") {
        this.runtimeErrors.push({
          kind: "console_error",
          message: String(redact(msg.text())),
          safetyRelated: this.isSafetyRelatedConsoleError(msg.text()),
        });
      }
      this.logger?.debug("browser.console", "Page console message", { type: msg.type(), text: msg.text() });
    });
    page.on("pageerror", (error) => {
      this.runtimeErrors.push({ kind: "page_error", message: String(redact(error.message)) });
      this.logger?.debug("browser.page_error", "Page JavaScript error", { error: error.message });
    });
    page.on("requestfailed", (request) => {
      const safetyRelated = this.consumeSafetyBlock({ method: request.method(), url: request.url() });
      const message = request.failure()?.errorText ?? "Request failed";
      const lifecycle = isLifecycleRequestFailure(message);
      this.runtimeErrors.push({
        kind: "request_failed",
        message: String(redact(message)),
        method: request.method(),
        url: safeUrl(request.url()),
        safetyRelated,
        lifecycle,
      });
      this.logger?.debug(lifecycle ? "browser.lifecycle_noise" : "browser.request_failed", lifecycle ? "Browser cancelled a request during navigation or cleanup" : "Browser request failed", {
        method: request.method(), url: request.url(), error: message, lifecycle,
      });
    });
  }

  private async readJsonBody(response: { json: () => Promise<unknown>; url: () => string }, entry: NetworkEntry): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          resolve();
        }, this.bodyReadTimeoutMs);
        try {
          response.json()
            .then((body) => {
              entry.body = body; // mutates the already-pushed entry, order unaffected
              resolve();
            })
            .catch(() => resolve());
        } catch {
          // Not actually available (redirected, empty, malformed despite the header) — leave unset.
          resolve();
        }
      });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (timedOut) {
      this.logger?.debug("evidence.body_read_timeout", "JSON response body was not available before cleanup", {
        url: safeUrl(response.url()),
        timeoutMs: this.bodyReadTimeoutMs,
      });
    }
  }

  private isSafetyRelatedConsoleError(message: string): boolean {
    if (this.safetyBlocksSeen === 0) return false;
    const isNetworkFailure = /Failed to load resource: net::ERR_FAILED|Failed to fetch|NetworkError|Load failed/i.test(message);
    return isNetworkFailure && Date.now() - this.lastSafetyBlockAt <= 2000;
  }

  /** Waits for any in-flight JSON body reads to settle. Call before relying on `.body` being populated everywhere it can be (e.g. before diffing two runs). */
  async waitForPendingBodies(): Promise<void> {
    const pending = this.pendingBodyReads.splice(0);
    if (pending.length === 0) return;
    this.logger?.debug("evidence.body_reads_wait_started", "Finalizing captured response bodies", { pending: pending.length });
    await Promise.allSettled(pending);
    this.logger?.debug("evidence.body_reads_finalized", "Captured response bodies finalized", { pending: pending.length });
  }

  drain(): { network: NetworkEntry[]; console: ConsoleEntry[]; runtimeErrors: RuntimeErrorEntry[] } {
    const network = this.network.slice(this.drainedNetwork);
    const consoleEntries = this.consoleLog.slice(this.drainedConsole);
    const runtimeErrors = this.runtimeErrors.slice(this.drainedRuntimeErrors);
    this.drainedNetwork = this.network.length;
    this.drainedConsole = this.consoleLog.length;
    this.drainedRuntimeErrors = this.runtimeErrors.length;
    return { network, console: consoleEntries, runtimeErrors };
  }
}

function requestKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${safeUrl(url)}`;
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function isLifecycleRequestFailure(message: string): boolean {
  return /ERR_ABORTED|ERR_CANCELED|ERR_CANCELLED|ERR_ABORT/i.test(message);
}
