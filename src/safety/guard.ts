import type { BrowserContext } from "playwright";
import type { Logger } from "../logging/logger.js";

const DEFAULT_BLOCK_METHODS = ["POST", "DELETE", "PUT", "PATCH"];

export interface SafetyConfig {
  block?: string[];
  allow?: string[];
}

export interface SafetyRequestOptions {
  allowDestructive: boolean;
  blockMethods?: string[];
  config?: SafetyConfig;
  onBlocked?: (request: { method: string; url: string }) => void;
}

export interface SafetyDecision {
  blocked: boolean;
  reason?: "url" | "method";
  matchedAllowRule: boolean;
  matchedBlockRule: boolean;
}

export interface GuardOptions extends SafetyRequestOptions {
  logger?: Logger;
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

/**
 * Evaluates one request against the same URL and method policy used by the browser route guard.
 * URL allow rules are explicit exceptions, URL block rules remain active even when the default
 * method block is disabled, and allowDestructive only disables the default method restriction.
 */
export function evaluateSafetyRequest(
  method: string,
  url: string,
  options: Pick<SafetyRequestOptions, "allowDestructive" | "blockMethods" | "config">,
): SafetyDecision {
  const matchedAllowRule = matchesAny(url, options.config?.allow);
  const matchedBlockRule = matchesAny(url, options.config?.block);
  if (matchedAllowRule) {
    return { blocked: false, matchedAllowRule, matchedBlockRule };
  }
  if (matchedBlockRule) {
    return { blocked: true, reason: "url", matchedAllowRule, matchedBlockRule };
  }
  if (options.allowDestructive) {
    return { blocked: false, matchedAllowRule, matchedBlockRule };
  }
  const blockedByMethod = new Set(options.blockMethods ?? DEFAULT_BLOCK_METHODS).has(method);
  return {
    blocked: blockedByMethod,
    ...(blockedByMethod ? { reason: "method" as const } : {}),
    matchedAllowRule,
    matchedBlockRule,
  };
}

/** Context-scoped, not page-scoped: a browser context can hold more than one page (a tab opened
 * via openTab, or one the target app opens itself), and `context.route()` — unlike `page.route()`
 * — automatically covers every page already in the context plus every page created in it later. */
export async function installDestructiveActionGuard(
  context: BrowserContext,
  options: GuardOptions,
): Promise<void> {
  if (options.allowDestructive && !options.config?.block?.length) return;
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const decision = evaluateSafetyRequest(request.method(), url, options);
    if (decision.blocked) {
      options.onBlocked?.({ method: request.method(), url: safePath(url) });
      options.logger?.verbose(`      Blocked destructive request: ${request.method()} ${safePath(url)}`);
      options.logger?.debug("safety.request_blocked", "Destructive request blocked", {
        method: request.method(), url, matchedBlockRule: decision.matchedBlockRule, blockMethods: options.blockMethods ?? DEFAULT_BLOCK_METHODS,
      });
      await route.abort();
      return;
    }
    await route.continue();
  });
}

export function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
