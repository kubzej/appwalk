import { join } from 'node:path';
import { chip, dim, paint, streamSupportsColor, type LogTone } from '../logging/logger.js';
import { EXIT_CODES } from '../exit-codes.js';
import type { ExecutionReport } from './contract.js';

export interface ArtifactRow {
  label: string;
  value: string;
}

/** A dim label + plain value, aligned to the widest label in the group. No border, no bar —
 * just indentation, matching how every other line in the app expresses structure. */
export function renderRows(rows: ArtifactRow[], colorEnabled: boolean, indent = '  '): string[] {
  const width = Math.max(...rows.map((row) => row.label.length));
  return rows.map((row) => `${indent}${dim(row.label.padEnd(width), colorEnabled)}  ${row.value}`);
}

/** Renders a titled block of label/path rows with dynamically computed alignment — never
 * hand-counted spaces, so it never drifts when a label or path changes length. */
export function renderArtifactPanel(
  title: string,
  rows: ArtifactRow[],
  out: NodeJS.WritableStream = process.stdout,
): string {
  const colorEnabled = streamSupportsColor(out);
  return `\n${chip(title, colorEnabled)}\n${renderRows(rows, colorEnabled).join('\n')}\n`;
}

function outcomeFor(report: ExecutionReport): { tone: LogTone; message: string } {
  switch (report.exitCode) {
    case EXIT_CODES.success:
      return { tone: 'success', message: 'passed — every confirmed flow verified cleanly' };
    case EXIT_CODES.findings:
      return {
        tone: 'warn',
        message: `${report.summary.confirmedFindings} finding${report.summary.confirmedFindings === 1 ? '' : 's'} confirmed — see report.html`,
      };
    case EXIT_CODES.executionError:
      return { tone: 'error', message: 'execution failed — see report.json for details' };
    default:
      return { tone: 'warn', message: 'inconclusive — coverage incomplete or nothing replay-confirmed' };
  }
}

/** Renders the same `ExecutionReport` that drives report.json/report.html as a terminal panel,
 * so the CLI summary can never drift from what's actually in the report. `baseDir` (the
 * execution's output directory) turns the report's relative artifact filenames — relative so
 * report.html can link to them — back into full paths for a human reading the terminal. */
export function renderExecutionSummary(
  report: ExecutionReport,
  baseDir: string,
  out: NodeJS.WritableStream = process.stdout,
): string {
  const colorEnabled = streamSupportsColor(out);
  const { summary } = report;
  const path = (name: string) => join(baseDir, name);
  const stats: ArtifactRow[] = [
    { label: 'runs', value: String(summary.runs) },
    { label: 'flows found', value: String(summary.flowsFound) },
    { label: 'replay-confirmed', value: String(summary.replayConfirmed) },
    ...(summary.generatedTests > 0 ? [{ label: 'tests generated', value: String(summary.generatedTests) }] : []),
    ...(summary.confirmedFindings + summary.inconclusiveFindings > 0
      ? [
          {
            label: 'findings',
            value: `${summary.confirmedFindings} confirmed, ${summary.inconclusiveFindings} inconclusive`,
          },
        ]
      : []),
    ...(summary.safetyBlockedRequests > 0
      ? [{ label: 'safety blocked', value: `${summary.safetyBlockedRequests} request(s)` }]
      : []),
    ...(summary.runtimeErrors > 0 ? [{ label: 'runtime errors', value: String(summary.runtimeErrors) }] : []),
  ];
  const artifacts: ArtifactRow[] = [
    { label: 'report json', value: path(report.artifacts.reportJson) },
    { label: 'report html', value: path(report.artifacts.reportHtml) },
    { label: 'discovery', value: path(report.artifacts.discovery) },
    { label: 'evidence', value: path(report.artifacts.evidence) },
    ...(report.artifacts.testSuite ? [{ label: 'test suite', value: path(report.artifacts.testSuite) }] : []),
    ...(report.artifacts.fixtures ? [{ label: 'fixtures', value: path(report.artifacts.fixtures) }] : []),
  ];
  const outcome = outcomeFor(report);
  return [
    `\n${chip('Summary', colorEnabled)}`,
    ...renderRows(stats, colorEnabled),
    '',
    ...renderRows(artifacts, colorEnabled),
    '',
    `  ${paint(outcome.message, outcome.tone, colorEnabled)}`,
    '',
  ].join('\n');
}
