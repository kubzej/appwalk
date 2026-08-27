const ROLE_PATTERN = /^role=([a-z]+)\[name="([^"]*)"\](?:\s*>>\s*nth=(\d+))?$/i;
const TEXT_EXACT_PATTERN = /^text="([^"]*)"$/;
const TEXT_REGEX_PATTERN = /^text=\/(.+)\/([a-z]*)$/;

export function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Turns one of our internal Playwright locator strings into readable generated-test source — getByRole/getByText where we recognize the shape, a raw page.locator(...) fallback otherwise. */
export function toLocatorExpression(locator: string): string {
  const roleMatch = locator.match(ROLE_PATTERN);
  if (roleMatch) {
    const [, role, name, nth] = roleMatch;
    let expr = `page.getByRole('${role}', { name: '${escapeJsString(name!)}' })`;
    if (nth !== undefined) expr += `.nth(${nth})`;
    return expr;
  }

  const textExactMatch = locator.match(TEXT_EXACT_PATTERN);
  if (textExactMatch) {
    return `page.getByText('${escapeJsString(textExactMatch[1]!)}', { exact: true })`;
  }

  const textRegexMatch = locator.match(TEXT_REGEX_PATTERN);
  if (textRegexMatch) {
    return `page.getByText(/${textRegexMatch[1]}/${textRegexMatch[2]})`;
  }

  // Not a shape we constrain the agent to (e.g. a raw [data-test="..."] fallback) — pass through as-is.
  return `page.locator('${escapeJsString(locator)}')`;
}
