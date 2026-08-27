export interface RateLimitState {
  limitTokens?: number;
  remainingTokens?: number;
  resetAt?: number;
  /** Separate from the token window — a request-count limit (e.g. RPM) can be hit even while
   * plenty of token budget remains, and OpenAI/Anthropic report it via its own headers. */
  remainingRequests?: number;
  requestsResetAt?: number;
}

import type { Logger } from "../logging/logger.js";

interface TrackedRateLimit extends RateLimitState {
  lastObservedInputTokens?: number;
}

function parseDurationMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric * 1000;

  let total = 0;
  let matched = false;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return matched ? total : undefined;
}

function parseResetAt(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const durationMs = parseDurationMs(trimmed);
  if (durationMs !== undefined) return Date.now() + durationMs;
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function headerNumber(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (!value) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function headerResetAt(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const parsed = parseResetAt(headers.get(name));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coordinates sequential requests that share an account/project quota. It never retries a
 * failed request; it only uses a successful response's headers to avoid knowingly sending a
 * request that cannot fit in the current token window.
 */
export class RateLimitCoordinator {
  private readonly states = new Map<string, TrackedRateLimit>();

  async beforeRequest(key: string, estimatedTokens: number, logger?: Logger): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;

    const now = Date.now();

    // Tokens and requests are independent windows with their own remaining count and reset
    // time; a stale window (reset time already passed) is dropped rather than treated as still
    // exhausted, since the provider would have refilled it by now.
    let waitMs: number | undefined;
    let reason: "token" | "request" | undefined;

    if (state.remainingTokens !== undefined && state.resetAt !== undefined) {
      if (state.resetAt <= now) {
        state.remainingTokens = undefined;
        state.resetAt = undefined;
      } else {
        // Include the last observed request size because Responses-style APIs may account for
        // server-side conversation history that is not present in the next request body.
        const expected = Math.max(
          estimatedTokens,
          state.lastObservedInputTokens === undefined ? 0 : Math.ceil(state.lastObservedInputTokens * 1.5),
        );
        if (state.remainingTokens < expected) {
          waitMs = state.resetAt - now + 100;
          reason = "token";
        }
      }
    }

    if (state.remainingRequests !== undefined && state.requestsResetAt !== undefined) {
      if (state.requestsResetAt <= now) {
        state.remainingRequests = undefined;
        state.requestsResetAt = undefined;
      } else if (state.remainingRequests < 1) {
        const requestWaitMs = state.requestsResetAt - now + 100;
        if (waitMs === undefined || requestWaitMs > waitMs) {
          waitMs = requestWaitMs;
          reason = "request";
        }
      }
    }

    if (waitMs === undefined || reason === undefined) {
      if (state.remainingTokens === undefined && state.remainingRequests === undefined) this.states.delete(key);
      return;
    }

    logger?.warn(`API quota reached (${reason} limit). Waiting ${Math.ceil(waitMs / 1000)}s before continuing.`);
    logger?.debug("provider.rate_limit_wait", "Waiting for the provider rate-limit window to reset", {
      key, reason, remainingTokens: state.remainingTokens, remainingRequests: state.remainingRequests, estimatedTokens, waitMs,
    });
    await sleep(waitMs);
    // Only the dimension that actually triggered the wait is cleared — the other window's last
    // observed counters are still valid until its own reset time.
    if (reason === "token") {
      state.remainingTokens = undefined;
      state.resetAt = undefined;
    } else {
      state.remainingRequests = undefined;
      state.requestsResetAt = undefined;
    }
  }

  observe(key: string, headers: Headers, inputTokens?: number): void {
    const remainingTokens = headerNumber(
      headers,
      "x-ratelimit-remaining-project-tokens",
      "x-ratelimit-remaining-tokens",
      "anthropic-ratelimit-tokens-remaining",
      "anthropic-ratelimit-input-tokens-remaining",
    );
    const limitTokens = headerNumber(
      headers,
      "x-ratelimit-limit-project-tokens",
      "x-ratelimit-limit-tokens",
      "anthropic-ratelimit-tokens-limit",
      "anthropic-ratelimit-input-tokens-limit",
    );
    const resetAt = headerResetAt(
      headers,
      "x-ratelimit-reset-project-tokens",
      "x-ratelimit-reset-tokens",
      "anthropic-ratelimit-tokens-reset",
      "anthropic-ratelimit-input-tokens-reset",
    );
    const remainingRequests = headerNumber(headers, "x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining");
    const requestsResetAt = headerResetAt(headers, "x-ratelimit-reset-requests", "anthropic-ratelimit-requests-reset");
    if (
      remainingTokens === undefined && limitTokens === undefined && resetAt === undefined &&
      remainingRequests === undefined && requestsResetAt === undefined
    ) return;

    const previous = this.states.get(key);
    this.states.set(key, {
      limitTokens,
      remainingTokens,
      resetAt: resetAt ?? previous?.resetAt,
      remainingRequests,
      requestsResetAt: requestsResetAt ?? previous?.requestsResetAt,
      lastObservedInputTokens: inputTokens ?? previous?.lastObservedInputTokens,
    });
  }
}

export const sharedRateLimitCoordinator = new RateLimitCoordinator();

export function estimateRequestTokens(value: unknown, maxOutputTokens: number): number {
  return Math.ceil(JSON.stringify(value).length / 4) + maxOutputTokens;
}

export function rateLimitHeadersSummary(headers: Headers): string {
  const remaining = headers.get("x-ratelimit-remaining-project-tokens")
    ?? headers.get("x-ratelimit-remaining-tokens")
    ?? headers.get("anthropic-ratelimit-tokens-remaining")
    ?? headers.get("anthropic-ratelimit-input-tokens-remaining");
  const reset = headers.get("x-ratelimit-reset-project-tokens")
    ?? headers.get("x-ratelimit-reset-tokens")
    ?? headers.get("anthropic-ratelimit-tokens-reset")
    ?? headers.get("anthropic-ratelimit-input-tokens-reset");
  const remainingRequests = headers.get("x-ratelimit-remaining-requests") ?? headers.get("anthropic-ratelimit-requests-remaining");
  const requestsReset = headers.get("x-ratelimit-reset-requests") ?? headers.get("anthropic-ratelimit-requests-reset");
  if (!remaining && !reset && !remainingRequests && !requestsReset) return "";
  const resetValue = reset && reset !== "0" && reset !== "0s" ? reset : "not-provided";
  const requestsResetValue = requestsReset && requestsReset !== "0" && requestsReset !== "0s" ? requestsReset : "not-provided";
  const tokenPart = remaining || reset ? ` remaining=${remaining ?? "unknown"} reset=${resetValue}` : "";
  const requestPart = remainingRequests || requestsReset ? ` remainingRequests=${remainingRequests ?? "unknown"} requestsReset=${requestsResetValue}` : "";
  return `${tokenPart}${requestPart}`;
}
