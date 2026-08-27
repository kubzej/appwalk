#!/usr/bin/env node
import "dotenv/config";
import { applyConfig, parseArgs } from "./args.js";
import { createExecutionDirectory } from "./execution.js";
import { generateFromManifest } from "./manifest.js";
import { exploreCoverage, writeDiscoveryArtifacts } from "./orchestrate.js";
import { writeExecutionReport } from "./report.js";
import { logCodegenCompleted, logCodegenPlan } from "./codegen-log.js";
import { appLogger, setAppLogger } from "./logger-state.js";
import { Logger, logError } from "../logging/logger.js";
import { writeGeneratedSuite } from "./generated-suite.js";
import { join } from "node:path";
import type { CliArgs } from "./args.js";

interface ResolvedRunLog {
  name: string;
  persona: string;
  maxSteps: number;
  scope?: string;
  expectations: string[];
}

function resolvedRuns(args: CliArgs): ResolvedRunLog[] {
  if (args.coverageRuns?.length) {
    return args.coverageRuns.map((run) => ({
      name: run.name,
      persona: run.persona ?? args.personaName ?? "default",
      maxSteps: run.maxSteps ?? args.maxSteps,
      scope: run.scope ?? args.scope,
      expectations: run.expect !== undefined ? run.expect : args.expectations,
    }));
  }
  const persona = args.personaName ?? "default";
  return [{
    name: `${persona} baseline`,
    persona,
    maxSteps: args.maxSteps,
    scope: args.scope,
    expectations: args.expectations,
  }];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function logResolvedConfiguration(args: CliArgs): void {
  const runs = resolvedRuns(args);
  const auth = args.email && args.password
    ? `credentials (${oneLine(args.email)})`
    : args.storageStatePath
      ? "storage state"
      : "anonymous";
  const safety = args.allowDestructive
    ? "destructive requests allowed"
    : `blocked methods: ${args.blockMethods.join(", ")}`;

  appLogger.phase("Configuration");
  appLogger.info(`  Source: ${args.configPath ?? "CLI arguments"}`);
  appLogger.info(`  Target: ${args.url}`);
  appLogger.info(`  Provider: ${args.provider}`);
  appLogger.info(`  Model: ${args.model}`);
  appLogger.info(`  Output root: ${args.output}`);
  appLogger.info(`  Authentication: ${auth}`);
  appLogger.info(`  Screenshots: ${args.screenshots ? "enabled" : "disabled"}`);
  appLogger.info(`  Response variants: ${(args.responseVariantMax ?? 0) > 0 ? `up to ${args.responseVariantMax}` : "disabled"}`);
  appLogger.info(`  Response fixture limit: ${args.responseFixtureMaxBytes !== undefined ? `${args.responseFixtureMaxBytes} bytes` : "default"}`);
  appLogger.info(`  Safety: ${safety}${args.safetyConfigPath ? `; URL rules: ${args.safetyConfigPath}` : ""}`);
  appLogger.info(`  Runs: ${runs.length}`);
  runs.forEach((run, index) => {
    appLogger.info(`    Run ${index + 1}: ${run.name}`);
    appLogger.info(`      Persona: ${run.persona}`);
    appLogger.info(`      Max steps: ${run.maxSteps}`);
    appLogger.info(`      Scope: ${run.scope ? oneLine(run.scope) : "none"}`);
    if (run.expectations.length === 0) {
      appLogger.info("      Expectations: none");
    } else {
      appLogger.info(`      Expectations: ${run.expectations.length}`);
      run.expectations.forEach((expectation, expectationIndex) => {
        appLogger.info(`        ${expectationIndex + 1}. ${oneLine(expectation)}`);
      });
    }
  });
}

function resolvedConfigurationDetails(args: CliArgs): Record<string, unknown> {
  return {
    command: args.command,
    url: args.url,
    provider: args.provider,
    model: args.model,
    output: args.output,
    configPath: args.configPath,
    screenshots: args.screenshots,
    responseVariants: args.responseVariantMax ?? 0,
    responseFixtureMaxBytes: args.responseFixtureMaxBytes,
    auth: { method: args.email && args.password ? "credentials" : args.storageStatePath ? "storage_state" : "anonymous", email: args.email, passwordProvided: Boolean(args.password) },
    safety: { allowDestructive: args.allowDestructive, blockMethods: args.blockMethods },
    runs: resolvedRuns(args),
  };
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  setAppLogger(new Logger(parsedArgs.logLevel));
  if (parsedArgs.command === "generate") {
    generateFromManifest(parsedArgs);
    return;
  }
  const args = applyConfig(parsedArgs);
  appLogger.phase(`Starting ${args.command} execution for ${args.url}`);
  logResolvedConfiguration(args);
  appLogger.debug("execution.config_resolved", "Execution configuration resolved", resolvedConfigurationDetails(args));
  const execution = createExecutionDirectory(args.output);
  const executionArgs = { ...args, output: execution.path, outputSpecified: true };
  const executionCommand: "explore" | "run" = args.command === "explore" ? "explore" : "run";

  const batch = await exploreCoverage(executionArgs, execution.id);
  const manifestPath = writeDiscoveryArtifacts(batch);
  appLogger.result("done:\n  execution:                           " + execution.path +
    "\n  report JSON:                         " + join(executionArgs.output, "report.json") +
    "\n  report HTML:                         " + join(executionArgs.output, "report.html") +
    "\n  discovery bundle:                   " + manifestPath +
    "\n  evidence:                           " + batch.evidencePath);

  if (executionArgs.command === "explore") {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    appLogger.result(`summary: ${report.summary.runs} persona(s), ${report.summary.flowsFound} flow(s) found, ${report.summary.replayConfirmed} replay-confirmed`);
    return;
  }
  if (batch.confirmedFlows.length === 0) {
    const report = writeExecutionReport(batch, executionCommand, execution, 0);
    process.exitCode = report.exitCode;
    appLogger.result("No confirmed regression flow to generate; see the execution report.");
    return;
  }

  appLogger.phase("Generating test suite");
  logCodegenPlan(appLogger, "run", batch.confirmedFlows);
  const generatedSuite = writeGeneratedSuite(executionArgs.output, batch.confirmedFlows, {
    url: executionArgs.url,
    username: executionArgs.email,
    password: executionArgs.password,
    storageStatePath: executionArgs.storageStatePath,
  });
  logCodegenCompleted(appLogger, "run", batch.confirmedFlows);
  appLogger.result("test suite (" + batch.confirmedFlows.length + " test(s)): " + generatedSuite.specPath);
  if (generatedSuite.fixtureHelperPath) {
    appLogger.result("fixtures: " + generatedSuite.fixtureHelperPath);
  }
  const report = writeExecutionReport(batch, executionCommand, execution, batch.confirmedFlows.length, {
    fixtures: generatedSuite.fixtureHelperPath ? "fixtures.ts" : undefined,
  });
  process.exitCode = report.exitCode;
  appLogger.result(`summary: ${report.summary.runs} persona(s), ${report.summary.flowsFound} flow(s) found, ${report.summary.replayConfirmed} replay-confirmed, ${report.summary.generatedTests} test(s) generated`);
}

main().catch((err) => {
  appLogger.error(logError(err));
  appLogger.debug("execution.failed", "Execution failed unexpectedly", { error: logError(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
