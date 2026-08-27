import type { Locator, Page } from "playwright";

/** Resolves Appwalk's locator syntax, including an optional iframe prefix. */
export function resolveLocator(page: Page, locator: string): Locator {
  const separator = locator.indexOf(" >> ");
  if (locator.startsWith("frame=") && separator > "frame=".length) {
    const frameSelector = locator.slice("frame=".length, separator);
    const innerLocator = locator.slice(separator + " >> ".length);
    return page.frameLocator(frameSelector).locator(innerLocator);
  }
  return page.locator(locator);
}
