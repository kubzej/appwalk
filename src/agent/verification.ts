import type { NetworkEntry, RuntimeErrorEntry } from '../evidence/recorder.js';
import { looksLikeSuccessByNetwork, looksLikeSuccessBySnapshot, looksLikeSuccessByUrl } from './success.js';
import type { ExpectationAssertion, ExpectationObservation } from '../types.js';

export type VerificationMode =
  'completion' | 'rejection' | 'preservation' | 'stability' | 'recovery' | 'consistency' | 'visual' | 'removal';

export interface VerificationContext {
  flowStartUrl: string;
  flowStartSnapshot: string;
  finalUrl: string;
  finalSnapshot: string;
  network: NetworkEntry[];
  /** Network activity captured specifically during this flow's `burst` tool-call step(s) — the
   * one action `stability` mode actually tests. Falls back to the full flow's `network` when
   * unavailable (older evidence, or a caller that hasn't wired per-step attribution). */
  burstNetwork?: NetworkEntry[];
  /** Snapshots captured after real actions in this flow, used for objective layout signals. */
  snapshots?: string[];
  /** Runtime failures observed during this flow, including transport failures without HTTP status. */
  runtimeErrors?: RuntimeErrorEntry[];
  /** Concrete signals checked by verifyExpectation during this flow. */
  expectations?: ExpectationObservation[];
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Confirmed against real Playwright ariaSnapshot output (not guessed): role="alert" renders as
// "- alert: <text>", aria-invalid="true" renders as a "[invalid]" suffix on the field's own line.
const ALERT_PATTERN = /-\s*alert:/i;
const INVALID_FIELD_PATTERN = /\[invalid\]/i;
const CONSISTENCY_ASSERTIONS = new Set(['containsText', 'value', 'count', 'checked', 'unchecked']);
const VISUAL_SIGNAL_PATTERN = /(?:^|\n)Layout:|content-overflows/i;
// Cloudflare's own reserved path, injected same-origin on every site it fronts (a RUM analytics
// beacon, speculation-rules pings, etc.) — not something any target application defines itself,
// so excluding it isn't specific to one site. Same-origin filtering alone (as looksLikeSuccessByNetwork
// already does) doesn't catch this: Cloudflare serves it from the app's own origin on purpose.
const INFRASTRUCTURE_PATH = /^\/cdn-cgi\//i;

function isApplicationRequest(entry: NetworkEntry): boolean {
  try {
    return !INFRASTRUCTURE_PATH.test(new URL(entry.url).pathname);
  } catch {
    return true;
  }
}

/**
 * A POST/PUT/PATCH/DELETE that actually succeeded — evidence a consequential action really went
 * through, not just that a request was attempted. Restricted to real application traffic: a
 * same-origin infrastructure beacon (Cloudflare's `/cdn-cgi/rum`) is also a "successful POST" by
 * HTTP status alone, but firing on every page transition, not on anything the flow itself did.
 */
function hasSuccessfulStateChange(network: NetworkEntry[]): boolean {
  return network.some(
    (entry) =>
      STATE_CHANGING_METHODS.has(entry.method) &&
      entry.status !== undefined &&
      entry.status >= 200 &&
      entry.status < 300 &&
      isApplicationRequest(entry),
  );
}

function hasExplicitMetExpectation(ctx: VerificationContext): boolean {
  return ctx.expectations?.some((expectation) => expectation.status === 'met') ?? false;
}

// An assertion that "passes" by confirming a locator/value/URL is *present* — as opposed to
// hidden/unchecked/disabled, which pass by confirming something is *absent*.
const AFFIRMATIVE_ASSERTIONS = new Set<ExpectationAssertion>([
  'visible',
  'checked',
  'enabled',
  'containsText',
  'urlContains',
  'urlEquals',
  'value',
]);

function expectationLooksLikeSuccessSignal(expectation: ExpectationObservation): boolean {
  const checkedText = [expectation.locator, expectation.value].filter(Boolean).join(' ');
  return looksLikeSuccessBySnapshot(checkedText) || looksLikeSuccessByUrl(checkedText);
}

/**
 * A met expectation only counts as evidence that something did *not* go through normally
 * (rejection, removal, preservation) if what it actually confirmed points that way — not just
 * that some check happened to pass. `verifyExpectation` reports "met" whenever its mechanical
 * check passes, with no idea which direction that supports; an agent confirming a success
 * heading is *visible* has proven the opposite of rejection, even though the check itself
 * "passed". Only exclude it when an affirmative assertion (visible/checked/.../containsText)
 * confirms success-shaped content is present — the same success-shaped content confirmed
 * *absent* (hidden/unchecked/disabled) is exactly the rejection/removal signal these modes want.
 */
function metExpectationSupportsNegativeOutcome(expectation: ExpectationObservation): boolean {
  if (expectation.status !== 'met') return false;
  if (!expectationLooksLikeSuccessSignal(expectation)) return true;
  return !AFFIRMATIVE_ASSERTIONS.has(expectation.assertion);
}

function hasMetExpectationSupportingNegativeOutcome(ctx: VerificationContext): boolean {
  return ctx.expectations?.some(metExpectationSupportsNegativeOutcome) ?? false;
}

function hasObservableChange(ctx: VerificationContext): boolean {
  return ctx.finalUrl !== ctx.flowStartUrl || ctx.finalSnapshot !== ctx.flowStartSnapshot;
}

function hasExplicitConsistencyExpectation(ctx: VerificationContext): boolean {
  return (
    ctx.expectations?.some(
      (expectation) => expectation.status === 'met' && CONSISTENCY_ASSERTIONS.has(expectation.assertion),
    ) ?? false
  );
}

function hasNewVisualSignal(ctx: VerificationContext): boolean {
  const initialSignals = new Set(ctx.flowStartSnapshot.split('\n').filter((line) => VISUAL_SIGNAL_PATTERN.test(line)));
  const observedSnapshots = [...(ctx.snapshots ?? []), ctx.finalSnapshot];
  return observedSnapshots
    .flatMap((snapshot) => snapshot.split('\n'))
    .some((line) => VISUAL_SIGNAL_PATTERN.test(line) && !initialSignals.has(line));
}

function hasFailedRequest(ctx: VerificationContext): boolean {
  const httpFailure = ctx.network.some((entry) => entry.status !== undefined && entry.status >= 400);
  const transportFailure =
    ctx.runtimeErrors?.some((error) => error.kind === 'request_failed' && !error.lifecycle && !error.safetyRelated) ??
    false;
  return httpFailure || transportFailure;
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
    if (!isApplicationRequest(entry)) continue;
    const key = `${entry.method} ${entry.url}`;
    successCounts.set(key, (successCounts.get(key) ?? 0) + 1);
  }
  return [...successCounts.values()].some((count) => count > 1);
}

// A generic verifier cannot know which object was removed. Removal therefore needs an explicit
// observable expectation such as a hidden target, zero count, or confirmed completion URL.
function looksLikeRemoval(ctx: VerificationContext): boolean {
  return hasMetExpectationSupportingNegativeOutcome(ctx);
}

function hasNewMatchingLine(before: string, after: string, pattern: RegExp): boolean {
  const beforeLines = new Set(
    before
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return after
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => pattern.test(line) && !beforeLines.has(line));
}

// role="alert"/aria-invalid don't catch every error UI, so new content since flow start is a fallback —
// URL-independent, since a rejection can land back on the same page or on a different one entirely.
// The success check below excludes URL matching on purpose: a block page's own URL can coincidentally
// contain a success-looking word, so only network/snapshot signals count as corroborating evidence.
// Imperfect: an acceptance with unrecognized wording can still slip through.
function looksLikeRejection(ctx: VerificationContext): boolean {
  if (hasMetExpectationSupportingNegativeOutcome(ctx)) return true;
  const newAlertOrInvalidMarker =
    hasNewMatchingLine(ctx.flowStartSnapshot, ctx.finalSnapshot, ALERT_PATTERN) ||
    hasNewMatchingLine(ctx.flowStartSnapshot, ctx.finalSnapshot, INVALID_FIELD_PATTERN);
  if (newAlertOrInvalidMarker) return true;
  return (
    hasObservableChange(ctx) &&
    hasFailedRequest(ctx) &&
    !looksLikeSuccessByNetwork(ctx.network, ctx.finalUrl) &&
    !looksLikeSuccessBySnapshot(ctx.finalSnapshot)
  );
}

// Deliberately not a same-URL check: a persona that backs out at the last moment (Talia's
// two-tab conflict, Della's "abandon right before confirming") naturally lands on an
// *intermediate* page it passed through on the way there — the cart, a listing — not the exact
// URL the flow started on. Same-URL was also never the right question for "nothing consequential
// happened" in the first place: leaving and returning to the start page after something *did*
// submit in between would satisfy it despite the state change.
//
// `!hasSuccessfulStateChange` alone is not enough either: a flow can legitimately make *setup*
// state changes on the way to the decision point (Della adding/removing cart items while shopping
// around) without ever committing the one action the flow is actually about. Verified against
// Della's real round-2 evidence — her two correctly-backed-out flows still fire successful
// cart-mutation requests, so that check alone stayed `false` for all four of her flows, including
// the two that should have read as preserved. `!looksLikeCompletion` adds the more targeted
// question this mode actually needs: did the flow ever reach its own completion signal (an order
// confirmation URL/snapshot, an explicit met expectation)? That matched Della's four flows
// exactly — true completions on the two that placed the order, no completion signal on the two
// that back out to the cart. OR, not replace: either signal is independently sufficient evidence
// nothing consequential landed, and OR can only pick up cases the other check missed, never lose
// one it already got right.
//
// Unverified for Talia (the other preservation-mode persona, a two-tab cart-quantity race): her
// scenario has no "order confirmation" shape to detect either way, so `!looksLikeCompletion` may
// end up always true for her regardless of whether the lost-update conflict was actually handled
// — her round-2 flows crashed before producing evidence to check this against. Flagged in
// FINDINGS-round2.md as a follow-up to verify once she produces real data.
function looksLikePreservation(ctx: VerificationContext): boolean {
  return (
    hasMetExpectationSupportingNegativeOutcome(ctx) ||
    !hasSuccessfulStateChange(ctx.network) ||
    !looksLikeCompletion(ctx)
  );
}

// Scoped to the burst step(s) themselves, not the whole flow: `stability` mode only ever tests
// whether one rapid repeated action produced a duplicate backend effect (riley's whole premise —
// `coreActionTypes: ['burst']`). Real evidence showed two distinct false-positive shapes from
// using the whole flow's network instead: a separate, deliberate earlier action against the same
// endpoint (an explicit "add to cart" click well before the burst) miscounted as a second copy of
// the burst's own effect; and a same-origin session-refresh call fired by an unrelated page
// reload/navigation earlier in the flow, nothing to do with the tested click at all. Restricting
// the check to the burst step's own network keeps the true-positive case intact — a genuinely
// undebounced button firing 5 real backend calls from one 5x burst still shows up, since all 5
// calls happen inside that same step.
function looksLikeStability(ctx: VerificationContext): boolean {
  return !hasSuspiciousDuplicateRequest(ctx.burstNetwork ?? ctx.network);
}

function looksLikeRecovery(ctx: VerificationContext): boolean {
  return hasFailedRequest(ctx) && looksLikeCompletion(ctx);
}

function looksLikeCompletion(ctx: VerificationContext): boolean {
  if (hasExplicitMetExpectation(ctx)) return true;
  if (!hasObservableChange(ctx)) return false;
  const newSuccessUrl = ctx.finalUrl !== ctx.flowStartUrl && looksLikeSuccessByUrl(ctx.finalUrl);
  const newSuccessSnapshot =
    !looksLikeSuccessBySnapshot(ctx.flowStartSnapshot) && looksLikeSuccessBySnapshot(ctx.finalSnapshot);
  return newSuccessUrl || newSuccessSnapshot;
}

/** Consistency uses explicit value/state assertions; visual uses those assertions or a new,
 * objective layout signal. Neither mode claims to perform generic business-value or pixel diffing. */
function verifySingle(mode: VerificationMode, ctx: VerificationContext): boolean {
  switch (mode) {
    case 'rejection':
      return looksLikeRejection(ctx);
    case 'preservation':
      return looksLikePreservation(ctx);
    case 'stability':
      return looksLikeStability(ctx);
    case 'recovery':
      return looksLikeRecovery(ctx);
    case 'removal':
      return looksLikeRemoval(ctx);
    case 'completion':
      return looksLikeCompletion(ctx);
    case 'consistency':
      return hasExplicitConsistencyExpectation(ctx);
    case 'visual':
      return hasExplicitMetExpectation(ctx) || hasNewVisualSignal(ctx);
    default:
      return false;
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
