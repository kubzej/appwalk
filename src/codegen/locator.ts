const ROLE_PATTERN = /^role=([a-z]+)\[name="([^"]*)"\](?:\s*>>\s*nth=(\d+))?$/i;
const TEXT_EXACT_PATTERN = /^text="([^"]*)"$/;
const TEXT_REGEX_PATTERN = /^text=\/(.+)\/([a-z]*)$/;

export function escapeJsString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Serializes a JSON-compatible value for generated JavaScript, including legacy line terminators. */
export function serializeJsValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot serialize value into generated JavaScript.');
  return serialized.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Turns one of our internal Playwright locator strings into readable generated-test source. */
export function toLocatorExpression(locator: string): string {
  const frameSeparator = locator.indexOf(' >> ');
  if (locator.startsWith('frame=') && frameSeparator > 'frame='.length) {
    const frameSelector = locator.slice('frame='.length, frameSeparator);
    const innerLocator = locator.slice(frameSeparator + ' >> '.length);
    return toLocatorExpressionFromRoot(innerLocator, `page.frameLocator('${escapeJsString(frameSelector)}')`);
  }
  return toLocatorExpressionFromRoot(locator, 'page');
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
    const pattern = textRegexMatch[1]!;
    const flags = textRegexMatch[2]!;
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(
        `Invalid text locator regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return `${root}.getByText(new RegExp(${serializeJsValue(pattern)}, ${serializeJsValue(flags)}))`;
  }

  // Not a shape we constrain the agent to (e.g. a raw [data-test="..."] fallback) — pass through as-is.
  return `${root}.locator('${escapeJsString(locator)}')`;
}
