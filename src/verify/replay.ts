import type { Page } from "playwright";
import { executeToolCall } from "../agent/tools.js";
import type { TabRegistryHandle } from "../agent/tools.js";
import type { VerificationMode } from "../agent/verification.js";
import { verifyFlow } from "../agent/verification.js";
import { configurePageTimeouts } from "../browser/actions.js";
import { captureSnapshot } from "../browser/snapshot.js";
import type { EvidenceEntry } from "../evidence/log.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import type { ToolCall } from "../providers/provider.js";
import type { ResponseExpectation, ResponseFixtureSelector } from "../response/variants.js";
import type { ExpectationObservation, StepResult } from "../types.js";
import type { Logger } from "../logging/logger.js";

export interface ReplayResult {
  reproduced: boolean;
  /** Whether the selected verification mode passed after all actions executed. */
  verificationPassed: boolean;
  finalUrl: string;
  steps: StepResult[];
  failedAt?: { index: number; action: string; error: string };
  expectationsReproduced: boolean;
  /** Number of requests intentionally blocked by Appwalk safety during this replay. */
  safetyBlocked: number;
  finalSnapshot: string;
  /** The first successful observation of a derived scenario expectation, if one was supplied. */
  variantExpectationResult?: import("../agent/tools.js").ToolCallResult;
  variantExpectationStep?: number;
  /** Whether the response selected by the variant was actually applied during replay. */
  variantSourceMatched?: boolean;
  /** The page actually active when replay ended — the same page it was called with, unless an action
   * (a new tab, a reopened browser) switched it. The caller must close this page's browser. */
  finalPage: Page;
}

/** Pulls out just the successful tool calls from an evidence log — replay isn't interested in the agent's failed exploratory attempts, only the sequence that actually worked. `flowComplete` isn't a browser action, so it's excluded here too. */
export function extractActions(entries: EvidenceEntry[]): ToolCall[] {
  return entries
    .filter((entry) => entry.toolCall && !entry.error && entry.toolCall.name !== "flowComplete")
    .map((entry, i) => ({
      id: `replay-${i}`,
      name: entry.toolCall!.name,
      input: entry.toolCall!.input,
    }));
}

/** Re-executes a fixed action sequence deterministically — no LLM involved — and reports whether it
 * reproduces the same outcome the original discovery run verified. Must use the *same* verification
 * mode the flow was originally checked with — a hardcoded `completion`-only check here would fail
 * every non-`completion` flow (e.g. a `rejection`-verified one) regardless of whether it truly reproduced. */
export async function replay(
  page: Page,
  actions: ToolCall[],
  mode: VerificationMode | VerificationMode[] = "completion",
  recorder?: EvidenceRecorder,
  expectedExpectations: ExpectationObservation[] = [],
  variantExpectation?: ResponseExpectation,
  logger?: Logger,
  getSafetyBlockCount?: () => number,
  variantSource?: { selector: ResponseFixtureSelector; isMatched: () => boolean },
  /** Called whenever a replayed action switches the active page (a new tab, a reopened
   * browser) — the caller re-applies whatever is page-scoped, such as the destructive-action
   * safety guard, which doesn't follow a page switch on its own. */
  onActivePageChange?: (page: Page) => Promise<void>,
  /** Kept pointed at this replay's tab registry so a popup listener attached by the caller
   * (before this function ever runs) can register a tab the target app opens on its own — this
   * matters when the recorded action sequence includes a switchTab to a tab that originally came
   * from a popup during exploration, not from openTab. A caller with no popup-registration story
   * (e.g. a variant replay that doesn't need it) can omit this and get a private, unshared registry. */
  tabRegistryHandle: TabRegistryHandle = { tabs: new Map() },
): Promise<ReplayResult> {
  const flowStartUrl = page.url();
  const flowStartSnapshot = await captureSnapshot(page);
  const replayNetworkStart = recorder?.network.length ?? 0;
  tabRegistryHandle.tabs = new Map([["tab-0", page]]);
  const steps: StepResult[] = [];
  let variantExpectationResult: import("../agent/tools.js").ToolCallResult | undefined;
  let variantExpectationStep: number | undefined;
  let finalUrl = flowStartUrl;
  const safetyCountBefore = getSafetyBlockCount?.() ?? 0;

  const sourceMatched = () => variantSource?.isMatched() ?? true;
  const checkVariantExpectation = async (step: number): Promise<void> => {
    if (!variantExpectation || variantExpectationResult || !sourceMatched()) return;
    const expectationResult = await executeToolCall(page, {
      id: `replay-variant-expectation-${step}`,
      name: "verifyExpectation",
      input: {
        expectationIndex: 1,
        assertion: variantExpectation.assertion,
        locator: variantExpectation.locator,
        value: variantExpectation.value,
      },
    }, tabRegistryHandle.tabs);
    if (expectationResult.expectation?.status === "met") {
      variantExpectationResult = expectationResult;
      variantExpectationStep = step;
    }
  };

  // A response can be consumed while the initial page is loading, before the first recorded action.
  // Evaluate it against the captured initial state, but only after the fixture matcher confirms it.
  await checkVariantExpectation(-1);

  for (const [index, action] of actions.entries()) {
    logger?.debug("replay.step_started", "Replay action started", { stepIndex: index, action: action.name, input: action.input });
    try {
      const result = await executeToolCall(page, action, tabRegistryHandle.tabs);
      steps.push(result);
      finalUrl = result.url;
      if (result.activePage) {
        page = result.activePage;
        configurePageTimeouts(page);
        recorder?.reattach(page);
        await onActivePageChange?.(page);
      }
      await checkVariantExpectation(index);
      logger?.debug("replay.step_completed", "Replay action completed", { stepIndex: index, action: action.name, url: result.url });
    } catch (err) {
      logger?.debug("replay.step_failed", "Replay action failed", { stepIndex: index, action: action.name, error: (err as Error).message });
      return {
        reproduced: false,
        verificationPassed: false,
        finalUrl,
        steps,
        expectationsReproduced: false,
        finalSnapshot: steps[steps.length - 1]?.snapshot ?? flowStartSnapshot,
        failedAt: { index, action: action.name, error: (err as Error).message },
        safetyBlocked: Math.max(0, (getSafetyBlockCount?.() ?? safetyCountBefore) - safetyCountBefore),
        finalPage: page,
        variantSourceMatched: variantSource ? sourceMatched() : undefined,
      };
    }
  }

  const finalSnapshot = steps[steps.length - 1]?.snapshot ?? flowStartSnapshot;
  const replayedExpectations = steps.flatMap((step) => step.expectation ? [step.expectation] : []);
  const expectationsReproduced = expectedExpectations.every((expected, index) => {
    const actual = replayedExpectations[index];
    return Boolean(
      actual &&
        actual.expectationIndex === expected.expectationIndex &&
        actual.status === expected.status &&
        actual.assertion === expected.assertion &&
        actual.locator === expected.locator &&
        actual.value === expected.value &&
        actual.expectedCount === expected.expectedCount,
    );
  }) && replayedExpectations.length === expectedExpectations.length;
  const verificationPassed = verifyFlow(mode, {
    flowStartUrl,
    flowStartSnapshot,
    finalUrl,
    finalSnapshot,
    network: recorder?.network.slice(replayNetworkStart) ?? [],
  });
  const safetyBlocked = Math.max(0, (getSafetyBlockCount?.() ?? safetyCountBefore) - safetyCountBefore);
  const variantSourceMatched = variantSource ? sourceMatched() : undefined;
  const variantExpectationReproduced = !variantExpectation || variantExpectationResult?.expectation?.status === "met";
  const reproduced = safetyBlocked === 0 && expectationsReproduced && verificationPassed &&
    variantSourceMatched !== false && variantExpectationReproduced;
  if (variantSource && !variantSourceMatched) {
    logger?.debug("response_variant.source_not_observed", "Variant source response was not observed during replay", {
      method: variantSource.selector.method,
      sourceUrl: variantSource.selector.url,
      occurrence: variantSource.selector.occurrence,
    });
  }
  logger?.debug("replay.completed", "Replay verification completed", {
    reproduced,
    verificationPassed,
    expectationsReproduced,
    variantSourceMatched,
    variantExpectationObserved: variantExpectationResult?.expectation?.status === "met",
    safetyBlocked,
    steps: steps.length,
    finalUrl,
  });
  return {
    reproduced,
    verificationPassed,
    finalUrl,
    steps,
    expectationsReproduced,
    finalSnapshot,
    finalPage: page,
    safetyBlocked,
    variantExpectationResult,
    variantExpectationStep,
    variantSourceMatched,
  };
}

/** Detects a response variant that changed an observable intermediate page, even if the flow ends on the same screen. */
export function hasObservableReplayDifference(base: ReplayResult, candidate: ReplayResult): boolean {
  if (base.finalUrl !== candidate.finalUrl || base.finalSnapshot !== candidate.finalSnapshot) return true;
  if (base.steps.length !== candidate.steps.length) return true;
  return candidate.steps.some((step, index) => {
    const original = base.steps[index];
    return !original || original.url !== step.url || original.snapshot !== step.snapshot;
  });
}
