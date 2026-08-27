import type { Page } from "playwright";
import { configurePageTimeouts } from "../browser/actions.js";
import { captureScreenshot, toStepResult } from "../browser/snapshot.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import type { LlmProvider } from "../providers/provider.js";
import type { ExpectationObservation, ExpectationStatus, StepResult } from "../types.js";
import type { Logger } from "../logging/logger.js";
import type { Persona } from "./personas.js";
import { executeToolCall, TOOL_DEFINITIONS } from "./tools.js";
import type { VerificationMode } from "./verification.js";
import { verifyFlow } from "./verification.js";

const DEFAULT_CONTEXT_CHECKPOINT_ACTIONS = 8;
const MODEL_SNAPSHOT_MAX_CHARS = 18_000;
const CHECKPOINT_ACTIONS = 10;
const CHECKPOINT_FLOW_SUMMARY_MAX_CHARS = 500;
const MAX_EMPTY_FLOW_ENDINGS = 3;

function actionLabel(name: string): string {
  const labels: Record<string, string> = {
    navigate: "Navigate",
    click: "Click",
    fill: "Fill field",
    select: "Select option",
    pressKey: "Press key",
    check: "Check option",
    uncheck: "Uncheck option",
    hover: "Hover element",
    waitFor: "Wait for element",
    reload: "Reload page",
    goBack: "Go back",
    goForward: "Go forward",
    setViewportSize: "Set viewport",
    verifyExpectation: "Verify expectation",
  };
  return labels[name] ?? name;
}

function actionFailureReason(error: string): string {
  if (/strict mode violation/i.test(error)) return "the locator matched more than one element";
  if (/intercepts pointer events/i.test(error)) return "another element blocked the interaction";
  if (/timeout/i.test(error)) return "the target did not become available in time";
  return (error.split("\n")[0] ?? error).replace(/^locator\.[^:]+:\s*/i, "");
}

function actionDescription(name: string, input: Record<string, unknown>): string {
  const label = actionLabel(name);
  if (name === "setViewportSize") return `${label} to ${input.width}x${input.height}`;
  if (name === "navigate") return `${label} to target page`;
  if (typeof input.locator === "string") return `${label} ${input.locator}`;
  return label;
}

function buildSystemPrompt(
  maxSteps: number,
  hasScreenshots: boolean,
  persona?: Persona,
  scope?: string,
  expectations: string[] = [],
): string {
  const screenshotNote = hasScreenshots
    ? "\n\nYou also get a screenshot alongside the accessibility tree after every action. Use it when an element has no useful accessible name — an icon-only button, a canvas element — to figure out what it is and where it is."
    : "";
  // Any concrete examples in a persona's own goal text (a cart, an order, a wizard step) are there to
  // illustrate the general pattern, not a description of this specific application — we have no advance
  // knowledge of what this app actually contains, and the model must not expect those exact things to
  // exist. Said once here rather than repeated in every persona's own text.
  const genericAppNote = persona
    ? `\n\nAny concrete examples above (specific field names, page types, flows) are illustrations of the general pattern you're testing for, not a description of this particular application — we have no advance knowledge of what this app actually contains. Look at what this app actually offers and adapt the pattern to it; don't expect it to literally contain the things named in the examples.`
    : "";
  const intro = persona
    ? `${persona.goal}${genericAppNote}${screenshotNote}`
    : `You are exploring a web application to find and complete as many distinct, meaningful user flows as you can — this could be anything from signing up or checking out to creating a resource, submitting a support request, or completing a multi-step workflow, depending on what the app actually offers.${screenshotNote}`;

  // The default persona's own definition of "correct a validation error and resubmit" doesn't
  // apply to personas that define their own notion of a completed attempt (e.g. one that's
  // deliberately trying to trigger that same validation error).
  const formCorrectionGuidance = persona
    ? ""
    : `\n\nIf a form submission shows an error (e.g. "already exists", a validation message) and you correct the input (e.g. filling a different value), you MUST submit that correction — click the submit/confirm button again — before moving on to a different flow. Filling a corrected value and then navigating away without submitting leaves the flow incomplete.`;
  const meaningfulDefinition = persona
    ? ""
    : `\n\nA flow counts as "meaningful" and complete when it produces a real state change — something was created, submitted, updated, or confirmed — reflected by something like a confirmation message, a new page, or a changed piece of state on the page. Simply navigating somewhere to look at it is not a completed flow.`;
  const scopeGuidance = scope
    ? `\n\nThe user asked you to explore this scope: "${scope}". Treat it as a soft exploration mission: the current target URL is only your starting point, so navigate through the application to find the relevant area or journey even when its exact URL is unknown. Prefer meaningful flows inside this scope and avoid unrelated areas unless they are necessary to reach or understand it. Do not assume the requested area exists; if you cannot find it, do not invent a result and end with a clear summary of what was unavailable.`
    : "";
  const expectationGuidance = expectations.length
    ? `\n\nThe user supplied these expectations for this scope. They are acceptance criteria, not instructions to assume success:\n${expectations.map((expectation, index) => `${index + 1}. ${expectation}`).join("\n")}\nAfter you reach a relevant state, physically check every expectation at least once with the \`verifyExpectation\` tool before completing the relevant flow. Translate each requirement into the strongest concrete signal the current page provides. You may check an expectation again in another relevant flow if that adds evidence. Use \`unknown\` only when the application offers no reliable observable signal. Do not claim expectation results only in your summary.`
    : "";

  return `${intro}${scopeGuidance}${expectationGuidance}

If a cookie/consent banner, promotional overlay, or modal is blocking the page, dismiss it first (accept/close) before continuing — don't try to work around it.

You have a budget of ${maxSteps} actions for this run — use as much of it as you genuinely can. You're not trying to find one happy path and stop; the goal is to exercise the application thoroughly, all the way through, so use the full budget probing it. Prioritize finishing the flow you're already on over starting a new one, and don't spend more than 2 attempts on the same stuck approach. After completing a flow, always look for another one to attempt next — vary the details: a different product or item, a different input value, a different setting or configuration option, a different path through similar functionality. Don't literally repeat a flow you already ran with the exact same inputs — that adds nothing. If you're truly out of new variations to try, a near-identical repeat is still better than stopping with budget left over, but treat that as a last resort, not the default. Don't stop just because you've covered the obvious cases.

You see the page as an accessibility tree snapshot after every action. Choose exactly one tool call per turn based on the current snapshot.

Locator syntax — this is a Playwright locator string, not a plain CSS selector:
- To target by accessibility role and name, you MUST prefix with "role=", e.g. role=button[name="Submit"] or role=textbox[name="Email"]. A bare "textbox[name=...]" or "button[name=...]" without the "role=" prefix is invalid — "textbox" and "button" are not HTML tags, so it will never match anything and will just time out.
- To target by visible text, use text="exact text" or text=/partial/i.
- Prefer the actual interactive element (the button or link) over a decorative child inside it (an icon or image) — clicking an <img> inside a <button> can fail because the button intercepts the click. If an element has a role in the snapshot (e.g. "button \"Menu\""), target it with role=button[name="Menu"], not the icon inside it.
- If a locator resolves to more than one element (ambiguous), make it more specific — add text, narrow the role, or use >> nth=N — rather than repeating the same locator.

When something fails twice in a row, don't just retry the same idea with small tweaks — change strategy. Try a different path through the page (scroll for more content, navigate directly to a likely URL, go back and take a different link) instead of only adjusting the locator syntax.${formCorrectionGuidance}${meaningfulDefinition}

Some browser requests may be intentionally blocked by Appwalk's safety policy. If a tool result says a request was safety-blocked, that request was not sent and the action may not have changed application state. Do not retry the same blocked action repeatedly; choose a safe read-only path or clearly treat the attempted flow as incomplete.

When you believe you have completed a full, meaningful flow, call the \`flowComplete\` tool immediately with a short summary of what you did — don't continue exploratory actions after reaching that flow's terminal success state. If you want to test a follow-up scenario, close the current flow first; if action budget remains, you'll be taken back to the starting page to look for a different flow. Reach for a genuinely different variation (different data, different option, different area of the app) before settling for a near-identical repeat. Never end your turn with plain text while budget remains; only stop early if the app itself is completely broken or unreachable.`;
}

export interface LoopStep {
  toolCall?: { name: string; input: Record<string, unknown> };
  result?: StepResult;
  error?: string;
  finalText?: string;
  safetyBlocked?: number;
}

export interface FlowResult {
  /** Indices into the returned `history` array — inclusive range covering just this flow's steps. */
  startIndex: number;
  endIndex: number;
  finalText: string;
  title?: string;
  verified: boolean;
  /** URL captured at the flow's starting point, which may differ from the CLI's root URL. */
  startUrl: string;
  /** JSON-serialized browser storage captured when this flow began, for deterministic replay. */
  startStorageState: string;
}

export type LoopStopReason = "completed" | "agent_stopped" | "budget_exhausted" | "no_progress";

export interface LoopResult {
  history: LoopStep[];
  /** One entry per flow the agent completed (via `flowComplete`, or by ending its turn in plain text). */
  flows: FlowResult[];
  /** True if the loop stopped because it ran out of step budget. */
  exhausted: boolean;
  stopReason: LoopStopReason;
  expectationResults: ExpectationResult[];
  /** The page actually active when the loop ended — the same page it was called with, unless an action
   * (a new tab, a reopened browser) switched it. The caller must close this page's browser, not
   * necessarily the one it originally passed in. */
  finalPage: Page;
}

export interface ExpectationResult {
  expectationIndex: number;
  text: string;
  status: ExpectationStatus;
  observations: Array<ExpectationObservation & { flowIndex: number; historyIndex: number }>;
}

function aggregateExpectationResults(expectations: string[], observations: Array<ExpectationObservation & { flowIndex: number; historyIndex: number }>): ExpectationResult[] {
  return expectations.map((text, index) => {
    const matching = observations.filter((observation) => observation.expectationIndex === index + 1);
    const status = matching.some((observation) => observation.status === "violated")
      ? "violated"
      : matching.some((observation) => observation.status === "met")
        ? "met"
        : "unknown";
    return { expectationIndex: index + 1, text, status, observations: matching };
  });
}

// Checks result *presence*, not field truthiness — a step with a real but empty snapshot must not be
// skipped; only a step with no result at all (an error) falls through to an earlier entry.
function lastKnownUrl(history: LoopStep[], fallback: string): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const result = history[i]?.result;
    if (result) return result.url;
  }
  return fallback;
}

function lastKnownSnapshot(history: LoopStep[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const result = history[i]?.result;
    if (result) return result.snapshot;
  }
  return "";
}

function clipForCheckpoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  return `${value.slice(0, headChars)}\n...[snapshot clipped]...\n${value.slice(-tailChars)}`;
}

function checkpointInput(
  history: LoopStep[],
  flowStartIndex: number,
  currentSnapshot: StepResult,
  flows: FlowResult[],
  remainingSteps: number,
): string {
  const recentActions = history
    .slice(Math.max(flowStartIndex, history.length - CHECKPOINT_ACTIONS))
    .map((step, index) => {
      const action = step.toolCall ? `${step.toolCall.name} ${JSON.stringify(step.toolCall.input)}` : "(no tool call)";
      const outcome = step.error ? `error: ${step.error}` : step.result ? `URL: ${step.result.url}` : "no result";
      return `${index + 1}. ${clipForCheckpoint(action, 900)} -> ${clipForCheckpoint(outcome, 500)}`;
    })
    .join("\n");
  const completedFlows = flows
    .slice(-5)
    .map((flow, index) => `${index + 1}. ${clipForCheckpoint(flow.title ?? flow.finalText, CHECKPOINT_FLOW_SUMMARY_MAX_CHARS)}`)
    .join("\n");

  return `Context checkpoint. Continue the same browser exploration from the current page; browser state and the action evidence are preserved. Do not repeat completed actions just because the conversation was compacted. Choose exactly one next tool call.

Completed flows:
${completedFlows || "(none)"}

Recent actions in the current flow:
${recentActions || "(none)"}

Current page:
URL: ${currentSnapshot.url}
  ${clipForCheckpoint(currentSnapshot.snapshot, MODEL_SNAPSHOT_MAX_CHARS)}

Remaining loop budget: ${remainingSteps} steps.`;
}

function nextFlowInput(flows: FlowResult[], currentSnapshot: StepResult, remainingSteps: number): string {
  const completedFlows = flows
    .slice(-5)
    .map((flow, index) => `${index + 1}. ${clipForCheckpoint(flow.title ?? flow.finalText, CHECKPOINT_FLOW_SUMMARY_MAX_CHARS)}`)
    .join("\n");
  return `A previous flow is complete. Start a genuinely different flow from the current starting page. Do not repeat a completed flow or its exact inputs. Choose exactly one next tool call.

Completed flows:
${completedFlows || "(none)"}

Current page:
URL: ${currentSnapshot.url}
${clipForCheckpoint(currentSnapshot.snapshot, MODEL_SNAPSHOT_MAX_CHARS)}

Remaining loop budget: ${remainingSteps} steps.`;
}

export async function runAgentLoop(
  page: Page,
  provider: LlmProvider,
  options: {
    maxSteps: number;
    onStep?: (step: LoopStep, index: number, flowIndex: number) => void;
    /** Optional — when given, the completion heuristic also checks for a 2xx on a recent state-changing request, not just the URL. */
    recorder?: EvidenceRecorder;
    /** Also capture a screenshot after every step, for providers that support vision. */
    captureScreenshots?: boolean;
    /** Which verification mode to apply to every flow in this session. Ignored if `persona` is given (the persona's own mode wins). Defaults to `completion`. */
    verificationMode?: VerificationMode;
    /** Overrides the default exploration goal with a specific persona's — also determines the verification mode unless overridden by `verificationMode` directly. */
    persona?: Persona;
    /** Optional natural-language exploration objective. It guides navigation but is not a hard route boundary. */
    scope?: string;
    /** User-defined acceptance criteria to check within the scope. */
    expectations?: string[];
    /** Rebuild the provider context after this many tool actions. Set to 0 to disable. */
    contextCheckpointActions?: number;
    /** Returns the number of safety-blocked requests observed by the active browser session. */
    getSafetyBlockCount?: () => number;
    logger?: Logger;
  },
): Promise<LoopResult> {
  const mode: VerificationMode | VerificationMode[] =
    options.persona?.verificationMode ?? options.verificationMode ?? "completion";
  const history: LoopStep[] = [];
  const flows: FlowResult[] = [];
  const initialUrl = page.url();

  const initialSnapshot = await toStepResult(page);
  const initialScreenshot = options.captureScreenshots ? await captureScreenshot(page) : undefined;
  const expectationObservations: Array<ExpectationObservation & { flowIndex: number; historyIndex: number }> = [];
  const systemPrompt = () => buildSystemPrompt(
    options.maxSteps,
    Boolean(options.captureScreenshots),
    options.persona,
    options.scope,
    options.expectations,
  );

  let turn = await provider.start({
    systemPrompt: systemPrompt(),
    tools: TOOL_DEFINITIONS,
    initialInput: `Current page:\nURL: ${initialSnapshot.url}\n${clipForCheckpoint(initialSnapshot.snapshot, MODEL_SNAPSHOT_MAX_CHARS)}`,
    screenshot: initialScreenshot,
  });
  options.logger?.debug("agent.turn_started", "Agent context started", { flowIndex: 0, actionCount: 0 });

  let flowIndex = 0;
  let flowStartIndex = 0;
  let flowNetworkStart = options.recorder?.network.length ?? 0;
  let flowStartUrl = initialSnapshot.url;
  let flowStartSnapshot = initialSnapshot.snapshot;
  let flowStartStorageState = JSON.stringify(await page.context().storageState({ indexedDB: true }));
  let actionCount = 0;
  let flowActionStartCount = 0;
  let emptyFlowEndings = 0;
  options.logger?.verbose("    Exploring flow 1");

  while (true) {
    const isFlowCompleteTool = turn.type === "tool_call" && turn.toolCall.name === "flowComplete";

    if (turn.type === "text") {
      const stopStep: LoopStep = { finalText: turn.text, result: await toStepResult(page) };
      history.push(stopStep);
      options.onStep?.(stopStep, history.length - 1, flowIndex);
      options.logger?.info(
        actionCount >= options.maxSteps
          ? `    Exploration reached the action budget before the next flow was completed; retained ${flows.length} completed flow(s)`
          : flows.length > 0
            ? `    Exploration ended before the next flow was completed; retained ${flows.length} completed flow(s)`
            : "    Exploration stopped before completing a flow",
      );
      options.logger?.debug("exploration.agent_stopped", "Agent returned text without calling flowComplete", {
        flowIndex,
        actionCount,
        exhausted: actionCount >= options.maxSteps,
      });
      return {
        history,
        flows,
        exhausted: actionCount >= options.maxSteps,
        stopReason: actionCount >= options.maxSteps ? "budget_exhausted" : "agent_stopped",
        expectationResults: aggregateExpectationResults(options.expectations ?? [], expectationObservations),
        finalPage: page,
      };
    }

    if (isFlowCompleteTool) {
      const finalText = (turn.toolCall.input.summary as string) ?? "(no summary provided)";
      const title = isFlowCompleteTool && turn.type === "tool_call" && typeof turn.toolCall.input.title === "string"
        ? turn.toolCall.input.title
        : undefined;
      const currentState = await toStepResult(page);

      const step: LoopStep = { finalText, result: currentState };
      if (isFlowCompleteTool && turn.type === "tool_call") {
        step.toolCall = { name: turn.toolCall.name, input: turn.toolCall.input };
      }
      history.push(step);
      options.onStep?.(step, history.length - 1, flowIndex);

      const flowHistory = history.slice(flowStartIndex);
      // Verification reads state from the last *real* action, not the ending step's own fresh capture
      // above — the gap between them is a full LLM round-trip of real wall-clock time, long enough for
      // a delayed client-side redirect/effect to complete and silently erase signal (e.g. an inline
      // error message) that was genuinely present right after the action itself.
      const actionHistory = flowHistory.slice(0, -1);
      const url = lastKnownUrl(actionHistory, initialUrl);
      const snapshot = lastKnownSnapshot(actionHistory);
      const network = options.recorder?.network.slice(flowNetworkStart) ?? [];
      // A zero-action ending has nothing to verify — otherwise `preservation` mode (Blake) would
      // trivially pass a no-op as "nothing changed".
      //
      // `coreActionTypes`, when set, gates the same way: rendered content alone can't prove the
      // persona's defining action happened, since apps render rejection/error states differently.
      const hasCoreAction =
        !options.persona?.coreActionTypes ||
        actionHistory.some((step) => step.toolCall && options.persona!.coreActionTypes!.includes(step.toolCall.name));
      const verified =
        flowHistory.length > 1 &&
        hasCoreAction &&
        verifyFlow(mode, {
          flowStartUrl,
          flowStartSnapshot,
          finalUrl: url,
          finalSnapshot: snapshot,
          network,
        });

      flows.push({
        startIndex: flowStartIndex,
        endIndex: history.length - 1,
        finalText,
        title,
        verified,
        startUrl: flowStartUrl,
        startStorageState: flowStartStorageState,
      });
      options.logger?.info(`    Flow ${flows.length} discovered${title ? `: ${title}` : ""}`);
      options.logger?.debug("flow.completed", "Agent completed a flow", {
        flowIndex, verified, actions: actionHistory.length, startUrl: flowStartUrl, finalUrl: url,
      });

      if (actionCount === flowActionStartCount) {
        emptyFlowEndings += 1;
        if (emptyFlowEndings >= MAX_EMPTY_FLOW_ENDINGS) {
          return {
            history,
            flows,
            exhausted: false,
            stopReason: "no_progress",
            expectationResults: aggregateExpectationResults(options.expectations ?? [], expectationObservations),
            finalPage: page,
          };
        }
      } else {
        emptyFlowEndings = 0;
      }

      const stepsRemaining = options.maxSteps - actionCount;

      // Leftover budget after a flow ending must not just go unused. A new provider context keeps
      // the next flow independent from the completed one while the browser session is still reused.
      if (stepsRemaining > 0) {
        await page.goto(initialUrl);
        const restartSnapshot = await toStepResult(page);
        const restartScreenshot = options.captureScreenshots ? await captureScreenshot(page) : undefined;

        flowIndex += 1;
        flowStartIndex = history.length;
        flowNetworkStart = options.recorder?.network.length ?? 0;
        flowStartUrl = restartSnapshot.url;
        flowStartSnapshot = restartSnapshot.snapshot;
        flowStartStorageState = JSON.stringify(await page.context().storageState({ indexedDB: true }));
        flowActionStartCount = actionCount;

        turn = await provider.start({
          systemPrompt: systemPrompt(),
          tools: TOOL_DEFINITIONS,
          initialInput: nextFlowInput(flows, restartSnapshot, stepsRemaining),
          screenshot: restartScreenshot,
        });
        options.logger?.verbose(`    Exploring flow ${flowIndex + 1}`);
        options.logger?.debug("agent.turn_started", "New agent context started for the next flow", { flowIndex, remainingSteps: stepsRemaining });
        continue;
      }

      return {
        history,
        flows,
        exhausted: false,
        stopReason: "completed",
        expectationResults: aggregateExpectationResults(options.expectations ?? [], expectationObservations),
        finalPage: page,
      };
    }

    // A final provider turn may still classify the last observed browser state as a
    // completed flow, but it must never be allowed to execute another browser action.
    if (actionCount >= options.maxSteps) break;

    const { toolCall } = turn;
    let result: StepResult | undefined;
    let error: string | undefined;
    let resultText: string;
    const safetyCountBefore = options.getSafetyBlockCount?.() ?? 0;
    let safetyBlocked = 0;

    options.logger?.verbose(`      Action ${actionCount + 1}/${options.maxSteps}: ${actionDescription(toolCall.name, toolCall.input)}`);
    options.logger?.debug("agent.tool_call_requested", "Agent requested a tool call", {
      flowIndex, stepIndex: actionCount, tool: toolCall.name, input: toolCall.input,
    });

    try {
      const toolResult = await executeToolCall(page, toolCall);
      result = toolResult;
      resultText = `URL: ${result.url}\n${clipForCheckpoint(result.snapshot, MODEL_SNAPSHOT_MAX_CHARS)}`;
      if (result.expectation) {
        resultText += `\nExpectation ${result.expectation.expectationIndex}: ${result.expectation.status} — ${result.expectation.detail}`;
      }
      if (toolResult.activePage) {
        page = toolResult.activePage;
        configurePageTimeouts(page);
        options.recorder?.reattach(page);
      }
      options.logger?.debug("agent.tool_call_completed", "Browser action completed", {
        flowIndex, stepIndex: actionCount, tool: toolCall.name, url: result.url,
      });
    } catch (err) {
      error = (err as Error).message;
      resultText = `Error: ${error}`;
      options.logger?.verbose(`      Action ${actionCount + 1}/${options.maxSteps} failed: ${actionLabel(toolCall.name)} — ${actionFailureReason(error)}`);
      options.logger?.debug("agent.tool_call_failed", "Browser action failed", {
        flowIndex, stepIndex: actionCount, tool: toolCall.name, error,
      });
    }

    safetyBlocked = Math.max(0, (options.getSafetyBlockCount?.() ?? safetyCountBefore) - safetyCountBefore);
    if (safetyBlocked > 0) {
      resultText += `\nSafety policy blocked ${safetyBlocked} network request${safetyBlocked === 1 ? "" : "s"} during this action. The request was not sent; do not repeat the same action. Choose a different safe path or leave the flow incomplete.`;
      options.logger?.verbose(`      Action ${actionCount + 1}/${options.maxSteps} limited by safety policy: ${safetyBlocked} request${safetyBlocked === 1 ? "" : "s"} blocked`);
      options.logger?.debug("safety.action_blocked", "The action triggered one or more safety blocks", {
        flowIndex, stepIndex: actionCount, tool: toolCall.name, blockedRequests: safetyBlocked,
      });
    }

    const step: LoopStep = {
      toolCall: { name: toolCall.name, input: toolCall.input },
      result,
      error,
      safetyBlocked: safetyBlocked || undefined,
    };
    history.push(step);
    if (result?.expectation) {
      expectationObservations.push({ ...result.expectation, flowIndex, historyIndex: history.length - 1 });
    }
    options.onStep?.(step, history.length - 1, flowIndex);

    actionCount += 1;
    const screenshot = options.captureScreenshots ? await captureScreenshot(page) : undefined;
    if (actionCount >= options.maxSteps) {
      options.logger?.debug("agent.finalization_requested", "Requesting a flow classification after the final allowed browser action", {
        flowIndex, actionCount, maxSteps: options.maxSteps,
      });
      try {
        turn = await provider.continue({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: resultText,
          screenshot,
        });
      } catch (err) {
        options.logger?.debug("agent.finalization_failed", "Could not classify the final browser state", { error: (err as Error).message });
        break;
      }
      continue;
    }

    const checkpointEvery = options.contextCheckpointActions ?? DEFAULT_CONTEXT_CHECKPOINT_ACTIONS;
    if (checkpointEvery > 0 && actionCount % checkpointEvery === 0) {
      const currentSnapshot = result ?? await toStepResult(page);
      turn = await provider.start({
        systemPrompt: systemPrompt(),
        tools: TOOL_DEFINITIONS,
        initialInput: checkpointInput(history, flowStartIndex, currentSnapshot, flows, options.maxSteps - actionCount),
        screenshot,
      });
      options.logger?.debug("agent.context_checkpoint", "Agent context checkpoint created", { actionCount, remainingSteps: options.maxSteps - actionCount });
    } else {
      turn = await provider.continue({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: resultText,
        screenshot,
      });
    }
  }

  if (actionCount > flowActionStartCount) {
    const actionsInActiveFlow = actionCount - flowActionStartCount;
    options.logger?.verbose(`    Flow ${flowIndex + 1} incomplete: ${actionsInActiveFlow} action(s) executed before the exploration budget was reached`);
    options.logger?.debug("flow.incomplete", "Active flow did not reach a completion signal before budget exhaustion", {
      flowIndex, actions: actionsInActiveFlow, maxSteps: options.maxSteps,
    });
  }

  return {
    history,
    flows,
    exhausted: true,
    stopReason: "budget_exhausted",
    expectationResults: aggregateExpectationResults(options.expectations ?? [], expectationObservations),
    finalPage: page,
  };
}
