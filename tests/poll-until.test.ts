import assert from "node:assert/strict";
import test from "node:test";
import { pollUntil } from "../src/agent/tools.js";

test("pollUntil returns immediately when the condition is already met", async () => {
  let reads = 0;
  const started = Date.now();
  const result = await pollUntil(async () => { reads += 1; return "ready"; }, (v) => v === "ready", 1000);
  assert.equal(result, "ready");
  assert.equal(reads, 1);
  assert.ok(Date.now() - started < 100, "must not wait when the first read already satisfies isMet");
});

test("pollUntil retries until a value that only becomes true later", async () => {
  let reads = 0;
  const becomesTrueAt = Date.now() + 250;
  const result = await pollUntil(
    async () => { reads += 1; return Date.now() >= becomesTrueAt; },
    (v) => v === true,
    2000,
  );
  assert.equal(result, true);
  assert.ok(reads > 1, "must have polled more than once to catch the delayed change");
});

test("pollUntil returns the last value, not an error, when the condition never becomes true", async () => {
  const started = Date.now();
  const result = await pollUntil(async () => "still-pending", (v) => v === "done", 300);
  const elapsed = Date.now() - started;
  assert.equal(result, "still-pending");
  assert.ok(elapsed >= 300 && elapsed < 700, `expected to wait out the full timeout, took ${elapsed}ms`);
});

test("pollUntil tolerates a transient error and picks up the value once reads succeed", async () => {
  let attempt = 0;
  const result = await pollUntil(
    async () => {
      attempt += 1;
      if (attempt < 3) throw new Error("element not attached yet");
      return "recovered";
    },
    (v) => v === "recovered",
    2000,
  );
  assert.equal(result, "recovered");
  assert.equal(attempt, 3);
});

test("pollUntil rethrows the last error when every attempt fails", async () => {
  await assert.rejects(
    pollUntil(async () => { throw new Error("locator never resolved"); }, () => true, 300),
    /locator never resolved/,
  );
});
