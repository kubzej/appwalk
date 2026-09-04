#!/usr/bin/env node
import 'dotenv/config';
import { applyConfig, parseArgs } from './args.js';
import { createExecutionDirectory } from './execution.js';
import { generateFromManifest } from './manifest.js';
import { exploreCoverage, redactorForArgs, writeDiscoveryArtifacts } from './orchestrate.js';
import { writeExecutionReport } from './report.js';
import { logCodegenCompleted, logCodegenPlan } from './codegen-log.js';
import { appLogger, setAppLogger } from './logger-state.js';
import { Logger, chip, logError, streamSupportsColor } from '../logging/logger.js';
import { writeGeneratedSuite } from './generated-suite.js';
import {
  renderArtifactPanel,
  renderExecutionSummary,
  renderRows,
  type ArtifactRow,
} from '../report/terminal-summary.js';
import type { CliArgs } from './args.js';
import { EXIT_CODES } from '../exit-codes.js';

interface ResolvedRunLog {
  name: string;
  persona: string;
  maxSteps: number;
  scope?: string;
  expectations: string[];
  /** True only when this run's config explicitly overrides the global scope/expect — so the
   * Configuration panel can show the global value once instead of repeating it per run. */
  scopeOverridden: boolean;
  expectationsOverridden: boolean;
}

function resolvedRuns(args: CliArgs): ResolvedRunLog[] {
  if (args.coverageRuns?.length) {
    return args.coverageRuns.map((run) => ({
      name: run.name,
      persona: run.persona ?? args.personaName ?? 'default',
      maxSteps: run.maxSteps ?? args.maxSteps,
      scope: run.scope ?? args.scope,
      expectations: run.expect !== undefined ? run.expect : args.expectations,
      scopeOverridden: run.scope !== undefined,
      expectationsOverridden: run.expect !== undefined,
    }));
  }
  const persona = args.personaName ?? 'default';
  return [
    {
      name: `${persona} baseline`,
      persona,
      maxSteps: args.maxSteps,
      scope: args.scope,
      expectations: args.expectations,
      scopeOverridden: false,
      expectationsOverridden: false,
    },
  ];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function logResolvedConfiguration(args: CliArgs): void {
  const runs = resolvedRuns(args);
  const colorEnabled = streamSupportsColor(process.stderr);
  const auth =
    args.email && args.password
      ? `credentials (${oneLine(args.email)})`
      : args.storageStatePath
        ? 'storage state'
        : 'anonymous';
  const safety = args.allowDestructive
    ? 'destructive requests allowed'
    : `blocked methods: ${args.blockMethods.join(', ')}`;

  const rows: ArtifactRow[] = [
    { label: 'source', value: args.configPath ?? 'CLI arguments' },
    { label: 'target', value: args.url },
    { label: 'provider', value: String(args.provider) },
    { label: 'model', value: String(args.model) },
    { label: 'browser', value: args.browserEngine },
    { label: 'output root', value: args.output },
    { label: 'authentication', value: auth },
    { label: 'screenshots', value: args.screenshots ? 'enabled' : 'disabled' },
    {
      label: 'response variants',
      value: (args.responseVariantMax ?? 0) > 0 ? `up to ${args.responseVariantMax}` : 'disabled',
    },
    {
      label: 'response fixture limit',
      value: args.responseFixtureMaxBytes !== undefined ? `${args.responseFixtureMaxBytes} bytes` : 'default',
    },
    { label: 'safety', value: `${safety}${args.safetyConfigPath ? `; URL rules: ${args.safetyConfigPath}` : ''}` },
    { label: 'runs', value: String(runs.length) },
    ...(args.scope ? [{ label: 'scope', value: oneLine(args.scope) }] : []),
    ...(args.scope && args.expectations.length > 0
      ? [{ label: 'expectations', value: String(args.expectations.length) }]
      : []),
  ];
  const lines = renderRows(rows, colorEnabled);
  if (args.scope && args.expectations.length > 0) {
    args.expectations.forEach((expectation, index) => lines.push(`    ${index + 1}. ${oneLine(expectation)}`));
  }
  // Each run only lists what actually distinguishes it (persona, max steps) plus scope/expect
  // when THAT run overrides the global value — repeating an identical global scope three times
  // over is noise, not information.
  runs.forEach((run, index) => {
    lines.push('');
    const runRows: ArtifactRow[] = [
      { label: `run ${index + 1}`, value: run.name },
      { label: 'persona', value: run.persona },
      { label: 'max steps', value: String(run.maxSteps) },
      ...(run.scopeOverridden ? [{ label: 'scope', value: run.scope ? oneLine(run.scope) : 'none' }] : []),
      ...(run.expectationsOverridden ? [{ label: 'expectations', value: String(run.expectations.length) }] : []),
    ];
    lines.push(...renderRows(runRows, colorEnabled));
    if (run.expectationsOverridden) {
      run.expectations.forEach((expectation, expectationIndex) => {
        lines.push(`    ${expectationIndex + 1}. ${oneLine(expectation)}`);
      });
    }
  });

  process.stderr.write(`\n${chip('Configuration', colorEnabled)}\n${lines.join('\n')}\n`);
}

function resolvedConfigurationDetails(args: CliArgs): Record<string, unknown> {
  return {
    command: args.command,
    url: args.url,
    provider: args.provider,
    model: args.model,
    browserEngine: args.browserEngine,
    output: args.output,
    configPath: args.configPath,
    screenshots: args.screenshots,
    responseVariants: args.responseVariantMax ?? 0,
    responseFixtureMaxBytes: args.responseFixtureMaxBytes,
    auth: {
      method: args.email && args.password ? 'credentials' : args.storageStatePath ? 'storage_state' : 'anonymous',
      email: args.email,
      passwordProvided: Boolean(args.password),
    },
    safety: { allowDestructive: args.allowDestructive, blockMethods: args.blockMethods },
    runs: resolvedRuns(args),
  };
}

async function withProcessCancellation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = () => {
    if (!controller.signal.aborted) {
      appLogger.warn('Cancellation requested; stopping the active exploration.');
      controller.abort(new Error('Execution cancelled by signal.'));
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await work(controller.signal);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  setAppLogger(new Logger(parsedArgs.logLevel, undefined, {}, { redactor: redactorForArgs(parsedArgs) }));
  if (parsedArgs.command === 'generate') {
    generateFromManifest(parsedArgs);
    return;
  }
  const args = applyConfig(parsedArgs);
  setAppLogger(new Logger(args.logLevel, undefined, {}, { redactor: redactorForArgs(args) }));
  appLogger.phase(`Starting ${args.command} execution for ${args.url}`);
  logResolvedConfiguration(args);
  appLogger.debug('execution.config_resolved', 'Execution configuration resolved', resolvedConfigurationDetails(args));
  const execution = createExecutionDirectory(args.output);
  const executionArgs = { ...args, output: execution.path };
  const executionCommand: 'explore' | 'run' = args.command === 'explore' ? 'explore' : 'run';

  const batch = await withProcessCancellation((signal) => exploreCoverage(executionArgs, execution.id, signal));
  writeDiscoveryArtifacts(batch);

  if (executionArgs.command === 'explore') {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    process.stdout.write(renderExecutionSummary(report, execution.path));
    return;
  }
  if (batch.confirmedFlows.length === 0) {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    appLogger.warn('No confirmed regression flow to generate; see the execution report.');
    process.stdout.write(renderExecutionSummary(report, execution.path));
    return;
  }

  appLogger.phase('Generating test suite');
  logCodegenPlan(appLogger, 'run', batch.confirmedFlows);
  const generatedSuite = writeGeneratedSuite(executionArgs.output, batch.confirmedFlows, {
    url: executionArgs.url,
    username: executionArgs.email,
    password: executionArgs.password,
    storageStatePath: executionArgs.storageStatePath,
  });
  logCodegenCompleted(appLogger, 'run', batch.confirmedFlows);

  const generatedRows: ArtifactRow[] = [
    { label: `test suite (${batch.confirmedFlows.length})`, value: generatedSuite.specPath },
    ...(generatedSuite.fixtureHelperPath ? [{ label: 'fixtures', value: generatedSuite.fixtureHelperPath }] : []),
    ...(generatedSuite.credentialsPath ? [{ label: 'local credentials', value: generatedSuite.credentialsPath }] : []),
    ...(generatedSuite.storageStatePath
      ? [{ label: 'local storage state', value: generatedSuite.storageStatePath }]
      : []),
  ];
  process.stdout.write(renderArtifactPanel('Generated', generatedRows));

  const report = writeExecutionReport(batch, executionCommand, execution, batch.confirmedFlows.length, {
    fixtures: generatedSuite.fixtureHelperPath ? 'fixtures.ts' : undefined,
  });
  process.exitCode = report.exitCode;
  process.stdout.write(renderExecutionSummary(report, execution.path));
}

main().catch((err) => {
  appLogger.error(logError(err));
  appLogger.debug('execution.failed', 'Execution failed unexpectedly', {
    error: logError(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(EXIT_CODES.executionError);
});
