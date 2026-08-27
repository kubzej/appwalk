import type { NetworkEntry } from "../evidence/recorder.js";
import { looksLikeSuccess, looksLikeSuccessByNetwork, looksLikeSuccessBySnapshot } from "./success.js";

export type VerificationMode =
  | "completion"
  | "rejection"
  | "preservation"
  | "stability"
  | "recovery"
  | "consistency"
  | "visual"
  | "removal";

export interface VerificationContext {
  flowStartUrl: string;
  flowStartSnapshot: string;
  finalUrl: string;
  finalSnapshot: string;
  network: NetworkEntry[];
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Confirmed against real Playwright ariaSnapshot output (not guessed): role="alert" renders as
// "- alert: <text>", aria-invalid="true" renders as a "[invalid]" suffix on the field's own line.
const ALERT_PATTERN = /-\s*alert:/i;
const INVALID_FIELD_PATTERN = /\[invalid\]/i;

function hasSuccessfulStateChange(network: NetworkEntry[]): boolean {
  return network.some(
    (entry) =>
      STATE_CHANGING_METHODS.has(entry.method) &&
      entry.status !== undefined &&
      entry.status >= 200 &&
      entry.status < 300,
  );
}

function hasFailedRequest(network: NetworkEntry[]): boolean {
  return network.some((entry) => entry.status !== undefined && entry.status >= 400);
}

/** A generic proxy for "probably an unwanted duplicate side effect" — the same state-changing endpoint
 * hit more than once with a successful status. Not a precise business-rule check (knowing the *correct*
 * count for a given flow needs domain knowledge this function doesn't have); this only catches the
 * structurally-suspicious case. */
function hasSuspiciousDuplicateRequest(network: NetworkEntry[]): boolean {
  const successCounts = new Map<string, number>();
  for (const entry of network) {
    if (!STATE_CHANGING_METHODS.has(entry.method)) continue;
    if (entry.status === undefined || entry.status < 200 || entry.status >= 300) continue;
    const key = `${entry.method} ${entry.url}`;
    successCounts.set(key, (successCounts.get(key) ?? 0) + 1);
  }
  return [...successCounts.values()].some((count) => count > 1);
}

// A persona whose entire behavior is deliberately ending/removing/cancelling something doesn't need
// completion's stricter filtering — for that persona, any observable state change since the flow
// started is itself the expected outcome of a successful attempt (there's nothing else it could be
// confusable with, unlike Noah/Wade's intermediate wandering, which completion must filter out).
function looksLikeRemoval(ctx: VerificationContext): boolean {
  return ctx.finalUrl !== ctx.flowStartUrl || ctx.finalSnapshot !== ctx.flowStartSnapshot;
}

function newLinesSince(before: string, after: string): boolean {
  const beforeLines = new Set(
    before
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return after
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .some((line) => !beforeLines.has(line));
}

// role="alert"/aria-invalid don't catch every error UI, so new content since flow start is a fallback —
// URL-independent, since a rejection can land back on the same page or on a different one entirely.
// The success check below excludes URL matching on purpose: a block page's own URL can coincidentally
// contain a success-looking word, so only network/snapshot signals count as corroborating evidence.
// Imperfect: an acceptance with unrecognized wording can still slip through.
function looksLikeRejection(ctx: VerificationContext): boolean {
  if (ALERT_PATTERN.test(ctx.finalSnapshot) || INVALID_FIELD_PATTERN.test(ctx.finalSnapshot)) return true;
  if (!newLinesSince(ctx.flowStartSnapshot, ctx.finalSnapshot)) return false;
  const looksAcceptedOrSuccessful =
    looksLikeSuccessByNetwork(ctx.network, ctx.finalUrl) || looksLikeSuccessBySnapshot(ctx.finalSnapshot);
  return !looksAcceptedOrSuccessful;
}

function looksLikePreservation(ctx: VerificationContext): boolean {
  return ctx.finalUrl === ctx.flowStartUrl && !hasSuccessfulStateChange(ctx.network);
}

function looksLikeStability(ctx: VerificationContext): boolean {
  return !hasSuspiciousDuplicateRequest(ctx.network);
}

function looksLikeRecovery(ctx: VerificationContext): boolean {
  return hasFailedRequest(ctx.network) && looksLikeSuccess(ctx.finalUrl, ctx.network, ctx.finalSnapshot);
}

/** `consistency` and `visual` don't have a generic implementation yet — `consistency` needs to know
 * *which* business values should match, which isn't something a generic check can infer; `visual`
 * needs real screenshot comparison, not just the accessibility tree. Falling back to `completion`
 * is an honest placeholder, not a real check — don't rely on either mode until they're built out. */
function verifySingle(mode: VerificationMode, ctx: VerificationContext): boolean {
  switch (mode) {
    case "rejection":
      return looksLikeRejection(ctx);
    case "preservation":
      return looksLikePreservation(ctx);
    case "stability":
      return looksLikeStability(ctx);
    case "recovery":
      return looksLikeRecovery(ctx);
    case "removal":
      return looksLikeRemoval(ctx);
    case "completion":
      return looksLikeSuccess(ctx.finalUrl, ctx.network, ctx.finalSnapshot);
    case "consistency":
    case "visual":
    default:
      return looksLikeSuccess(ctx.finalUrl, ctx.network, ctx.finalSnapshot);
  }
}

/** A persona can name more than one mode when a single flow can legitimately end in more than one
 * valid shape (e.g. a backtracker either genuinely finishes the flow, or proves an interruption
 * changed nothing) — treated as OR, not AND: satisfying any one named mode is enough. Most modes'
 * own conditions are mutually exclusive by construction (`completion` requires a state change,
 * `preservation` requires none), so AND across them would reject everything. */
export function verifyFlow(mode: VerificationMode | VerificationMode[], ctx: VerificationContext): boolean {
  const modes = Array.isArray(mode) ? mode : [mode];
  return modes.some((m) => verifySingle(m, ctx));
}
