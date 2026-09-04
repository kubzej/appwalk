export interface RateLimitState {
  limitTokens?: number;
  remainingTokens?: number;
  resetAt?: number;
  /** Separate from the token window — a request-count limit (e.g. RPM) can be hit even while
   * plenty of token budget remains, and OpenAI/Anthropic report it via its own headers. */
  remainingRequests?: number;
  requestsResetAt?: number;
}

export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

import type { Logger } from '../logging/logger.js';

interface TrackedRateLimit extends RateLimitState {
  /** Estimated cost of requests `acquire()` has already admitted but that haven't been
   * reconciled by `observe()` yet (via a release) — accounts for concurrent siblings the server
   * hasn't told us about. Survives `observe()` replacing the rest of this record. */
  reservedTokens: number;
  reservedRequests: number;
}

function emptyState(): TrackedRateLimit {
  return { reservedTokens: 0, reservedRequests: 0 };
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
    total += amount * (unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000);
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Operation was cancelled.'));
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal?.reason ?? new Error('Operation was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long to wait before retrying a request that just got a 429, based on the reset headers of
 * that same response — not the coordinator's stored state, which a fresh persona's first request
 * never populated. Falls back to a fixed delay when the provider didn't send reset headers.
 *
 * Waits past the reported reset instant by a fixed safety margin rather than landing on it to the
 * millisecond — the provider's clock, our clock, and the network round-trip are never perfectly
 * aligned, and retrying a few seconds early just buys back another 429 and another full wait.
 */
const RATE_LIMIT_RETRY_SAFETY_MARGIN_MS = 3_000;

export function rateLimitRetryDelayMs(headers: Headers, fallbackMs = 5_000): number {
  const tokenResetAt = headerResetAt(
    headers,
    'x-ratelimit-reset-project-tokens',
    'x-ratelimit-reset-tokens',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
  );
  const requestResetAt = headerResetAt(headers, 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset');
  const resets = [tokenResetAt, requestResetAt].filter((value): value is number => value !== undefined);
  if (resets.length === 0) return Math.min(fallbackMs, MAX_RATE_LIMIT_WAIT_MS);
  return Math.min(
    Math.max(Math.max(...resets) - Date.now() + RATE_LIMIT_RETRY_SAFETY_MARGIN_MS, RATE_LIMIT_RETRY_SAFETY_MARGIN_MS),
    MAX_RATE_LIMIT_WAIT_MS,
  );
}

/**
 * Coordinates requests that share an account/project quota, safely across concurrent callers.
 * It never retries a failed request; it only uses a successful response's headers, plus its own
 * reservation ledger for requests it has admitted but not yet seen a response for, to avoid
 * knowingly sending a request that cannot fit in the current token/request window.
 */
export class RateLimitCoordinator {
  private readonly states = new Map<string, TrackedRateLimit>();

  /**
   * Waits (if necessary) until `estimatedTokens` plus one request fit in the tracked window,
   * then reserves that budget and returns a release function the caller must invoke exactly
   * once — on success, failure, or retry — once the attempt is done with it.
   *
   * Safe under concurrency without a lock: the read-then-reserve section below never awaits, and
   * Node runs one synchronous chunk at a time, so no two concurrent callers can both observe the
   * same headroom and both reserve it. A waiter that wakes up re-validates from scratch rather
   * than assuming its computed wait was sufficient, since a concurrent sibling may have consumed
   * the freshly available budget first.
   */
  async acquire(key: string, estimatedTokens: number, logger?: Logger, signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      let state = this.states.get(key);
      if (!state) {
        state = emptyState();
        this.states.set(key, state);
      }

      const now = Date.now();

      // Tokens and requests are independent windows with their own remaining count and reset
      // time; a stale window (reset time already passed) is dropped rather than treated as still
      // exhausted, since the provider would have refilled it by now.
      if (state.resetAt !== undefined && state.resetAt <= now) {
        state.remainingTokens = undefined;
        state.resetAt = undefined;
      }
      if (state.requestsResetAt !== undefined && state.requestsResetAt <= now) {
        state.remainingRequests = undefined;
        state.requestsResetAt = undefined;
      }

      let waitMs: number | undefined;
      let reason: 'token' | 'request' | undefined;

      if (state.remainingTokens !== undefined && state.resetAt !== undefined) {
        // `estimatedTokens` is the caller's job to size correctly — for a Responses-style API
        // whose wire body omits server-reconstructed history, the caller (which owns that one
        // conversation) is the only one who knows to inflate it. A per-key heuristic here would
        // be wrong under concurrency: this key is shared by every persona using the same
        // provider/model, so "the last observed size" would reflect whichever concurrent
        // sibling's response happened to land most recently, not this request's own conversation.
        const available = state.remainingTokens - state.reservedTokens;
        if (available < estimatedTokens) {
          waitMs = state.resetAt - now + 100;
          reason = 'token';
        }
      }

      if (state.remainingRequests !== undefined && state.requestsResetAt !== undefined) {
        const availableRequests = state.remainingRequests - state.reservedRequests;
        if (availableRequests < 1) {
          const requestWaitMs = state.requestsResetAt - now + 100;
          if (waitMs === undefined || requestWaitMs > waitMs) {
            waitMs = requestWaitMs;
            reason = 'request';
          }
        }
      }

      if (waitMs === undefined || reason === undefined) {
        // Admit: reserve synchronously, before returning control to the caller (and definitely
        // before any other async work runs), so no concurrent acquire() can double-spend this
        // headroom.
        state.reservedTokens += estimatedTokens;
        state.reservedRequests += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          // Re-fetch rather than close over `state` — observe() may have replaced this key's
          // record since this reservation was made, and the decrement must land on whichever
          // record is current or the two would drift out of sync.
          const current = this.states.get(key);
          if (!current) return;
          current.reservedTokens = Math.max(0, current.reservedTokens - estimatedTokens);
          current.reservedRequests = Math.max(0, current.reservedRequests - 1);
        };
      }

      if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
        throw new Error(
          `Provider rate-limit wait of ${Math.ceil(waitMs / 1000)}s exceeds the ${Math.ceil(MAX_RATE_LIMIT_WAIT_MS / 1000)}s safety limit.`,
        );
      }

      logger?.warn(`API quota reached (${reason} limit). Waiting ${Math.ceil(waitMs / 1000)}s before continuing.`);
      logger?.debug('provider.rate_limit_wait', 'Waiting for the provider rate-limit window to reset', {
        key,
        reason,
        remainingTokens: state.remainingTokens,
        remainingRequests: state.remainingRequests,
        reservedTokens: state.reservedTokens,
        reservedRequests: state.reservedRequests,
        estimatedTokens,
        waitMs,
      });
      await sleep(waitMs, signal);
      // Loop back and re-check from scratch instead of assuming the window is now clear — a
      // concurrent sibling may have been admitted first and already spent the newly freed budget.
    }
  }

  /**
   * Same idea as rateLimitRetryDelayMs, but from our own last-observed state instead of the
   * failed response's headers — for a provider SDK (Gemini's) whose thrown error doesn't expose
   * the response headers at all. Falls back to a fixed delay when we have no prior observation
   * for this key either, e.g. the very first request of a run.
   */
  retryDelayMs(key: string, fallbackMs = 5_000): number {
    const state = this.states.get(key);
    if (!state) return fallbackMs;
    const resets = [state.resetAt, state.requestsResetAt].filter((value): value is number => value !== undefined);
    if (resets.length === 0) return Math.min(fallbackMs, MAX_RATE_LIMIT_WAIT_MS);
    return Math.min(
      Math.max(Math.max(...resets) - Date.now() + RATE_LIMIT_RETRY_SAFETY_MARGIN_MS, RATE_LIMIT_RETRY_SAFETY_MARGIN_MS),
      MAX_RATE_LIMIT_WAIT_MS,
    );
  }

  observe(key: string, headers: Headers): void {
    const remainingTokens = headerNumber(
      headers,
      'x-ratelimit-remaining-project-tokens',
      'x-ratelimit-remaining-tokens',
      'anthropic-ratelimit-tokens-remaining',
      'anthropic-ratelimit-input-tokens-remaining',
    );
    const limitTokens = headerNumber(
      headers,
      'x-ratelimit-limit-project-tokens',
      'x-ratelimit-limit-tokens',
      'anthropic-ratelimit-tokens-limit',
      'anthropic-ratelimit-input-tokens-limit',
    );
    const resetAt = headerResetAt(
      headers,
      'x-ratelimit-reset-project-tokens',
      'x-ratelimit-reset-tokens',
      'anthropic-ratelimit-tokens-reset',
      'anthropic-ratelimit-input-tokens-reset',
    );
    const remainingRequests = headerNumber(
      headers,
      'x-ratelimit-remaining-requests',
      'anthropic-ratelimit-requests-remaining',
    );
    const requestsResetAt = headerResetAt(headers, 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset');
    if (
      remainingTokens === undefined &&
      limitTokens === undefined &&
      resetAt === undefined &&
      remainingRequests === undefined &&
      requestsResetAt === undefined
    )
      return;

    const previous = this.states.get(key);
    this.states.set(key, {
      limitTokens,
      remainingTokens,
      resetAt: resetAt ?? previous?.resetAt,
      remainingRequests,
      requestsResetAt: requestsResetAt ?? previous?.requestsResetAt,
      // Carried forward, not reset — these track requests acquire() admitted that haven't been
      // released yet, which this fresh header snapshot knows nothing about.
      reservedTokens: previous?.reservedTokens ?? 0,
      reservedRequests: previous?.reservedRequests ?? 0,
    });
  }
}

export const sharedRateLimitCoordinator = new RateLimitCoordinator();

export function estimateRequestTokens(value: unknown, maxOutputTokens: number): number {
  return Math.ceil(JSON.stringify(value).length / 4) + maxOutputTokens;
}

export function rateLimitHeadersSummary(headers: Headers): string {
  const remaining =
    headers.get('x-ratelimit-remaining-project-tokens') ??
    headers.get('x-ratelimit-remaining-tokens') ??
    headers.get('anthropic-ratelimit-tokens-remaining') ??
    headers.get('anthropic-ratelimit-input-tokens-remaining');
  const reset =
    headers.get('x-ratelimit-reset-project-tokens') ??
    headers.get('x-ratelimit-reset-tokens') ??
    headers.get('anthropic-ratelimit-tokens-reset') ??
    headers.get('anthropic-ratelimit-input-tokens-reset');
  const remainingRequests =
    headers.get('x-ratelimit-remaining-requests') ?? headers.get('anthropic-ratelimit-requests-remaining');
  const requestsReset = headers.get('x-ratelimit-reset-requests') ?? headers.get('anthropic-ratelimit-requests-reset');
  if (!remaining && !reset && !remainingRequests && !requestsReset) return '';
  const resetValue = reset && reset !== '0' && reset !== '0s' ? reset : 'not-provided';
  const requestsResetValue =
    requestsReset && requestsReset !== '0' && requestsReset !== '0s' ? requestsReset : 'not-provided';
  const tokenPart = remaining || reset ? ` remaining=${remaining ?? 'unknown'} reset=${resetValue}` : '';
  const requestPart =
    remainingRequests || requestsReset
      ? ` remainingRequests=${remainingRequests ?? 'unknown'} requestsReset=${requestsResetValue}`
      : '';
  return `${tokenPart}${requestPart}`;
}
