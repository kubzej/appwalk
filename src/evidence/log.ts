import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConsoleEntry, NetworkEntry, RuntimeErrorEntry, WebSocketFrameEntry } from "./recorder.js";
import type { StepResult } from "../types.js";
import { defaultRedactor, type Redactor } from "../security/redaction.js";

export interface EvidenceEntry {
  index: number;
  flowIndex: number;
  runId?: string;
  /** Identifies replay evidence for a derived response scenario. Base discovery entries omit it. */
  scenarioId?: string;
  origin?: "discovered" | "derived";
  timestamp: string;
  toolCall?: { name: string; input: Record<string, unknown> };
  result?: StepResult;
  error?: string;
  finalText?: string;
  network: NetworkEntry[];
  console: ConsoleEntry[];
  runtimeErrors?: RuntimeErrorEntry[];
  /** Number of network requests intentionally blocked by safety during this action. */
  safetyBlocked?: number;
  /** WebSocket frames sent/received during this step — a real-time target (live inventory, chat,
   * price tickers) pushes state over a channel HTTP-only capture can't see at all. */
  webSocketFrames?: WebSocketFrameEntry[];
}

export interface EvidenceReadIssue {
  line: number;
  reason: string;
}

export interface EvidenceReadResult {
  entries: EvidenceEntry[];
  issues: EvidenceReadIssue[];
}

export class EvidenceLog {
  constructor(
    private readonly path: string,
    private readonly redactor: Redactor = defaultRedactor,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  append(entry: EvidenceEntry): void {
    const safeEntry = this.redactor.redact(entry, { preserveToolInputs: true });
    appendFileSync(this.path, JSON.stringify(safeEntry) + "\n");
  }
}

export function readEvidenceLog(path: string): EvidenceReadResult {
  const entries: EvidenceEntry[] = [];
  const issues: EvidenceReadIssue[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as EvidenceEntry);
    } catch (error) {
      issues.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { entries, issues };
}
