import type { ToolCallResult } from "../agent/tools.js";
import type { ProviderName } from "../config.js";
import type { EvidenceEntry } from "../evidence/log.js";
import { RESPONSE_VARIANT_MAX_OUTPUT_TOKENS, responseVariantPrompt, parseResponseVariantsDetailed, type ResponseFixture, type ResponseVariantParseResult } from "../response/variants.js";
import { createProvider } from "./provider-factory.js";
import { appLogger } from "./logger-state.js";
import { Redactor } from "../security/redaction.js";
import type { Logger } from "../logging/logger.js";
import type { StepResult } from "../types.js";
import type { ToolCall } from "../providers/provider.js";

export async function proposeResponseVariants(
  provider: ProviderName,
  model: string,
  apiKey: string | undefined,
  flowName: string,
  fixtures: ResponseFixture[],
  maxVariants: number,
  finalSnapshot: string,
  replayTimeline: Array<{ url: string; snapshot: string }>,
  redactor: Redactor,
  logger: Logger = appLogger,
): Promise<ResponseVariantParseResult> {
  const plannerLogger = logger.child({ operation: "response_variant_planner" });
  plannerLogger.debug("response_variants.planning_started", "Response variant planning started", {
    flowName,
    fixtureCount: fixtures.length,
    maxVariants,
    maxOutputTokens: RESPONSE_VARIANT_MAX_OUTPUT_TOKENS,
    replaySteps: replayTimeline.length,
  });
  const planner = createProvider(provider, model, apiKey, redactor, plannerLogger);
  const turn = await planner.start({
    systemPrompt:
      "You are a conservative response-variant planner for browser test generation. Return only the JSON requested by the user. Never invent application behavior or fields.",
    tools: [],
    initialInput: responseVariantPrompt(flowName, fixtures, maxVariants, finalSnapshot, replayTimeline),
    maxOutputTokens: RESPONSE_VARIANT_MAX_OUTPUT_TOKENS,
  });
  if (turn.type !== "text") {
    const result = {
      variants: [],
      candidates: 0,
      rejected: 0,
      rejectionReasons: [],
      reason: "Planner did not return a text response.",
    };
    plannerLogger.debug("response_variants.planning_parsed", "Response variant planner returned no text proposals", {
      responseType: turn.type,
      candidates: result.candidates,
      accepted: result.variants.length,
      rejected: result.rejected,
      reason: result.reason,
    });
    return result;
  }
  const result = parseResponseVariantsDetailed(turn.text, fixtures, maxVariants);
  if (turn.incompleteReason) {
    result.incomplete = true;
    result.reason = `Planner response was incomplete: ${turn.incompleteReason}.`;
  }
  plannerLogger.debug("response_variants.planning_response", "Response variant planner response received", {
    responseType: turn.type,
    responseLength: turn.text.length,
    incompleteReason: turn.incompleteReason,
    plannerReason: result.plannerReason,
  });
  plannerLogger.debug("response_variants.planning_parsed", "Response variant planner output parsed", {
    candidates: result.candidates,
    accepted: result.variants.length,
    rejected: result.rejected,
    rejectionReasons: result.rejectionReasons,
    reason: result.reason,
  });
  return result;
}

export function derivedEvidenceEntries(
  actions: ToolCall[],
  steps: StepResult[],
  runId: string,
  flowIndex: number,
  scenarioId: string,
  expectationResult?: ToolCallResult,
  expectationStepIndex?: number,
  expectationInput?: Record<string, unknown>,
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  if (expectationResult && expectationStepIndex === -1) {
    entries.push({
      index: entries.length,
      flowIndex,
      runId,
      scenarioId,
      origin: "derived",
      timestamp: new Date().toISOString(),
      toolCall: { name: "verifyExpectation", input: expectationInput ?? {} },
      result: expectationResult,
      network: [],
      console: [],
      runtimeErrors: [],
    });
  }
  actions.forEach((action, index) => {
    entries.push({
      index: entries.length,
      flowIndex,
      runId,
      scenarioId,
      origin: "derived",
      timestamp: new Date().toISOString(),
      toolCall: { name: action.name, input: action.input },
      result: steps[index],
      network: [],
      console: [],
      runtimeErrors: [],
    });
    if (expectationResult && expectationStepIndex === index) {
      entries.push({
        index: entries.length,
        flowIndex,
        runId,
        scenarioId,
        origin: "derived",
        timestamp: new Date().toISOString(),
        toolCall: { name: "verifyExpectation", input: expectationInput ?? {} },
        result: expectationResult,
        network: [],
        console: [],
        runtimeErrors: [],
      });
    }
  });
  if (expectationResult && expectationStepIndex === undefined) {
    entries.push({
      index: entries.length,
      flowIndex,
      runId,
      scenarioId,
      origin: "derived",
      timestamp: new Date().toISOString(),
      toolCall: { name: "verifyExpectation", input: expectationInput ?? {} },
      result: expectationResult,
      network: [],
      console: [],
      runtimeErrors: [],
    });
  }
  return entries;
}
