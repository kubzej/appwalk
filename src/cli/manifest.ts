import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FlowEntries } from "../codegen/spec.js";
import { readEvidenceLog } from "../evidence/log.js";
import type { ResponseFixture, ResponseVariant } from "../response/variants.js";
import type { PersonaIntent } from "../agent/personas.js";
import type { ReportStopReason } from "../report/contract.js";
import type { CliArgs } from "./args.js";
import { createExecutionDirectory } from "./execution.js";
import { logCodegenCompleted, logCodegenPlan } from "./codegen-log.js";
import { appLogger } from "./logger-state.js";
import { writeGeneratedSuite } from "./generated-suite.js";

export interface DiscoveryManifestFlow {
  id: number;
  runId?: string;
  runFlowIndex?: number;
  name: string;
  title?: string;
  verified: boolean;
  replayConfirmed: boolean;
  startIndex: number;
  endIndex: number;
  startUrl: string;
  startStorageState?: string;
  responseFixtures?: ResponseFixture[];
  origin?: "discovered" | "derived";
  sourceFlowId?: number;
  scenarioId?: string;
  responseVariant?: ResponseVariant;
  finding?: {
    status: "confirmed" | "inconclusive";
    summary: string;
    failure?: string;
  };
}

export interface DiscoveryManifest {
  version: 1 | 2;
  executionId?: string;
  url: string;
  createdAt: string;
  exhausted: boolean;
  setup: {
    requiresLogin: boolean;
    storageStatePath?: string;
  };
  intent: {
    scope?: string;
    expectations: string[];
  };
  runs?: DiscoveryManifestRun[];
  flows: DiscoveryManifestFlow[];
}

export interface DiscoveryManifestRun {
  id: string;
  name: string;
  persona?: string;
  personaIntent?: PersonaIntent;
  maxSteps: number;
  scope?: string;
  expectations: string[];
  exhausted: boolean;
  stopReason?: ReportStopReason;
  flowIds: number[];
  error?: string;
}

function resolveDiscoveryInput(input: string): { manifestPath: string; inputDir: string } {
  const manifestPath = input.endsWith(".json") ? input : join(input, "discovery.json");
  if (!existsSync(manifestPath)) {
    throw new Error("Discovery manifest not found: " + manifestPath + ". Run 'explore <url>' first.");
  }
  return { manifestPath, inputDir: dirname(manifestPath) };
}

function loadManifest(path: string): DiscoveryManifest {
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as DiscoveryManifest;
  if ((manifest.version !== 1 && manifest.version !== 2) || !Array.isArray(manifest.flows)) {
    throw new Error("Unsupported discovery manifest: " + path);
  }
  return manifest;
}

function selectManifestFlows(manifest: DiscoveryManifest, selection: number[] | undefined): DiscoveryManifestFlow[] {
  const selectedIds = selection ?? manifest.flows.filter((flow) => flow.replayConfirmed).map((flow) => flow.id);
  const knownIds = new Set(manifest.flows.map((flow) => flow.id));
  const unknownIds = selectedIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error("Unknown flow id(s): " + unknownIds.join(", ") + ". Available: 1-" + manifest.flows.length + ".");
  }

  const selected = selectedIds.map((id) => manifest.flows.find((flow) => flow.id === id)!);
  const unconfirmed = selected.filter((flow) => !flow.replayConfirmed).map((flow) => flow.id);
  if (unconfirmed.length > 0) {
    throw new Error("Flow(s) " + unconfirmed.join(", ") + " were not confirmed by replay and cannot be generated.");
  }
  if (selected.length === 0) throw new Error("No replay-confirmed flows available to generate.");
  return selected;
}

export function generateFromManifest(args: CliArgs): void {
  const { manifestPath, inputDir } = resolveDiscoveryInput(args.url);
  const manifest = loadManifest(manifestPath);
  const evidence = readEvidenceLog(join(inputDir, "evidence.jsonl"));
  if (evidence.issues.length > 0) {
    appLogger.warn(`Evidence warning: skipped ${evidence.issues.length} malformed record${evidence.issues.length === 1 ? "" : "s"}`);
  }
  const entries = evidence.entries;
  const selected = selectManifestFlows(manifest, args.flowSelection);
  const storageStatePath = args.storageStatePath ?? manifest.setup.storageStatePath;
  const useCapturedState = manifest.setup.requiresLogin && !storageStatePath && !(args.email && args.password);
  if (useCapturedState) {
    throw new Error("This discovery used login. Pass -e/-p or --storage-state when generating from it; captured session state is not stored in discovery artifacts.");
  }

  const runNames = new Map((manifest.runs ?? []).map((run) => [run.id, run.name]));
  const flows: FlowEntries[] = selected.map((flow) => {
    const flowEntries = entries.filter((entry) => flow.origin === "derived"
      ? entry.runId === flow.runId && entry.scenarioId === flow.scenarioId
      : flow.runId
        ? entry.runId === flow.runId && entry.scenarioId === undefined && entry.flowIndex === (flow.runFlowIndex ?? 0)
        : entry.flowIndex === flow.id - 1);
    const useFlowState = manifest.version === 2 || useCapturedState;
    return {
      name: flow.runId && runNames.has(flow.runId) ? `${runNames.get(flow.runId)}: ${flow.name}` : flow.name,
      title: flow.title,
      entries: flowEntries,
      startUrl: useFlowState ? flow.startUrl : flow.id === 1 ? undefined : flow.startUrl,
      startStorageState: useFlowState ? flow.startStorageState : flow.id === 1 ? undefined : flow.startStorageState,
      responseFixtures: flow.responseFixtures,
      origin: flow.origin,
      fixtureBaseId: flow.sourceFlowId !== undefined ? `flow-${flow.sourceFlowId}` : `flow-${flow.id}`,
      baseResponseFixtures: flow.origin === "derived"
        ? manifest.flows.find((candidate) => candidate.id === flow.sourceFlowId)?.responseFixtures
        : undefined,
      responseVariant: flow.responseVariant,
    };
  });
  const emptyFlows = flows.filter((flow) => flow.entries.length === 0).map((flow) => flow.name);
  if (emptyFlows.length > 0) {
    throw new Error("Discovery evidence is missing for selected flow(s): " + emptyFlows.join(", "));
  }
  logCodegenPlan(appLogger, "generate", flows);
  const execution = createExecutionDirectory(args.output);
  const generatedSuite = writeGeneratedSuite(execution.path, flows, {
    url: manifest.url,
    username: args.email,
    password: args.password,
    storageStatePath,
  });
  logCodegenCompleted(appLogger, "generate", flows);
  appLogger.result("done:\n  execution:                           " + execution.path + "\n  test suite (" + flows.length + " test(s)): " + generatedSuite.specPath +
    (generatedSuite.fixtureHelperPath ? "\n  fixtures:                             " + generatedSuite.fixtureHelperPath : "") +
    (generatedSuite.credentialsPath ? "\n  local credentials:                    " + generatedSuite.credentialsPath : ""));
}
