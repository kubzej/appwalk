const ROLE_PATTERN = /^role=([a-z]+)\[name="([^"]*)"\](?:\s*>>\s*nth=(\d+))?$/i;
const TEXT_EXACT_PATTERN = /^text="([^"]*)"$/;
const TEXT_REGEX_PATTERN = /^text=\/(.+)\/([a-z]*)$/;

export function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Turns one of our internal Playwright locator strings into readable generated-test source. */
export function toLocatorExpression(locator: string): string {
  const frameSeparator = locator.indexOf(" >> ");
  if (locator.startsWith("frame=") && frameSeparator > "frame=".length) {
    const frameSelector = locator.slice("frame=".length, frameSeparator);
    const innerLocator = locator.slice(frameSeparator + " >> ".length);
    return toLocatorExpressionFromRoot(innerLocator, `page.frameLocator('${escapeJsString(frameSelector)}')`);
  }
  return toLocatorExpressionFromRoot(locator, "page");
}

function toLocatorExpressionFromRoot(locator: string, root: string): string {
  const roleMatch = locator.match(ROLE_PATTERN);
  if (roleMatch) {
    const [, role, name, nth] = roleMatch;
    let expr = `${root}.getByRole('${role}', { name: '${escapeJsString(name!)}' })`;
    if (nth !== undefined) expr += `.nth(${nth})`;
    return expr;
  }

  const textExactMatch = locator.match(TEXT_EXACT_PATTERN);
  if (textExactMatch) {
    return `${root}.getByText('${escapeJsString(textExactMatch[1]!)}', { exact: true })`;
  }

  const textRegexMatch = locator.match(TEXT_REGEX_PATTERN);
  if (textRegexMatch) {
    return `${root}.getByText(/${textRegexMatch[1]}/${textRegexMatch[2]})`;
  }

  // Not a shape we constrain the agent to (e.g. a raw [data-test="..."] fallback) — pass through as-is.
  return `${root}.locator('${escapeJsString(locator)}')`;
}
