import type { BrowserContext } from "playwright";
import type { Logger } from "../logging/logger.js";

const DEFAULT_BLOCK_METHODS = ["POST", "DELETE", "PUT", "PATCH"];

export interface SafetyConfig {
  block?: string[];
  allow?: string[];
}

export interface GuardOptions {
  allowDestructive: boolean;
  blockMethods?: string[];
  config?: SafetyConfig;
  logger?: Logger;
  onBlocked?: (request: { method: string; url: string }) => void;
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern
    .split("**")
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
  return new RegExp(`^${segments.join(".*")}$`);
}

function matchesAny(url: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(url));
}

// Registering the same context twice would stack a second, redundant route handler (harmless —
// Playwright always dispatches the most-recently-registered one for an overlapping pattern — but
// wasteful, and every activePage switch calls this since a context switch can't be told apart
// from a same-context one without it). Keyed by context so multiple independent runs/contexts in
// one process never collide.
const guardedContexts = new WeakSet<BrowserContext>();

/** Context-scoped, not page-scoped: a browser context can hold more than one page (a tab opened
 * via openTab, or one the target app opens itself), and `context.route()` — unlike `page.route()`
 * — automatically covers every page already in the context plus every page created in it later. */
export async function installDestructiveActionGuard(
  context: BrowserContext,
  options: GuardOptions,
): Promise<void> {
  if (options.allowDestructive) return;
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);

  const blockMethods = new Set(options.blockMethods ?? DEFAULT_BLOCK_METHODS);
  const { block, allow } = options.config ?? {};

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();

    if (matchesAny(url, allow)) {
      await route.continue();
      return;
    }
    if (matchesAny(url, block) || blockMethods.has(request.method())) {
      options.onBlocked?.({ method: request.method(), url: safePath(url) });
      options.logger?.verbose(`      Blocked destructive request: ${request.method()} ${safePath(url)}`);
      options.logger?.debug("safety.request_blocked", "Destructive request blocked", {
        method: request.method(), url, matchedBlockRule: matchesAny(url, block), blockMethods: [...blockMethods],
      });
      await route.abort();
      return;
    }
    await route.continue();
  });
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
