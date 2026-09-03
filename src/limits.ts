/** Maximum number of repetitions a single burst may execute. */
export const BURST_MIN_COUNT = 1;
export const BURST_MAX_COUNT = 20;

export function isValidBurstCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= BURST_MIN_COUNT && value <= BURST_MAX_COUNT;
}

export function assertValidBurstCount(value: unknown, prefix = "burst"): asserts value is number {
  if (!isValidBurstCount(value)) {
    throw new Error(`${prefix}: count must be a safe integer between ${BURST_MIN_COUNT} and ${BURST_MAX_COUNT}.`);
  }
}
