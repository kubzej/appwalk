import type { ConsoleMessage, Page } from "playwright";
import type { Logger } from "../logging/logger.js";

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

/**
 * Attaches to a page and keeps a running log of network + console activity.
 * - `network`/`consoleLog`: read non-destructively at any time (used by the loop's success heuristic).
 * - `drain()`: a separate, cumulative cursor for per-step evidence capture — the two don't interfere.
 */
export class EvidenceRecorder {
  readonly network: NetworkEntry[] = [];
  readonly consoleLog: ConsoleEntry[] = [];

  private drainedNetwork = 0;
  private drainedConsole = 0;
  private pendingBodyReads: Promise<void>[] = [];

  constructor(page: Page, private readonly logger?: Logger) {
    this.attach(page);
  }

  /** Re-attaches these same listeners to a different page, appending to the same running `network`/
   * `consoleLog` arrays — needed when the active page changes mid-run (a new tab, a reopened browser),
   * since the listeners set up in the constructor are bound to the original page object only. */
  reattach(page: Page): void {
    this.attach(page);
  }

  private attach(page: Page): void {
    page.on("response", (response) => {
      const entry: NetworkEntry = {
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      };
      this.network.push(entry); // pushed synchronously — preserves arrival order

      const contentType = response.headers()["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        const bodyRead = response
          .json()
          .then((body) => {
            entry.body = body; // mutates the already-pushed entry, order unaffected
          })
          .catch(() => {
            // Not actually available (redirected, empty, malformed despite the header) — leave unset.
          });
        this.pendingBodyReads.push(bodyRead);
      }
    });

    page.on("console", (msg: ConsoleMessage) => {
      this.consoleLog.push({ type: msg.type(), text: msg.text() });
      this.logger?.debug("browser.console", "Page console message", { type: msg.type(), text: msg.text() });
    });
    page.on("pageerror", (error) => {
      this.logger?.debug("browser.page_error", "Page JavaScript error", { error: error.message });
    });
    page.on("requestfailed", (request) => {
      this.logger?.debug("browser.request_failed", "Browser request failed", {
        method: request.method(), url: request.url(), error: request.failure()?.errorText,
      });
    });
  }

  /** Waits for any in-flight JSON body reads to settle. Call before relying on `.body` being populated everywhere it can be (e.g. before diffing two runs). */
  async waitForPendingBodies(): Promise<void> {
    await Promise.all(this.pendingBodyReads);
  }

  drain(): { network: NetworkEntry[]; console: ConsoleEntry[] } {
    const network = this.network.slice(this.drainedNetwork);
    const consoleEntries = this.consoleLog.slice(this.drainedConsole);
    this.drainedNetwork = this.network.length;
    this.drainedConsole = this.consoleLog.length;
    return { network, console: consoleEntries };
  }
}
