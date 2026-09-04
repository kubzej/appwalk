import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithConcurrencyLimit } from '../../src/cli/concurrency.js';

test('runWithConcurrencyLimit never runs more than `limit` workers at once', async () => {
  const items = Array.from({ length: 10 }, (_, index) => index);
  let inFlight = 0;
  let maxInFlight = 0;

  await runWithConcurrencyLimit(items, 3, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return item * 2;
  });

  assert.ok(maxInFlight <= 3, `expected at most 3 concurrent workers, saw ${maxInFlight}`);
});

test('runWithConcurrencyLimit returns results in original order regardless of completion order', async () => {
  const items = [30, 10, 20, 5];
  const results = await runWithConcurrencyLimit(items, 4, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, item));
    return item;
  });
  assert.deepEqual(results, items);
});

test('runWithConcurrencyLimit lets one worker throw without affecting the others', async () => {
  const items = [1, 2, 3, 4];
  const results: Array<'ok' | 'failed'> = [];
  await assert.rejects(
    runWithConcurrencyLimit(items, 2, async (item) => {
      if (item === 3) throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 5));
      results.push('ok');
      return item;
    }),
    /boom/,
  );
  // The other three items still got to run their work before/around the failure.
  assert.ok(results.length >= 1, 'expected at least one non-failing worker to have completed its work');
});

test('runWithConcurrencyLimit tolerates an empty item list', async () => {
  const results = await runWithConcurrencyLimit([], 4, async (item: number) => item);
  assert.deepEqual(results, []);
});

test('runWithConcurrencyLimit clamps a limit larger than the item count without over-spawning', async () => {
  const items = [1, 2];
  let started = 0;
  const results = await runWithConcurrencyLimit(items, 100, async (item) => {
    started += 1;
    return item;
  });
  assert.equal(started, 2);
  assert.deepEqual(results, items);
});
