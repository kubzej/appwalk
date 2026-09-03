import type { FlowEntries } from "../codegen/spec.js";
import type { ResponseVariant } from "../response/variants.js";
import type { RuntimeErrorEntry } from "../evidence/recorder.js";

export interface FlowFinding {
  flowIndex: number;
  status: "confirmed" | "inconclusive";
  summary: string;
  failure?: string;
}

export interface ConfirmedFlow extends FlowEntries {
  origin: "discovered" | "derived";
  sourceFlowIndex?: number;
  scenarioId?: string;
  responseVariant?: ResponseVariant;
}

export interface SafetyEvent {
  phase: "exploration" | "replay";
  method: string;
  url: string;
}

export interface RuntimeErrorPhaseEntry {
  error: RuntimeErrorEntry;
  phase: "exploration" | "replay";
  flowIndex?: number;
}
