import type { Logger } from '../logging/logger.js';
import { MAX_RATE_LIMIT_WAIT_MS, sleep } from './rate-limit.js';

export const HOSTED_PROVIDER_REQUEST_TIMEOUT_MS = 60_000;
export const HOSTED_PROVIDER_MAX_RETRIES = 2;
export const HOSTED_PROVIDER_TOTAL_TIMEOUT_MS = HOSTED_PROVIDER_REQUEST_TIMEOUT_MS * (HOSTED_PROVIDER_MAX_RETRIES + 1);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ProviderRequestFailure {
  provider: string;
  model: string;
  requestIndex: number;
  attempt: number;
  status?: number;
  headers?: Headers;
  retryable: boolean;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly failure: ProviderRequestFailure,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderRequestError';
  }

  get status(): number | undefined {
    return this.failure.status;
  }
}

export function providerHttpError(
  provider: string,
  model: string,
  requestIndex: number,
  status: number,
  body: string,
  headers?: Headers,
): ProviderRequestError {
  const detail = body.trim();
  return new ProviderRequestError(`${provider} request failed: ${status}${detail ? ` ${detail}` : ''}`, {
    provider,
    model,
    requestIndex,
    attempt: 0,
    status,
    retryable: RETRYABLE_STATUSES.has(status),
    headers,
  });
}

export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

export function providerHeaders(error: unknown): Headers | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const failureHeaders = (error as { failure?: { headers?: unknown } }).failure?.headers;
  if (failureHeaders instanceof Headers) return failureHeaders;
  const headers = (error as { headers?: unknown }).headers;
  return headers instanceof Headers ? headers : undefined;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (typeof code === 'string' && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(code)) ||
    /fetch failed|network|socket|timed? ?out|connection/i.test(message)
  );
}

function isRetryable(error: unknown, timedOut: boolean): boolean {
  if (timedOut || isNetworkError(error)) return true;
  const status = providerStatus(error);
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AttemptSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

function createAttemptSignal(externalSignal: AbortSignal | undefined, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Provider request timed out.'));
  }, timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

export async function withHostedProviderRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    provider: string;
    model: string;
    requestIndex: number;
    signal?: AbortSignal;
    logger?: Logger;
    /** Wait for account/project quota before each attempt. */
    beforeAttempt?: (signal: AbortSignal | undefined) => Promise<void>;
    /** Provider-specific 429 delay. Other retryable failures use bounded backoff. */
    retryDelayMs?: (error: unknown, attempt: number) => number | undefined;
  },
): Promise<T> {
  const deadline = Date.now() + HOSTED_PROVIDER_TOTAL_TIMEOUT_MS;

  for (let attempt = 0; attempt <= HOSTED_PROVIDER_MAX_RETRIES; attempt++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ProviderRequestError(
        `${options.provider} request exceeded the ${HOSTED_PROVIDER_TOTAL_TIMEOUT_MS}ms total deadline.`,
        {
          provider: options.provider,
          model: options.model,
          requestIndex: options.requestIndex,
          attempt,
          retryable: false,
        },
      );
    }
    let attemptSignal: AttemptSignal | undefined;
    try {
      // Quota waiting is bounded separately from the provider request timeout. Otherwise a
      // 60-second rate-limit wait would consume the entire request attempt before fetch starts.
      await options.beforeAttempt?.(options.signal);
      const requestRemainingMs = deadline - Date.now();
      if (requestRemainingMs <= 0) {
        throw new ProviderRequestError(
          `${options.provider} request exceeded its total deadline before the attempt started.`,
          {
            provider: options.provider,
            model: options.model,
            requestIndex: options.requestIndex,
            attempt,
            retryable: false,
          },
        );
      }
      attemptSignal = createAttemptSignal(
        options.signal,
        Math.min(HOSTED_PROVIDER_REQUEST_TIMEOUT_MS, requestRemainingMs),
      );
      // The external signal can abort in the gap between creating this attempt's signal and
      // `operation` attaching its own abort listener — by then the abort event has already fired
      // and a listener added after the fact will never see it, hanging the operation forever. Fail
      // fast here instead of ever invoking `operation` with a signal that's already dead on arrival.
      if (attemptSignal.signal.aborted) {
        throw new Error('Attempt signal was already aborted before the operation started.');
      }
      return await operation(attemptSignal.signal);
    } catch (error) {
      const externallyAborted = options.signal?.aborted === true;
      if (externallyAborted) {
        throw new ProviderRequestError(
          `${options.provider} request was cancelled.`,
          {
            provider: options.provider,
            model: options.model,
            requestIndex: options.requestIndex,
            attempt,
            status: providerStatus(error),
            retryable: false,
          },
          { cause: error },
        );
      }

      const timedOut = attemptSignal?.timedOut() === true;
      const retryable = isRetryable(error, timedOut);
      const failureDetail = timedOut ? `timed out after ${HOSTED_PROVIDER_REQUEST_TIMEOUT_MS}ms` : errorMessage(error);
      if (!retryable || attempt >= HOSTED_PROVIDER_MAX_RETRIES) {
        if (error instanceof ProviderRequestError) {
          throw new ProviderRequestError(
            `${options.provider} request failed after ${attempt + 1} attempt${attempt === 0 ? '' : 's'}: ${failureDetail}`,
            { ...error.failure, attempt, retryable },
            { cause: error },
          );
        }
        throw new ProviderRequestError(
          `${options.provider} request failed after ${attempt + 1} attempt${attempt === 0 ? '' : 's'}: ${failureDetail}`,
          {
            provider: options.provider,
            model: options.model,
            requestIndex: options.requestIndex,
            attempt,
            status: providerStatus(error),
            retryable,
          },
          { cause: error },
        );
      }

      const deadlineRemainingMs = deadline - Date.now();
      // A deliberately requested zero-delay retry (e.g. tests, or a provider that says "retry
      // immediately") is not the same thing as having run out of time before the deadline — only
      // the latter should abandon the retry.
      if (deadlineRemainingMs <= 0) {
        throw new ProviderRequestError(
          `${options.provider} request exceeded its total deadline while preparing a retry.`,
          {
            provider: options.provider,
            model: options.model,
            requestIndex: options.requestIndex,
            attempt,
            status: providerStatus(error),
            retryable,
          },
          { cause: error },
        );
      }
      const requestedWaitMs =
        options.retryDelayMs?.(error, attempt) ?? Math.min(1_000 * 2 ** attempt, MAX_RATE_LIMIT_WAIT_MS);
      const waitMs = Math.min(Math.max(0, requestedWaitMs), MAX_RATE_LIMIT_WAIT_MS, deadlineRemainingMs);
      if (waitMs > 0) {
        options.logger?.warn(
          `${options.provider} request failed transiently; retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 2}/${HOSTED_PROVIDER_MAX_RETRIES + 1}).`,
        );
      }
      options.logger?.debug('provider.retrying', 'Retrying a transient provider request', {
        provider: options.provider,
        model: options.model,
        requestIndex: options.requestIndex,
        attempt,
        waitMs,
        status: providerStatus(error),
        error: errorMessage(error),
      });
      try {
        await sleep(waitMs, options.signal);
      } catch (sleepError) {
        throw new ProviderRequestError(
          `${options.provider} request was cancelled.`,
          {
            provider: options.provider,
            model: options.model,
            requestIndex: options.requestIndex,
            attempt,
            retryable: false,
          },
          { cause: sleepError },
        );
      }
    } finally {
      attemptSignal?.cleanup();
    }
  }

  throw new Error('Unreachable provider retry state.');
}
