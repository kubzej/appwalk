import type { Browser, BrowserContext, Page } from "playwright";
import type { ToolCall } from "../providers/provider.js";
import type { FlowResult } from "../agent/loop.js";
import type { Persona } from "../agent/personas.js";
import type { TabRegistryHandle } from "../agent/tools.js";
import type { BrowserLifecycle } from "../browser/actions.js";
import type { CliArgs } from "./args.js";
import type { EvidenceEntry, EvidenceLog } from "../evidence/log.js";
import { EvidenceRecorder } from "../evidence/recorder.js";
import {
  applyResponseVariant,
  installResponseFixtures,
  responseFixtureMatchesSelector,
} from "../response/variants.js";
import type { ExpectationObservation } from "../types.js";
import type { GuardOptions } from "../safety/guard.js";
import { installDestructiveActionGuard } from "../safety/guard.js";
import { hasObservableReplayDifference, replay, type ReplayResult } from "../verify/replay.js";
import type { ReportResponseVariantAudit } from "../report/contract.js";
import type { Redactor } from "../security/redaction.js";
import type { Logger } from "../logging/logger.js";
import { attachCrashDetection, attachPopupDetection, attachWebSocketCapture } from "./browser-observability.js";
import { closeTrackedContexts, createBrowserLifecycle } from "./browser-lifecycle.js";
import { derivedEvidenceEntries, proposeResponseVariants } from "./response-variant-support.js";
import type { ConfirmedFlow, RuntimeErrorPhaseEntry } from "./run-types.js";
import { formatTestTitle } from "../codegen/spec.js";

export interface ResponseVariantRunnerInput {
  replayBrowser: Browser;
  baseFlow: ConfirmedFlow;
  flow: FlowResult;
  flowIndex: number;
  runId: string;
  actions: ToolCall[];
  expectedExpectations: ExpectationObservation[];
  baselineReplayResult: ReplayResult;
  responseVariantAudit: ReportResponseVariantAudit;
  args: CliArgs;
  persona?: Persona;
  provider: Parameters<typeof proposeResponseVariants>[0];
  model: string;
  apiKey: string | undefined;
  redactor: Redactor;
  flowLogger: Logger;
  guardOptions: GuardOptions;
  getSafetyBlockCount: () => number;
  navigateOrLogin: (page: Page, args: CliArgs, hasPreloadedState?: boolean, startUrl?: string, logger?: Logger) => Promise<void>;
  setActiveRecorder: (recorder: EvidenceRecorder) => void;
  trackedContexts: Set<BrowserContext>;
  evidenceLog: EvidenceLog;
}

export interface ResponseVariantRunnerResult {
  replayBrowser: Browser;
  confirmedFlows: ConfirmedFlow[];
  runtimeErrorEntries: RuntimeErrorPhaseEntry[];
}

/** Plans and replays derived response scenarios. The baseline replay is deliberately supplied as
 * data, so this module owns only the variant matrix and its artifacts. */
export async function runResponseVariants(input: ResponseVariantRunnerInput): Promise<ResponseVariantRunnerResult> {
  const {
    baseFlow,
    flow,
    flowIndex,
    runId,
    actions,
    expectedExpectations,
    baselineReplayResult,
    responseVariantAudit,
    args,
    persona,
    provider,
    model,
    apiKey,
    redactor,
    flowLogger,
    guardOptions,
    getSafetyBlockCount,
    navigateOrLogin,
    setActiveRecorder,
    trackedContexts,
    evidenceLog,
  } = input;
  let replayBrowser = input.replayBrowser;
  const runtimeErrorEntries: RuntimeErrorPhaseEntry[] = [];
  const confirmedFlows: ConfirmedFlow[] = [];
  let variants = [] as Awaited<ReturnType<typeof proposeResponseVariants>>["variants"];

  try {
    flowLogger.verbose(`Flow ${flowIndex + 1}: planning response scenarios`);
    const planning = await proposeResponseVariants(
      provider,
      model,
      apiKey,
      baseFlow.name,
      baseFlow.responseFixtures!,
      args.responseVariantMax!,
      baselineReplayResult.finalSnapshot,
      baselineReplayResult.steps.map((step) => ({ url: step.url, snapshot: step.snapshot })),
      redactor,
      flowLogger,
    );
    variants = planning.variants;
    responseVariantAudit.plannerCandidates = planning.candidates;
    responseVariantAudit.plannerRejected = planning.rejected;
    responseVariantAudit.plannerRejectionReasons = planning.rejectionReasons;
    responseVariantAudit.plannerReason = planning.reason;
    responseVariantAudit.proposed = variants.length;
    responseVariantAudit.planningStatus = planning.incomplete ? "incomplete" : "completed";
    flowLogger.verbose(`Flow ${flowIndex + 1}: response planner proposals=${planning.candidates}, accepted=${planning.variants.length}, rejected=${planning.rejected}`);
    if (planning.reason) flowLogger.verbose(`Flow ${flowIndex + 1}: response planner note: ${planning.reason}`);
  } catch (error) {
    const reason = (error as Error).message;
    responseVariantAudit.planningStatus = "failed";
    responseVariantAudit.plannerReason = reason;
    responseVariantAudit.skipped.push({ name: "planner", reason });
    flowLogger.warn(`Flow ${flowIndex + 1}: response scenario planning skipped`);
    flowLogger.debug("response_variants.planning_failed", "Response variant planning failed", { error: reason });
  }

  for (const [variantIndex, variant] of variants.entries()) {
    try {
      const variantFixtures = applyResponseVariant(baseFlow.responseFixtures!, variant);
      if (!variantFixtures) {
        responseVariantAudit.skipped.push({ name: variant.name, reason: "The proposed patch did not apply to the captured response." });
        continue;
      }
      const scenarioId = `derived-${runId}-${flowIndex + 1}-${variantIndex + 1}`;
      const variantStorageState = flowIndex > 0 && flow.startStorageState
        ? JSON.parse(flow.startStorageState)
        : args.storageStatePath;
      const variantTabRegistryHandle: TabRegistryHandle = { tabs: new Map() };
      let variantRecorder: EvidenceRecorder | undefined;
      let runtimeServicesReady = false;
      let variantSourceMatched = false;
      const fixturePages = new WeakSet<Page>();
      const browserLifecycle: BrowserLifecycle = createBrowserLifecycle({
        browserEngine: args.browserEngine,
        storageStatePath: args.storageStatePath,
        persona,
        prepareContext: async (context) => {
          if (!runtimeServicesReady) return;
          await installDestructiveActionGuard(context, guardOptions);
        },
        preparePage: async (page) => {
          if (!fixturePages.has(page)) {
            fixturePages.add(page);
            await installResponseFixtures(page, variantFixtures, {
              onFixtureApplied: (fixture, requestUrl) => {
                if (responseFixtureMatchesSelector(fixture, {
                  method: variant.sourceMethod,
                  url: variant.sourceUrl,
                  occurrence: variant.sourceOccurrence,
                })) {
                  variantSourceMatched = true;
                  flowLogger.debug("response_variant.source_applied", "Variant source response was applied", {
                    method: fixture.method,
                    sourceUrl: fixture.url,
                    occurrence: fixture.occurrence,
                    requestUrl,
                  });
                }
              },
            });
          }
          if (!runtimeServicesReady || !variantRecorder) return;
          variantRecorder.reattach(page);
          attachPopupDetection(page, flowLogger, variantTabRegistryHandle);
          attachCrashDetection(page, variantRecorder);
          attachWebSocketCapture(page, variantRecorder);
        },
      });
      const variantContext = await browserLifecycle.createContext(replayBrowser, variantStorageState);
      trackedContexts.add(variantContext);
      const variantPage = await browserLifecycle.createPage(variantContext);
      await browserLifecycle.preparePage(variantPage);
      await navigateOrLogin(
        variantPage,
        args,
        flowIndex > 0 && Boolean(flow.startStorageState),
        flowIndex > 0 && flow.startUrl ? flow.startUrl : args.url,
        flowLogger,
      );
      variantRecorder = new EvidenceRecorder(variantContext, flowLogger, { redactor });
      setActiveRecorder(variantRecorder);
      runtimeServicesReady = true;
      await browserLifecycle.prepareContext(variantContext);
      await browserLifecycle.preparePage(variantPage);
      const variantResult = await replay(
        variantPage,
        actions,
        persona?.verificationMode ?? "completion",
        variantRecorder,
        expectedExpectations,
        variant.expectation,
        flowLogger.child({ scenarioId }),
        getSafetyBlockCount,
        { selector: { method: variant.sourceMethod, url: variant.sourceUrl, occurrence: variant.sourceOccurrence }, isMatched: () => variantSourceMatched },
        async (newPage) => {
          trackedContexts.add(newPage.context());
          await browserLifecycle.prepareContext(newPage.context());
          await browserLifecycle.preparePage(newPage);
        },
        variantTabRegistryHandle,
        guardOptions,
        undefined,
        browserLifecycle,
      );
      runtimeErrorEntries.push(...variantRecorder.runtimeErrors.map((error) => ({ error, phase: "replay" as const, flowIndex: flowIndex + 1 })));
      const variantExpectationResult = variantResult.variantExpectationResult;
      const activeVariantBrowser = variantResult.finalPage.context().browser();
      if (activeVariantBrowser && activeVariantBrowser !== replayBrowser) replayBrowser = activeVariantBrowser;
      const variantResultContext = variantResult.finalPage.context();
      await variantResult.finalPage.close();
      trackedContexts.add(variantResultContext);
      await closeTrackedContexts(trackedContexts, flowLogger, `flow ${flowIndex + 1} response variant ${variantIndex + 1}`);

      if (!variantResult.reproduced) {
        responseVariantAudit.skipped.push({ name: variant.name, reason: variantResult.failedAt
          ? `Replay failed at step ${variantResult.failedAt.index}: ${variantResult.failedAt.error}`
          : variantResult.safetyBlocked > 0
            ? `Replay was limited by the safety policy: ${variantResult.safetyBlocked} request${variantResult.safetyBlocked === 1 ? "" : "s"} blocked.`
            : variantResult.variantSourceMatched === false
              ? "The source response was not observed during replay."
              : variantResult.variantExpectationResult?.expectation?.status !== "met"
                ? "The derived expectation was not observed after the source response was applied."
                : variantResult.expectationsReproduced ? "Replay did not satisfy the flow verification." : "Replay did not reproduce the original expectation signals." });
        flowLogger.verbose(`Response scenario "${variant.name}": replay failed`);
        continue;
      }
      if (variantExpectationResult?.expectation?.status !== "met") {
      responseVariantAudit.skipped.push({ name: variant.name, reason: "The derived expectation was not observed after the source response was applied." });
        flowLogger.verbose(`Response scenario "${variant.name}": expectation not observed`);
        continue;
      }
      if (!hasObservableReplayDifference(baselineReplayResult, variantResult)) {
        responseVariantAudit.skipped.push({ name: variant.name, reason: "The response patch caused no observable UI difference." });
        flowLogger.verbose(`Response scenario "${variant.name}": no observable UI difference`);
        continue;
      }

      const variantEntries = derivedEvidenceEntries(
        actions,
        variantResult.steps,
        runId,
        flowIndex,
        scenarioId,
        variantExpectationResult,
        variantResult.variantExpectationStep,
        { expectationIndex: 1, assertion: variant.expectation.assertion, locator: variant.expectation.locator, value: variant.expectation.value },
      );
      const safeVariantEntries = variantEntries.map((entry) => redactor.redact(entry, { preserveToolInputs: true }) as EvidenceEntry);
      for (const entry of safeVariantEntries) evidenceLog.append(entry);
      confirmedFlows.push({
        name: `${baseFlow.name} — ${variant.name}`,
        title: `${baseFlow.title ?? formatTestTitle(baseFlow.name)} — ${variant.name}`,
        entries: safeVariantEntries,
        startUrl: baseFlow.startUrl,
        startStorageState: baseFlow.startStorageState,
        responseFixtures: variantFixtures,
        fixtureBaseId: baseFlow.fixtureBaseId,
        baseResponseFixtures: baseFlow.responseFixtures,
        origin: "derived",
        sourceFlowIndex: flowIndex,
        scenarioId,
        responseVariant: variant,
        devicePreset: baseFlow.devicePreset,
      });
      responseVariantAudit.confirmed += 1;
      responseVariantAudit.confirmedScenarios.push(variant.name);
      flowLogger.verbose(`Response scenario "${variant.name}": replay confirmed`);
    } catch (error) {
      await closeTrackedContexts(trackedContexts, flowLogger, `flow ${flowIndex + 1} response variant ${variantIndex + 1} failure`);
      responseVariantAudit.skipped.push({ name: variant.name, reason: (error as Error).message });
      flowLogger.verbose(`Response scenario "${variant.name}": replay skipped`);
      flowLogger.debug("response_variant.failed", "Response scenario replay failed", { name: variant.name, error: (error as Error).message });
    }
  }
  flowLogger.verbose(`Flow ${flowIndex + 1}: response scenarios accepted=${responseVariantAudit.proposed}, rejected=${responseVariantAudit.plannerRejected}, confirmed=${responseVariantAudit.confirmed}, skipped=${responseVariantAudit.skipped.length}`);
  return { replayBrowser, confirmedFlows, runtimeErrorEntries };
}
