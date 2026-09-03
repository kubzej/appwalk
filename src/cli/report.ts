import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { formatTestTitle } from "../codegen/spec.js";
import {
  buildExecutionReport,
  type ExecutionReport,
  type ReportFlow,
  type ReportIssue,
  type ReportStep,
} from "../report/contract.js";
import { renderHtmlReport } from "../report/html-report.js";
import type { EvidenceEntry } from "../evidence/log.js";
import { runOutcome, type ExplorationBatch, type ExplorationRun } from "./orchestrate.js";

function reportActionLabel(name: string): string {
  const labels: Record<string, string> = {
    navigate: "Navigate",
    click: "Click",
    doubleClick: "Double click",
    fill: "Fill",
    select: "Select",
    pressKey: "Press key",
    check: "Check",
    uncheck: "Uncheck",
    hover: "Hover",
    dragAndDrop: "Drag and drop",
    goBack: "Go back",
    goForward: "Go forward",
    reload: "Reload",
    hardReload: "Hard reload",
    openInNewTab: "Open new tab",
    reopenBrowser: "Reopen browser",
    scroll: "Scroll",
    setViewportSize: "Set viewport",
    waitFor: "Wait for element",
    uploadFile: "Upload file",
    download: "Download",
    handleDialog: "Handle dialog",
    verifyExpectation: "Verify expectation",
    clearCookie: "Clear cookie",
    simulateFailure: "Simulate failure",
    simulateLatency: "Simulate latency",
    burst: "Repeat action",
  };
  return labels[name] ?? name;
}

function reportStepValue(entry: EvidenceEntry, redactor: ExplorationBatch["redactor"]): string | undefined {
  const input = redactor.redact(entry.toolCall?.input ?? {}) as Record<string, unknown>;
  const value = input.value ?? input.key ?? input.mode;
  if (value === undefined) return undefined;
  return String(value);
}

function reportSteps(entries: EvidenceEntry[], errorLabel: string, redactor: ExplorationBatch["redactor"]): ReportStep[] {
  return entries
    .filter((entry) => entry.toolCall && entry.toolCall.name !== "flowComplete")
    .map((entry, index) => {
      const input = entry.toolCall!.input;
      const target = typeof input.locator === "string"
        ? input.locator
        : typeof input.source === "string" && typeof input.target === "string"
          ? `${input.source} -> ${input.target}`
        : typeof input.url === "string"
          ? input.url
          : undefined;
      return {
        number: index + 1,
        action: reportActionLabel(entry.toolCall!.name),
        target,
        value: reportStepValue(entry, redactor),
        error: entry.error,
        errorLabel: entry.error ? errorLabel : undefined,
        safetyBlocked: entry.safetyBlocked,
      };
    });
}

function flowSimilarityKey(flow: ReportFlow): string {
  return flow.title
    .toLocaleLowerCase()
    .replace(/\b(?:flow|journey|scenario|order|request|session)\b/g, "")
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reportFlowsForRun(run: ExplorationRun, redactor: ExplorationBatch["redactor"]): ReportFlow[] {
  const discovered = (run.discovery?.flows ?? []).map((flow, index): ReportFlow => {
    const entries = run.allEntries.filter((entry) => entry.flowIndex === index && entry.scenarioId === undefined);
    const finding = run.findings.find((candidate) => candidate.flowIndex === index);
    const runtimeIssues = run.runtimeErrors.filter((error) => error.phase === "replay" && error.flowIndex === index + 1 && !error.lifecycle);
    return {
      id: `${run.runId}-flow-${index + 1}`,
      title: flow.title ?? formatTestTitle(flow.finalText || `Flow ${index + 1}`),
      summary: flow.finalText || "No flow summary provided.",
      origin: "discovered",
      discoveryVerified: flow.verified,
      replayConfirmed: run.replayConfirmedIds.includes(index + 1),
      runtimeIssues,
      steps: reportSteps(entries, "Exploration action failed", redactor),
      replayFailure: run.replayFailures[index],
      finding,
    };
  });
  const derived = run.confirmedFlows
    .filter((flow) => flow.origin === "derived")
    .map((flow, index): ReportFlow => ({
      id: flow.scenarioId ?? `${run.runId}-derived-${index + 1}`,
      ...(flow.sourceFlowIndex !== undefined
        ? { parentFlowId: `${run.runId}-flow-${flow.sourceFlowIndex + 1}` }
        : {}),
      title: flow.title ?? formatTestTitle(flow.name),
      summary: flow.name,
      origin: "derived",
      discoveryVerified: true,
      replayConfirmed: true,
      runtimeIssues: [],
      steps: reportSteps(flow.entries, "Replay action failed", redactor),
    }));
  const firstBySimilarity = new Map<string, string>();
  return [...discovered, ...derived].map((flow) => {
    if (flow.origin !== "discovered") return flow;
    const key = flowSimilarityKey(flow);
    if (!key) return flow;
    const firstId = firstBySimilarity.get(key);
    if (!firstId) {
      firstBySimilarity.set(key, flow.id);
      return flow;
    }
    return { ...flow, similarTo: firstId };
  });
}

export function writeExecutionReport(
  batch: ExplorationBatch,
  command: "explore" | "run",
  execution: { id: string; startedAt: string },
  generatedTests: number,
  generatedArtifacts?: { fixtures?: string },
): ExecutionReport {
  const artifacts = {
    reportJson: "report.json",
    reportHtml: "report.html",
    discovery: "discovery.json",
    evidence: "evidence.jsonl",
    ...(generatedTests > 0 ? { testSuite: "discovered.spec.ts" } : {}),
    ...(generatedArtifacts?.fixtures ? { fixtures: generatedArtifacts.fixtures } : {}),
  };
  const report = buildExecutionReport({
    executionId: execution.id,
    command,
    url: batch.args.url,
    startedAt: execution.startedAt,
    completedAt: new Date().toISOString(),
    scope: batch.args.scope,
    expectations: batch.args.expectations,
    generatedTests,
    artifacts,
    issues: batch.evidenceIssues.map((issue): ReportIssue => ({
      source: "evidence",
      severity: "warning",
      line: issue.line,
      message: issue.reason,
    })),
    runs: batch.runs.map((run) => {
      const outcome = runOutcome(run);
      return {
        id: run.runId,
        name: run.runName,
        persona: run.args.personaName,
        personaIntent: outcome.personaIntent,
        maxSteps: run.args.maxSteps,
        scope: run.args.scope,
        expectations: run.args.expectations,
        flowsFound: run.discovery?.flows.length ?? 0,
        replayConfirmed: run.replayConfirmedIds.length,
        generatedTests: command === "run" ? run.confirmedFlows.length : 0,
        exhausted: outcome.exhausted,
        stopReason: outcome.stopReason,
        safety: run.safety,
        runtimeErrors: run.runtimeErrors,
        flows: reportFlowsForRun(run, batch.redactor),
        findings: run.findings,
        responseVariants: run.responseVariantAudits,
        error: run.error,
      };
    }),
  });
  const safeReport = batch.redactor.redact(report) as ExecutionReport;
  writeFileSync(join(batch.args.output, artifacts.reportJson), JSON.stringify(safeReport, null, 2) + "\n");
  writeFileSync(join(batch.args.output, artifacts.reportHtml), renderHtmlReport(safeReport));
  return safeReport;
}
