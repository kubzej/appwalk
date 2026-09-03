const WEB_PROTOCOLS = new Set(["http:", "https:"]);

/** Returns true only for absolute web URLs that Playwright can navigate to. */
export function isValidWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return WEB_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function assertValidWebUrl(value: unknown, label = "URL"): asserts value is string {
  if (!isValidWebUrl(value)) {
    throw new Error(`${label} must be a valid absolute http or https URL.`);
  }
}
