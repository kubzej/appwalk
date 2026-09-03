import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Persona } from "../agent/personas.js";
import type { TabRegistryHandle } from "../agent/tools.js";
import type { BrowserLifecycle } from "../browser/actions.js";
import type { FlowResult } from "../agent/loop.js";
import type { CliArgs } from "./args.js";
import { EvidenceRecorder } from "../evidence/recorder.js";
import type { ExpectationObservation } from "../types.js";
import type { GuardOptions } from "../safety/guard.js";
import { installDestructiveActionGuard } from "../safety/guard.js";
import type { ToolCall } from "../providers/provider.js";
import { replay, type ReplayResult } from "../verify/replay.js";
import type { Logger } from "../logging/logger.js";
import { Redactor } from "../security/redaction.js";
import {
  attachCrashDetection,
  attachPopupDetection,
  attachWebSocketCapture,
  createTraceSession,
  type TraceSession,
} from "./browser-observability.js";
import { closeTrackedContexts, createBrowserLifecycle } from "./browser-lifecycle.js";

export interface ReplayExecutionInput {
  replayBrowser: Browser;
  flow: FlowResult;
  flowIndex: number;
  runId: string;
  actions: ToolCall[];
  expectedExpectations: ExpectationObservation[];
  args: CliArgs;
  persona?: Persona;
  redactor: Redactor;
  flowLogger: Logger;
  guardOptions: GuardOptions;
  getSafetyBlockCount: () => number;
  navigateOrLogin: (page: Page, args: CliArgs, hasPreloadedState?: boolean, startUrl?: string, logger?: Logger) => Promise<void>;
  setActiveRecorder: (recorder: EvidenceRecorder) => void;
  trackedContexts: Set<BrowserContext>;
}

export interface ReplayExecutionResult {
  replayBrowser: Browser;
  replayResult: ReplayResult;
  replayRecorder: EvidenceRecorder;
}

/** Owns the browser mechanics of one clean replay. Reporting and response variants consume its
 * result, but do not need to know how contexts, pages, listeners, or trace cleanup are managed. */
export async function executeReplay(input: ReplayExecutionInput): Promise<ReplayExecutionResult> {
  const {
    replayBrowser: initialBrowser,
    flow,
    flowIndex,
    runId,
    actions,
    args,
    persona,
    redactor,
    flowLogger,
    guardOptions,
    getSafetyBlockCount,
    navigateOrLogin,
    setActiveRecorder,
    trackedContexts,
  } = input;
  const flowStorageState = flowIndex > 0 && flow.startStorageState
    ? JSON.parse(flow.startStorageState)
    : args.storageStatePath;
  let replayRecorder: EvidenceRecorder | undefined;
  let runtimeServicesReady = false;
  let traceSession: TraceSession | undefined;
  const replayTabRegistryHandle: TabRegistryHandle = { tabs: new Map() };
  const browserLifecycle: BrowserLifecycle = createBrowserLifecycle({
    browserEngine: args.browserEngine,
    storageStatePath: args.storageStatePath,
    persona,
    prepareContext: async (context) => {
      if (!runtimeServicesReady) return;
      await installDestructiveActionGuard(context, guardOptions);
    },
    preparePage: async (page) => {
      if (!runtimeServicesReady || !replayRecorder) return;
      replayRecorder.reattach(page);
      attachPopupDetection(page, flowLogger, replayTabRegistryHandle);
      attachCrashDetection(page, replayRecorder);
      attachWebSocketCapture(page, replayRecorder);
      await traceSession?.switchTo(page);
    },
  });
  const replayContext = await browserLifecycle.createContext(initialBrowser, flowStorageState);
  trackedContexts.add(replayContext);
  const replayPage = await browserLifecycle.createPage(replayContext);

  let replayResult: ReplayResult | undefined;
  let replayBrowser = initialBrowser;
  try {
    await navigateOrLogin(
      replayPage,
      args,
      flowIndex > 0 && Boolean(flow.startStorageState),
      flowIndex > 0 && flow.startUrl ? flow.startUrl : args.url,
      flowLogger,
    );
    replayRecorder = new EvidenceRecorder(replayContext, flowLogger, { redactor });
    setActiveRecorder(replayRecorder);
    if (args.trace) {
      traceSession = await createTraceSession(replayContext, joinTracePath(args, runId, flowIndex), flowLogger);
    }
    runtimeServicesReady = true;
    await browserLifecycle.prepareContext(replayContext);
    await browserLifecycle.preparePage(replayPage);
    replayResult = await replay(
      replayPage,
      actions,
      persona?.verificationMode ?? "completion",
      replayRecorder,
      input.expectedExpectations,
      undefined,
      flowLogger,
      getSafetyBlockCount,
      undefined,
      async (newPage) => {
        trackedContexts.add(newPage.context());
        await browserLifecycle.prepareContext(newPage.context());
        await browserLifecycle.preparePage(newPage);
      },
      replayTabRegistryHandle,
      guardOptions,
      traceSession,
      browserLifecycle,
    );
    const activeBrowser = replayResult.finalPage.context().browser();
    if (activeBrowser && activeBrowser !== replayBrowser) replayBrowser = activeBrowser;
    return { replayBrowser, replayResult, replayRecorder };
  } finally {
    await traceSession?.finish();
    if (replayResult) {
      const finalContext = replayResult.finalPage.context();
      await replayResult.finalPage.close();
      trackedContexts.add(finalContext);
    }
    await closeTrackedContexts(trackedContexts, flowLogger, `flow ${flowIndex + 1}`);
  }
}

function joinTracePath(args: CliArgs, runId: string, flowIndex: number): string {
  return join(args.output, "traces", `${runId}-flow-${flowIndex + 1}.zip`);
}
