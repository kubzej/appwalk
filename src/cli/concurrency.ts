/**
 * Runs `worker` over `items` with at most `limit` calls in flight at once, preserving result
 * order regardless of completion order. A pool of `limit` loops pulls from one shared cursor;
 * the pop-then-increment has no `await` in it, so — same reasoning as the rate-limit ledger in
 * `providers/rate-limit.ts` — concurrent pulls can't race even without a lock.
 *
 * `worker` is responsible for its own error handling: a rejection here propagates through
 * `Promise.all` and stops the whole run, exactly as an unguarded loop body would.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  async function runSlot(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => runSlot()));
  return results;
}
