import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RATE_LIMIT_WAIT_MS, RateLimitCoordinator, rateLimitRetryDelayMs } from '../../src/providers/rate-limit.js';

const SAFETY_MARGIN_MS = 3_000;

test('rateLimitRetryDelayMs waits past the reported reset by a safety margin, not to the millisecond', () => {
  const headers = new Headers({ 'x-ratelimit-reset-tokens': '5s' });
  const before = Date.now();
  const waitMs = rateLimitRetryDelayMs(headers);
  const elapsed = Date.now() - before;

  // The header says 5s until reset; a bare "wait exactly until reset" would return ~5000ms.
  // We expect at least the safety margin added on top.
  assert.ok(
    waitMs >= 5_000 + SAFETY_MARGIN_MS - elapsed - 50,
    `expected a safety margin on top of the reported reset, got ${waitMs}ms`,
  );
});

test('rateLimitRetryDelayMs never returns less than the safety margin, even for a reset already in the past', () => {
  const headers = new Headers({ 'x-ratelimit-reset-tokens': '0s' });
  const waitMs = rateLimitRetryDelayMs(headers);
  assert.ok(waitMs >= SAFETY_MARGIN_MS, `expected at least the safety margin, got ${waitMs}ms`);
});

test('rateLimitRetryDelayMs falls back to a fixed delay when the response has no reset headers', () => {
  const waitMs = rateLimitRetryDelayMs(new Headers(), 7_000);
  assert.equal(waitMs, 7_000);
});

test('RateLimitCoordinator.retryDelayMs falls back when there is no prior observation for the key', () => {
  const coordinator = new RateLimitCoordinator();
  assert.equal(coordinator.retryDelayMs('openai:test-model', 4_000), 4_000);
});

test('RateLimitCoordinator.retryDelayMs uses the last-observed reset with the same safety margin', () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe('gemini:test-model', new Headers({ 'x-ratelimit-reset-tokens': '10s' }));
  const waitMs = coordinator.retryDelayMs('gemini:test-model');
  assert.ok(
    waitMs >= 10_000 + SAFETY_MARGIN_MS - 100,
    `expected a safety margin on top of the observed reset, got ${waitMs}ms`,
  );
});

test('rate-limit retry delays are capped at the shared safety limit', () => {
  const waitMs = rateLimitRetryDelayMs(new Headers({ 'x-ratelimit-reset-tokens': '2h' }));
  assert.equal(waitMs, MAX_RATE_LIMIT_WAIT_MS);
});

test('RateLimitCoordinator rejects a stored window that would make the run wait too long', async () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe(
    'provider:model',
    new Headers({
      'x-ratelimit-remaining-tokens': '0',
      'x-ratelimit-reset-tokens': '2h',
    }),
  );
  await assert.rejects(coordinator.acquire('provider:model', 1), /exceeds the 60s safety limit/);
});

/**
 * Starts an acquire() that we expect to block, waits briefly to confirm it really is pending
 * (not just not-yet-scheduled), then aborts it so the test doesn't sit through a real multi-second
 * rate-limit wait. The rejection from aborting is expected and swallowed.
 */
async function expectBlocked(coordinator: RateLimitCoordinator, key: string, estimatedTokens: number): Promise<void> {
  const controller = new AbortController();
  let resolved = false;
  const pending = coordinator
    .acquire(key, estimatedTokens, undefined, controller.signal)
    .then(() => {
      resolved = true;
    })
    .catch(() => {
      // Expected once we abort below.
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'expected this acquire() to still be blocked');
  controller.abort(new Error('test cleanup'));
  await pending;
}

test('acquire() reserves budget so a concurrent sibling sees it as spent, not just what the last response reported', async () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe(
    'provider:model',
    new Headers({
      'x-ratelimit-remaining-tokens': '100',
      'x-ratelimit-reset-tokens': '5s',
    }),
  );

  // First caller reserves 80 of the 100 known-remaining tokens and does not release yet —
  // simulating a request still in flight.
  const release = await coordinator.acquire('provider:model', 80);

  // A concurrent sibling asking for 50 more would blow the real budget (80 + 50 > 100). Without
  // reservation accounting it would see the stale "100 remaining" and proceed anyway; with
  // reservation accounting it must wait instead of returning immediately.
  await expectBlocked(coordinator, 'provider:model', 50);

  // Releasing the first reservation and reporting a fresh, larger remaining count (as if the
  // first request's response had just come back) must free that budget for a fresh request.
  release();
  coordinator.observe(
    'provider:model',
    new Headers({
      'x-ratelimit-remaining-tokens': '90',
      'x-ratelimit-reset-tokens': '5s',
    }),
  );
  const afterRelease = await coordinator.acquire('provider:model', 50);
  afterRelease();
});

test('a released reservation frees its budget even when the request that made it never observed a response', async () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe(
    'provider:model',
    new Headers({
      'x-ratelimit-remaining-tokens': '10',
      'x-ratelimit-reset-tokens': '5s',
    }),
  );

  const release = await coordinator.acquire('provider:model', 10);
  await expectBlocked(coordinator, 'provider:model', 10);

  // The first attempt failed outright (no observe() call) — release() alone, with no fresh
  // header data, must still be enough to let a fresh request in.
  release();
  const afterRelease = await coordinator.acquire('provider:model', 10);
  afterRelease();
});

test('calling one release() twice does not wipe out a still-outstanding sibling reservation', async () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe(
    'provider:model',
    new Headers({
      'x-ratelimit-remaining-tokens': '20',
      'x-ratelimit-reset-tokens': '5s',
    }),
  );
  const releaseA = await coordinator.acquire('provider:model', 10);
  const releaseB = await coordinator.acquire('provider:model', 10);
  releaseA();
  releaseA(); // must be a no-op — a naive unconditional decrement would double-subtract here

  // Only 10 of the 20 tokens should read as free (B is still reserved); a third request for 20
  // must still have to wait rather than being wrongly admitted because A's release was applied twice.
  await expectBlocked(coordinator, 'provider:model', 20);
  releaseB();
});
