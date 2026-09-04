import type { FrameLocator, Locator, Page } from 'playwright';

type LocatorRoot = Page | FrameLocator;

/** Same convention as Playwright's own `text=` engine: `"quoted"` or bare matches as a string
 * (getByLabel/getByPlaceholder/getByAltText/getByTitle all do substring matching on a plain
 * string), a `/pattern/flags` value is parsed as a regex. Unlike `text=`, quotes here are purely
 * a convention for the model to follow — getByLabel() etc. don't parse them, so they must be
 * stripped before being passed as the search text, or they'd be searched for literally. */
function parseTextOrRegExp(value: string): string | RegExp {
  const regexMatch = /^\/(.*)\/([a-z]*)$/.exec(value);
  if (regexMatch) return new RegExp(regexMatch[1]!, regexMatch[2]);
  const quotedMatch = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quotedMatch ? quotedMatch[1]! : value;
}

/** `label=`, `placeholder=`, `alt=`, and `title=` have no raw CSS/string-selector engine in
 * Playwright — unlike `role=` and `text=`, they only exist as Locator methods (getByLabel,
 * getByPlaceholder, getByAltText, getByTitle). Appwalk maps its own prefixes onto those calls so
 * a form field that role/text can't cleanly match (the reason src/browser/login.ts falls back to
 * getByLabel internally) is reachable from every tool, not just the login helper. */
function resolveOnRoot(root: LocatorRoot, locator: string): Locator {
  if (locator.startsWith('label=')) return root.getByLabel(parseTextOrRegExp(locator.slice('label='.length)));
  if (locator.startsWith('placeholder='))
    return root.getByPlaceholder(parseTextOrRegExp(locator.slice('placeholder='.length)));
  if (locator.startsWith('alt=')) return root.getByAltText(parseTextOrRegExp(locator.slice('alt='.length)));
  if (locator.startsWith('title=')) return root.getByTitle(parseTextOrRegExp(locator.slice('title='.length)));
  return root.locator(locator);
}

/** Resolves Appwalk's locator syntax, including an optional iframe prefix. */
export function resolveLocator(page: Page, locator: string): Locator {
  const separator = locator.indexOf(' >> ');
  if (locator.startsWith('frame=') && separator > 'frame='.length) {
    const frameSelector = locator.slice('frame='.length, separator);
    const innerLocator = locator.slice(separator + ' >> '.length);
    return resolveOnRoot(page.frameLocator(frameSelector), innerLocator);
  }
  return resolveOnRoot(page, locator);
}
