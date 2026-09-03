import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { runAgentLoop, type LoopResult } from "../agent/loop.js";
import { PERSONAS, type PersonaIntent } from "../agent/personas.js";
import type { TabRegistryHandle } from "../agent/tools.js";
import { login } from "../browser/login.js";
import { EvidenceLog, readEvidenceLog, type EvidenceEntry, type EvidenceReadIssue } from "../evidence/log.js";
import { EvidenceRecorder, type RuntimeErrorEntry } from "../evidence/recorder.js";
import {
  extractResponseFixtures,
} from "../response/variants.js";
import type { ExpectationObservation } from "../types.js";
import type { SafetyConfig } from "../safety/guard.js";
import { installDestructiveActionGuard } from "../safety/guard.js";
import { logError } from "../logging/logger.js";
import { Redactor } from "../security/redaction.js";
import type {
  ReportFlow,
  ReportResponseVariantAudit,
  ReportRuntimeError,
  ReportSafety,
  ReportStopReason,
} from "../report/contract.js";
import { extractActions, type ReplayResult } from "../verify/replay.js";
import type { CliArgs } from "./args.js";
import { EXIT_CODES } from "../exit-codes.js";
import type { DiscoveryManifest, DiscoveryManifestFlow, DiscoveryManifestRun } from "./manifest.js";
import { appLogger } from "./logger-state.js";
import { createProvider } from "./provider-factory.js";
import { executeReplay } from "./replay-execution.js";
import { runResponseVariants } from "./response-variant-runner.js";
import type { ConfirmedFlow, FlowFinding, SafetyEvent } from "./run-types.js";
import {
  closeBrowserWithTimeout,
  closeTrackedContexts,
  createBrowserLifecycle,
} from "./browser-lifecycle.js";
import {
  attachCrashDetection,
  attachPopupDetection,
  attachWebSocketCapture,
  createTraceSession,
} from "./browser-observability.js";

export { deviceContextOptions } from "./browser-lifecycle.js";
export { attachCrashDetection, attachPopupDetection, attachWebSocketCapture, createTraceSession, startTracing, stopTracing } from "./browser-observability.js";

export interface ExplorationRun {
  runId: string;
  runName: string;
  args: CliArgs;
  evidencePath: string;
  allEntries: EvidenceEntry[];
  discovery?: LoopResult;
  confirmedFlows: ConfirmedFlow[];
  replayConfirmedIds: number[];
  findings: FlowFinding[];
  responseVariantAudits: ReportResponseVariantAudit[];
  safety: ReportSafety;
  runtimeErrors: ReportRuntimeError[];
  replayFailures: Record<number, NonNullable<ReportFlow["replayFailure"]>>;
  error?: string;
}

export interface ExplorationBatch {
  executionId: string;
  args: CliArgs;
  evidencePath: string;
  runs: ExplorationRun[];
  allEntries: EvidenceEntry[];
  confirmedFlows: ConfirmedFlow[];
  evidenceIssues: EvidenceReadIssue[];
  redactor: Redactor;
}

function emptySafety(): ReportSafety {
  return { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 };
}

export function runOutcome(run: ExplorationRun): { personaIntent: PersonaIntent | undefined; exhausted: boolean; stopReason: ReportStopReason } {
  return {
    personaIntent: run.args.personaName ? PERSONAS[run.args.personaName]?.intent : undefined,
    exhausted: run.discovery?.exhausted ?? false,
    stopReason: run.discovery?.stopReason ?? (run.error ? "error" : "completed"),
  };
}

function summarizeSafety(events: SafetyEvent[]): ReportSafety {
  const byMethod: Record<string, number> = {};
  for (const event of events) byMethod[event.method] = (byMethod[event.method] ?? 0) + 1;
  const samples: ReportSafety["samples"] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const key = `${event.phase}:${event.method}:${event.url}`;
    if (seen.has(key) || samples.length >= 20) continue;
    seen.add(key);
    samples.push(event);
  }
  return {
    blockedRequests: events.length,
    explorationBlocked: events.filter((event) => event.phase === "exploration").length,
    replayBlocked: events.filter((event) => event.phase === "replay").length,
    byMethod,
    samples,
    safetyRelatedRuntimeErrors: 0,
  };
}

function summarizeRuntimeErrors(
  entries: Array<{ error: RuntimeErrorEntry; phase: "exploration" | "replay"; flowIndex?: number }>,
): ReportRuntimeError[] {
  const grouped = new Map<string, ReportRuntimeError>();
  for (const entry of entries) {
    const { error, phase, flowIndex } = entry;
    const key = JSON.stringify([phase, flowIndex, error.kind, error.message, error.method, error.url, error.status, error.safetyRelated, error.lifecycle]);
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    grouped.set(key, { ...error, phase, flowIndex, occurrences: 1 });
  }
  return [...grouped.values()];
}

function classifyReplayFailure(
  result: ReplayResult,
  runtimeErrors: RuntimeErrorEntry[],
): NonNullable<ReportFlow["replayFailure"]>["cause"] {
  const authenticationSnapshot = /(?:sign\s*in|log\s*in|username|password)/i.test(result.finalSnapshot);
  const unauthorizedResponse = runtimeErrors.some((error) =>
    error.status === 401 || error.status === 403 || /status(?: of)? (?:401|403)/i.test(error.message),
  );
  if (/\/login(?:[/?#]|$)/i.test(result.finalUrl) || authenticationSnapshot || unauthorizedResponse) return "authentication";
  if (/loading|skeleton|spinner/i.test(result.finalSnapshot)) return "loading";
  if (runtimeErrors.some((error) => !error.lifecycle && (error.kind === "http_error" || error.kind === "request_failed"))) return "request";
  if (result.safetyBlocked > 0) return "safety";
  if (result.failedAt) return "action";
  if (!result.expectationsReproduced) return "expectation";
  return "verification";
}

function loadSafetyConfig(path: string | undefined): SafetyConfig | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as SafetyConfig;
}

async function navigateOrLogin(page: Page, args: CliArgs, hasPreloadedState = false, startUrl = args.url, logger = appLogger) {
  if (hasPreloadedState || args.storageStatePath) {
    logger.debug("browser.navigation_started", "Navigating with preloaded storage state", { startUrl });
    await page.goto(startUrl);
  } else if (args.email && args.password) {
    logger.debug("browser.navigation_started", "Navigating with credential login", { startUrl });
    await login(page, startUrl, args.email, args.password, logger);
  } else {
    logger.debug("browser.navigation_started", "Navigating as an anonymous session", { startUrl });
    await page.goto(startUrl);
  }
}

export function redactorForArgs(args: CliArgs): Redactor {
  const apiKeyEnvVar = args.provider === "gemini"
    ? "GEMINI_API_KEY"
    : args.provider === "grok"
      ? "XAI_API_KEY"
      : args.provider === "openai"
        ? "OPENAI_API_KEY"
        : "ANTHROPIC_API_KEY";
  return new Redactor([
    args.email,
    args.password,
    args.storageStatePath,
    args.safetyConfigPath,
    args.provider === "ollama" ? undefined : process.env[apiKeyEnvVar],
  ]);
}

function validatePersona(args: CliArgs) {
  const persona = args.personaName ? PERSONAS[args.personaName] : undefined;
  if (args.personaName && !persona) {
    appLogger.error("Unknown persona \"" + args.personaName + "\". Available: " + Object.keys(PERSONAS).join(", "));
    process.exit(EXIT_CODES.executionError);
  }
  return persona;
}

async function exploreAndVerify(args: CliArgs, evidenceLog: EvidenceLog, runId: string, runName: string, signal?: AbortSignal): Promise<ExplorationRun> {
  return exploreAndVerifyInBrowser(args, evidenceLog, runId, runName, signal);
}

async function exploreAndVerifyInBrowser(
  args: CliArgs,
  evidenceLog: EvidenceLog,
  runId: string,
  runName: string,
  signal?: AbortSignal,
): Promise<ExplorationRun> {
  const persona = validatePersona(args);
  const runLogger = appLogger.child({ runId, persona: args.personaName ?? runName });
  const provider = args.provider;
  const model = args.model;
  if (!provider || !model) throw new Error("Provider and model must be configured before starting an exploration run.");
  const requiresApiKey = provider !== "ollama";
  const apiKeyEnvVar =
    provider === "gemini"
      ? "GEMINI_API_KEY"
      : provider === "grok"
        ? "XAI_API_KEY"
        : provider === "openai"
          ? "OPENAI_API_KEY"
          : "ANTHROPIC_API_KEY";
  const apiKey = requiresApiKey ? process.env[apiKeyEnvVar] : undefined;
  if (requiresApiKey && !apiKey) {
    throw new Error("Set " + apiKeyEnvVar + " before starting an exploration run.");
  }
  const redactor = redactorForArgs(args);

  const evidencePath = join(args.output, "evidence.jsonl");
  const safetyConfig = loadSafetyConfig(args.safetyConfigPath);
  const safetyEvents: SafetyEvent[] = [];
  let safetyPhase: SafetyEvent["phase"] = "exploration";
  let activeRecorder: EvidenceRecorder | undefined;
  let runtimeServicesReady = false;
  let traceSession: import("./browser-observability.js").TraceSession | undefined;
  // Kept pointed at whichever flow's tab registry is current inside runAgentLoop (rebuilt per
  // flow), so a popup discovered mid-exploration lands in the registry the agent's next switchTab
  // call will actually read, not a stale one from a flow that already ended.
  const tabRegistryHandle: TabRegistryHandle = { tabs: new Map() };
  const guardOptions = {
    allowDestructive: args.allowDestructive,
    blockMethods: args.blockMethods,
    config: safetyConfig,
    logger: runLogger,
    onBlocked: (request: { method: string; url: string }) => {
      safetyEvents.push({ phase: safetyPhase, ...request });
      activeRecorder?.markSafetyBlocked(request);
    },
  };

  const browserLifecycle = createBrowserLifecycle({
    browserEngine: args.browserEngine,
    storageStatePath: args.storageStatePath,
    persona,
    prepareContext: async (context) => {
      if (!runtimeServicesReady) return;
      await installDestructiveActionGuard(context, guardOptions);
    },
    preparePage: async (page) => {
      if (!runtimeServicesReady) return;
      activeRecorder?.reattach(page);
      attachPopupDetection(page, runLogger, tabRegistryHandle);
      attachCrashDetection(page, activeRecorder!);
      attachWebSocketCapture(page, activeRecorder!);
      await traceSession?.switchTo(page);
    },
  });
  const browser = await runLogger.task("Launching browser", () => browserLifecycle.launchBrowser());
  try {

  // All contexts/pages in exploration are created through the lifecycle adapter. That keeps the
  // persona's context settings and page timeout contract identical across the initial page, tabs,
  // cloned contexts, and a browser restart.
  const context = await browserLifecycle.createContext(browser);
  const page = await browserLifecycle.createPage(context);
  attachPopupDetection(page, runLogger, tabRegistryHandle);
  const runEntries: EvidenceEntry[] = [];

  await runLogger.task("Navigating to application URL", () => navigateOrLogin(page, args, false, args.url, runLogger));
  // Start recording after setup so login and token-refresh traffic never become application
  // fixtures. Also context-scoped, for the same reason.
  const recorder = new EvidenceRecorder(context, runLogger, { redactor });
  activeRecorder = recorder;
  traceSession = args.trace
    ? await createTraceSession(context, join(args.output, `trace-exploration-${runId}.zip`), runLogger)
    : undefined;
  runtimeServicesReady = true;
  await browserLifecycle.prepareContext(context);
  await browserLifecycle.preparePage(page);

  runLogger.phase("Exploring application");
  const discovery = await runAgentLoop(page, createProvider(provider, model, apiKey, redactor, runLogger), {
    maxSteps: args.maxSteps,
    recorder,
    captureScreenshots: args.screenshots,
    persona,
    scope: args.scope,
    expectations: args.expectations,
    logger: runLogger,
    getSafetyBlockCount: () => safetyEvents.filter((event) => event.phase === "exploration").length,
    tabRegistryHandle,
    redactor,
    safety: guardOptions,
    signal,
    browserRestartHooks: traceSession,
    browserLifecycle,
    // The lifecycle adapter prepares every new context/page before its first navigation. This
    // callback remains the single active-page handoff for the loop, including same-context tabs.
    onActivePageChange: async (newPage) => {
      await browserLifecycle.prepareContext(newPage.context());
      await browserLifecycle.preparePage(newPage);
    },
    onStep: (step, index, flowIndex) => {
      const { network, console: consoleEntries, runtimeErrors, webSocketFrames } = recorder.drain();
        const entry = {
          index,
          flowIndex,
          runId,
          timestamp: new Date().toISOString(),
          ...step,
          network,
          console: consoleEntries,
          runtimeErrors,
          webSocketFrames,
        } satisfies EvidenceEntry;
        const safeEntry = redactor.redact(entry, { preserveToolInputs: true }) as EvidenceEntry;
        runEntries.push(safeEntry);
        evidenceLog.append(safeEntry);
      },
  });
  runLogger.debug("exploration.finalization_started", "Finalizing exploration evidence and browser session");
  await recorder.waitForPendingBodies();
  await traceSession?.finish();
  await closeBrowserWithTimeout(discovery.finalPage.context().browser(), runLogger, "exploration");
  runLogger.debug("exploration.finalization_completed", "Exploration cleanup completed");
  const explorationBlockedRequests = safetyEvents.filter((event) => event.phase === "exploration").length;
  if (explorationBlockedRequests > 0) {
    runLogger.warn(`Safety policy blocked ${explorationBlockedRequests} destructive request${explorationBlockedRequests === 1 ? "" : "s"} during exploration`);
  }
  runLogger.info(`Exploration completed: ${discovery.flows.length} flow(s) found${discovery.exhausted ? "; action budget reached" : ""}`);
  runLogger.debug("exploration.completed", "Exploration completed", { flowsFound: discovery.flows.length, exhausted: discovery.exhausted });

  const verifiedFlows = discovery.flows
    .map((flow, index) => ({ flow, index }))
    .filter(({ flow }) => flow.verified || persona?.intent === "challenge");
  const allEntries = runEntries;
  const confirmedFlows: ConfirmedFlow[] = [];
  const replayConfirmedIds: number[] = [];
  const findings: FlowFinding[] = [];
  const responseVariantAudits: ReportResponseVariantAudit[] = [];
  const replayFailures: Record<number, NonNullable<ReportFlow["replayFailure"]>> = {};
  const runtimeErrorEntries: Array<{ error: RuntimeErrorEntry; phase: "exploration" | "replay"; flowIndex?: number }> = recorder.runtimeErrors.map((error) => ({ error, phase: "exploration" }));
  let runError: string | undefined;

  if (verifiedFlows.length > 0) {
    runLogger.phase(`Verifying ${verifiedFlows.length} of ${discovery.flows.length} discovered flow(s) by replay in a clean session`);
    if (args.trace) mkdirSync(join(args.output, "traces"), { recursive: true });
    let replayBrowser: Browser | undefined;
    const replayContexts = new Set<BrowserContext>();
    try {
      replayBrowser = await browserLifecycle.launchBrowser();
      try {
        for (const { flow, index } of verifiedFlows) {
        safetyPhase = "replay";
        const flowLogger = runLogger.child({ flowIndex: index + 1 });
        const flowEntries = allEntries.filter((entry) => entry.flowIndex === index);
        const actions = extractActions(flowEntries);
        const hasCoreAction =
          !persona?.coreActionTypes ||
          actions.some((action) => persona.coreActionTypes!.includes(action.name));
        const findingCandidate = persona?.intent === "challenge" && !flow.verified && hasCoreAction;
        const expectedExpectations = flowEntries
          .filter((entry) => entry.result?.expectation)
          .map((entry) => entry.result!.expectation!) as ExpectationObservation[];
        if (!replayBrowser) throw new Error("Replay browser was not initialized.");
        const replayExecution = await executeReplay({
          replayBrowser,
          flow,
          flowIndex: index,
          runId,
          actions,
          expectedExpectations,
          args,
          persona,
          redactor,
          flowLogger,
          guardOptions,
          getSafetyBlockCount: () => safetyEvents.filter((event) => event.phase === "replay").length,
          navigateOrLogin,
          setActiveRecorder: (nextRecorder) => { activeRecorder = nextRecorder; },
          trackedContexts: replayContexts,
        });
        replayBrowser = replayExecution.replayBrowser;
        const replayResult = replayExecution.replayResult;
        const replayRecorder = replayExecution.replayRecorder;
        runtimeErrorEntries.push(...replayRecorder.runtimeErrors.map((error) => ({ error, phase: "replay" as const, flowIndex: index + 1 })));
        if (!replayResult.reproduced) {
          replayFailures[index] = {
            reason: replayResult.failedAt
              ? "A recorded action could not be completed in the clean replay session."
              : replayResult.safetyBlocked > 0
                ? "Replay was limited by the safety policy."
                : !replayResult.expectationsReproduced
                  ? "The replay did not reproduce the recorded expectation signals."
                : "The replay did not reach the recorded verification state.",
            cause: classifyReplayFailure(replayResult, replayRecorder.runtimeErrors),
            step: replayResult.failedAt ? replayResult.failedAt.index + 1 : undefined,
            action: replayResult.failedAt?.action,
            error: replayResult.failedAt?.error,
            lastUrl: replayResult.finalUrl,
            lastSnapshot: replayResult.finalSnapshot,
          };
        }
        if (findingCandidate) {
          const confirmedFinding =
            !replayResult.failedAt &&
            replayResult.safetyBlocked === 0 &&
            replayResult.expectationsReproduced &&
            !replayResult.verificationPassed;
          const finding: FlowFinding = {
            flowIndex: index,
            status: confirmedFinding ? "confirmed" : "inconclusive",
            summary: flow.finalText || "The application did not satisfy the challenge verification condition.",
            failure: replayResult.failedAt
              ? `step ${replayResult.failedAt.index}, ${replayResult.failedAt.action}: ${replayResult.failedAt.error}`
              : replayResult.safetyBlocked > 0
                ? `Replay was limited by safety policy: ${replayResult.safetyBlocked} request${replayResult.safetyBlocked === 1 ? "" : "s"} blocked.`
              : !replayResult.expectationsReproduced
                ? "The replay did not reproduce one or more expectation signals."
                : replayResult.verificationPassed
                  ? "The replay defended the application on the clean session."
                  : undefined,
          };
          findings.push(finding);
          flowLogger.warn(`Flow ${index + 1}: ${confirmedFinding ? "finding confirmed" : "finding inconclusive"}${finding.failure ? ` (${finding.failure})` : ""}`);
          continue;
        }

        if (!replayResult.reproduced) {
          if (replayResult.failedAt) {
            flowLogger.warn(`Flow ${index + 1} not confirmed: replay could not complete the ${replayResult.failedAt.action} action at step ${replayResult.failedAt.index + 1}`);
            flowLogger.debug("replay.step_failed", "Replay action failed", { stepIndex: replayResult.failedAt.index, action: replayResult.failedAt.action, error: replayResult.failedAt.error });
          } else if (!replayResult.expectationsReproduced) {
            flowLogger.warn(`Flow ${index + 1} not confirmed: expected result was not reproduced`);
          } else if (replayResult.safetyBlocked > 0) {
            flowLogger.warn(`Flow ${index + 1} not confirmed: replay was limited by safety policy (${replayResult.safetyBlocked} request${replayResult.safetyBlocked === 1 ? "" : "s"} blocked)`);
          } else {
            flowLogger.warn(`Flow ${index + 1} not confirmed: expected final state was not reached`);
          }
          continue;
        }
        flowLogger.success(`Flow ${index + 1} replay confirmed`);
        replayConfirmedIds.push(index + 1);
        const baseFlow: ConfirmedFlow = {
          name: flow.finalText || "Flow " + (index + 1),
          title: flow.title,
          entries: flowEntries,
          startUrl: index === 0 ? undefined : flow.startUrl,
          startStorageState: index === 0 ? undefined : flow.startStorageState,
          responseFixtures: extractResponseFixtures(flowEntries, args.url, args.responseFixtureMaxBytes, redactor),
          origin: "discovered",
          sourceFlowIndex: index,
          fixtureBaseId: `${runId}-flow-${index + 1}`,
          devicePreset: persona?.devicePreset,
        };
        confirmedFlows.push(baseFlow);

        const responseVariantAudit: ReportResponseVariantAudit = {
          flowIndex: index,
          enabled: (args.responseVariantMax ?? 0) > 0,
          fixturesFound: baseFlow.responseFixtures?.length ?? 0,
          fixtures: (baseFlow.responseFixtures ?? []).map((fixture) => ({
            method: fixture.method,
            url: fixture.url,
            bytes: JSON.stringify(fixture.body).length,
          })),
          planningStatus: (args.responseVariantMax ?? 0) > 0 && (baseFlow.responseFixtures?.length ?? 0) > 0 ? "completed" :
            (args.responseVariantMax ?? 0) > 0 ? "not_run" : "not_enabled",
          plannerCandidates: 0,
          plannerRejected: 0,
          plannerRejectionReasons: [],
          proposed: 0,
          confirmed: 0,
          confirmedScenarios: [],
          skipped: [],
        };
        responseVariantAudits.push(responseVariantAudit);

        if (baseFlow.responseFixtures?.length && responseVariantAudit.enabled) {
          const variantRun = await runResponseVariants({
            replayBrowser,
            baseFlow,
            flow,
            flowIndex: index,
            runId,
            actions,
            expectedExpectations,
            baselineReplayResult: replayResult,
            responseVariantAudit,
            args,
            persona,
            provider,
            model,
            apiKey,
            redactor,
            flowLogger,
            guardOptions,
            getSafetyBlockCount: () => safetyEvents.filter((event) => event.phase === "replay").length,
            navigateOrLogin,
            setActiveRecorder: (nextRecorder) => { activeRecorder = nextRecorder; },
            trackedContexts: replayContexts,
            evidenceLog,
          });
          replayBrowser = variantRun.replayBrowser;
          confirmedFlows.push(...variantRun.confirmedFlows);
          runtimeErrorEntries.push(...variantRun.runtimeErrorEntries);

        }
        await closeTrackedContexts(replayContexts, flowLogger, `flow ${index + 1} finalization`);
        }
      } finally {
        const replayBlockedRequests = safetyEvents.filter((event) => event.phase === "replay").length;
        if (replayBlockedRequests > 0) {
          runLogger.warn(`Safety policy blocked ${replayBlockedRequests} destructive request${replayBlockedRequests === 1 ? "" : "s"} during replay`);
        }
        await closeTrackedContexts(replayContexts, runLogger, "replay finalization");
        await closeBrowserWithTimeout(replayBrowser, runLogger, "replay");
      }
    } catch (error) {
      runError = logError(error);
      runLogger.error(`Replay stopped before all discovered flows were verified: ${runError}`);
      runLogger.debug("replay.incomplete", "Replay stopped with partial results", {
        confirmedFlows: confirmedFlows.length,
        replayConfirmed: replayConfirmedIds.length,
        findings: findings.length,
        error: runError,
      });
    }
  } else {
    runLogger.warn("No flows were ready for replay");
  }

  const summarizedRuntimeErrors = summarizeRuntimeErrors(runtimeErrorEntries);
  const summarizedSafety = summarizeSafety(safetyEvents);
  summarizedSafety.safetyRelatedRuntimeErrors = runtimeErrorEntries
    .filter(({ error }) => error.safetyRelated)
    .reduce((total) => total + 1, 0);

  return {
    runId,
    runName,
    args,
    evidencePath,
    allEntries,
    discovery,
    confirmedFlows,
    replayConfirmedIds,
    findings,
    responseVariantAudits,
    safety: summarizedSafety,
    runtimeErrors: summarizedRuntimeErrors,
    replayFailures,
    error: runError,
  };
  } finally {
    await closeBrowserWithTimeout(browser, runLogger, "exploration owner");
  }
}

function createCoverageRuns(args: CliArgs): Array<{ id: string; name: string; args: CliArgs }> {
  const configuredRuns = args.coverageRuns?.length
    ? args.coverageRuns
    : [{ name: args.personaName ? `${args.personaName} baseline` : "default" }];

  return configuredRuns.map((run, index) => ({
    id: `run-${index + 1}`,
    name: run.name,
    args: {
      ...args,
      coverageRuns: undefined,
      personaName: run.persona ?? args.personaName,
      maxSteps: run.maxSteps ?? args.maxSteps,
      scope: run.scope ?? args.scope,
      expectations: run.expect !== undefined ? run.expect : args.expectations,
    },
  }));
}

export async function exploreCoverage(args: CliArgs, executionId: string, signal?: AbortSignal): Promise<ExplorationBatch> {
  mkdirSync(args.output, { recursive: true });
  const evidencePath = join(args.output, "evidence.jsonl");
  const redactor = redactorForArgs(args);
  const evidenceLog = new EvidenceLog(evidencePath, redactor);
  const runs: ExplorationRun[] = [];

  const configuredRuns = createCoverageRuns(args);
  for (const [runIndex, configuredRun] of configuredRuns.entries()) {
    const personaLabel = configuredRun.args.personaName ?? configuredRun.name;
    const batchRunLogger = appLogger.child({ persona: personaLabel });
    appLogger.phase(`Persona ${runIndex + 1}/${configuredRuns.length}: ${personaLabel}`);
    try {
      const run = await exploreAndVerify(configuredRun.args, evidenceLog, configuredRun.id, configuredRun.name, signal);
      runs.push(run);
      batchRunLogger.phase(`Summary: ${run.replayConfirmedIds.length} of ${run.discovery?.flows.length ?? 0} discovered flow(s) replay-confirmed`, {
        runId: configuredRun.id,
        flowsFound: run.discovery?.flows.length ?? 0,
        replayConfirmed: run.replayConfirmedIds.length,
        findings: run.findings.length,
      });
      if (runOutcome(run).stopReason !== "completed") {
        const reason = runOutcome(run).stopReason === "budget_exhausted"
          ? "the action budget was exhausted"
          : runOutcome(run).stopReason === "no_progress"
            ? "exploration stopped after repeated no-progress attempts"
            : "exploration ended before the next flow was completed";
        batchRunLogger.warn(`Coverage incomplete: ${reason}`);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      batchRunLogger.error(`Persona failed: ${message}`);
      runs.push({
        runId: configuredRun.id,
        runName: configuredRun.name,
        args: configuredRun.args,
        evidencePath,
        allEntries: [],
        confirmedFlows: [],
        replayConfirmedIds: [],
        findings: [],
        responseVariantAudits: [],
        safety: emptySafety(),
        runtimeErrors: [],
        replayFailures: {},
        error: redactor.text(message),
      });
    }
  }

  const evidence = readEvidenceLog(evidencePath);
  if (evidence.issues.length > 0) {
    appLogger.warn(`Evidence warning: skipped ${evidence.issues.length} malformed record${evidence.issues.length === 1 ? "" : "s"}`);
    appLogger.debug("evidence.records_skipped", "Malformed evidence records were skipped", { issues: evidence.issues });
  }
  const allEntries = evidence.entries;
  const confirmedFlows = runs.flatMap((run) => run.confirmedFlows.map((flow) => ({
    ...flow,
    name: `${run.runName}: ${flow.name}`,
  })));
  return { executionId, args, evidencePath, runs, allEntries, confirmedFlows, evidenceIssues: evidence.issues, redactor };
}

function manifestFor(batch: ExplorationBatch): DiscoveryManifest {
  let nextFlowId = 1;
  const flows: DiscoveryManifestFlow[] = [];
  const runs: DiscoveryManifestRun[] = batch.runs.map((run) => {
    const flowIds: number[] = [];
    for (const [runFlowIndex, flow] of (run.discovery?.flows ?? []).entries()) {
      const id = nextFlowId;
      nextFlowId += 1;
      flowIds.push(id);
      const confirmed = run.confirmedFlows.find(
        (candidate) => candidate.origin === "discovered" && candidate.sourceFlowIndex === runFlowIndex,
      );
      flows.push({
        id,
        runId: run.runId,
        runFlowIndex,
        name: flow.finalText || "Flow " + (runFlowIndex + 1),
        title: flow.title,
        verified: flow.verified,
        replayConfirmed: run.replayConfirmedIds.includes(runFlowIndex + 1),
        startIndex: flow.startIndex,
        endIndex: flow.endIndex,
        startUrl: flow.startUrl,
        responseFixtures: confirmed?.responseFixtures,
        origin: "discovered",
        finding: run.findings.find((finding) => finding.flowIndex === runFlowIndex),
      });
    }
    for (const derived of run.confirmedFlows.filter((flow) => flow.origin === "derived")) {
      const source = flows.find(
        (flow) => flow.runId === run.runId && flow.runFlowIndex === derived.sourceFlowIndex,
      );
      if (!source) continue;
      const id = nextFlowId;
      nextFlowId += 1;
      flowIds.push(id);
      flows.push({
        id,
        runId: run.runId,
        runFlowIndex: derived.sourceFlowIndex,
        name: derived.name,
        title: derived.title,
        verified: true,
        replayConfirmed: true,
        startIndex: source.startIndex,
        endIndex: source.endIndex,
        startUrl: derived.startUrl ?? source.startUrl,
        responseFixtures: derived.responseFixtures,
        origin: "derived",
        sourceFlowId: source.id,
        scenarioId: derived.scenarioId,
        responseVariant: derived.responseVariant,
      });
    }
    const outcome = runOutcome(run);
    return {
      id: run.runId,
      name: run.runName,
      persona: run.args.personaName,
      personaIntent: outcome.personaIntent,
      maxSteps: run.args.maxSteps,
      scope: run.args.scope,
      expectations: run.args.expectations,
      exhausted: outcome.exhausted,
      stopReason: outcome.stopReason,
      flowIds,
      error: run.error,
    };
  });

  return {
    version: 2,
    executionId: batch.executionId,
    url: batch.args.url,
    createdAt: new Date().toISOString(),
    exhausted: batch.runs.some((run) => Boolean(run.error) || Boolean(run.discovery?.exhausted)),
    setup: {
      requiresLogin: Boolean(batch.args.email || batch.args.password),
      storageStatePath: batch.args.storageStatePath,
    },
    intent: {
      scope: batch.args.scope,
      expectations: batch.args.expectations,
    },
    runs,
    flows,
  };
}

export function writeDiscoveryArtifacts(batch: ExplorationBatch): string {
  const manifestPath = join(batch.args.output, "discovery.json");
  const manifest = batch.redactor.redact(manifestFor(batch), { preservePathFields: true }) as DiscoveryManifest;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}
