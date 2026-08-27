import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConsoleEntry, NetworkEntry } from "./recorder.js";
import type { StepResult } from "../types.js";

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
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  append(entry: EvidenceEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
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
