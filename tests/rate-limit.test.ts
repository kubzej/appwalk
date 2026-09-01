import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitCoordinator, rateLimitRetryDelayMs } from "../src/providers/rate-limit.js";

const SAFETY_MARGIN_MS = 3_000;

test("rateLimitRetryDelayMs waits past the reported reset by a safety margin, not to the millisecond", () => {
  const headers = new Headers({ "x-ratelimit-reset-tokens": "5s" });
  const before = Date.now();
  const waitMs = rateLimitRetryDelayMs(headers);
  const elapsed = Date.now() - before;

  // The header says 5s until reset; a bare "wait exactly until reset" would return ~5000ms.
  // We expect at least the safety margin added on top.
  assert.ok(waitMs >= 5_000 + SAFETY_MARGIN_MS - elapsed - 50, `expected a safety margin on top of the reported reset, got ${waitMs}ms`);
});

test("rateLimitRetryDelayMs never returns less than the safety margin, even for a reset already in the past", () => {
  const headers = new Headers({ "x-ratelimit-reset-tokens": "0s" });
  const waitMs = rateLimitRetryDelayMs(headers);
  assert.ok(waitMs >= SAFETY_MARGIN_MS, `expected at least the safety margin, got ${waitMs}ms`);
});

test("rateLimitRetryDelayMs falls back to a fixed delay when the response has no reset headers", () => {
  const waitMs = rateLimitRetryDelayMs(new Headers(), 7_000);
  assert.equal(waitMs, 7_000);
});

test("RateLimitCoordinator.retryDelayMs falls back when there is no prior observation for the key", () => {
  const coordinator = new RateLimitCoordinator();
  assert.equal(coordinator.retryDelayMs("openai:test-model", 4_000), 4_000);
});

test("RateLimitCoordinator.retryDelayMs uses the last-observed reset with the same safety margin", () => {
  const coordinator = new RateLimitCoordinator();
  coordinator.observe("gemini:test-model", new Headers({ "x-ratelimit-reset-tokens": "10s" }));
  const waitMs = coordinator.retryDelayMs("gemini:test-model");
  assert.ok(waitMs >= 10_000 + SAFETY_MARGIN_MS - 100, `expected a safety margin on top of the observed reset, got ${waitMs}ms`);
});
