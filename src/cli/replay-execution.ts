import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { Persona } from "../agent/personas.js";
import type { TabRegistryHandle } from "../agent/tools.js";
import { configurePageTimeouts } from "../browser/actions.js";
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
  startTracing,
  stopTracing,
} from "./browser-observability.js";
import { closeTrackedContexts, deviceContextOptions } from "./browser-lifecycle.js";

export interface ReplayExecutionInput {
  replayBrowser: Browser;
  flow: FlowResult;
  flowIndex: number;
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
  const replayContext = await initialBrowser.newContext({
    ...deviceContextOptions(persona),
    ...(flowStorageState ? { storageState: flowStorageState } : {}),
  });
  trackedContexts.add(replayContext);
  const replayPage = await replayContext.newPage();
  configurePageTimeouts(replayPage);
  const replayTabRegistryHandle: TabRegistryHandle = { tabs: new Map() };
  attachPopupDetection(replayPage, flowLogger, replayTabRegistryHandle);

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
    await installDestructiveActionGuard(replayContext, guardOptions);
    const replayRecorder = new EvidenceRecorder(replayContext, flowLogger, { redactor });
    setActiveRecorder(replayRecorder);
    attachCrashDetection(replayPage, replayRecorder);
    if (args.trace) await startTracing(replayContext, flowLogger);
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
        await installDestructiveActionGuard(newPage.context(), guardOptions);
        attachPopupDetection(newPage, flowLogger, replayTabRegistryHandle);
        attachCrashDetection(newPage, replayRecorder);
      },
      replayTabRegistryHandle,
      guardOptions,
    );
    const activeBrowser = replayResult.finalPage.context().browser();
    if (activeBrowser && activeBrowser !== replayBrowser) replayBrowser = activeBrowser;
    return { replayBrowser, replayResult, replayRecorder };
  } finally {
    if (args.trace) await stopTracing(replayContext, joinTracePath(args, flowIndex), flowLogger);
    if (replayResult) {
      const finalContext = replayResult.finalPage.context();
      await replayResult.finalPage.close();
      trackedContexts.add(finalContext);
    }
    await closeTrackedContexts(trackedContexts, flowLogger, `flow ${flowIndex + 1}`);
  }
}

function joinTracePath(args: CliArgs, flowIndex: number): string {
  return join(args.output, "traces", `flow-${flowIndex + 1}.zip`);
}
