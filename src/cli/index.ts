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

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  setAppLogger(new Logger(parsedArgs.logLevel));
  if (parsedArgs.command === "generate") {
    generateFromManifest(parsedArgs);
    return;
  }
  const args = applyConfig(parsedArgs);
  appLogger.info(`Starting ${args.command} execution for ${args.url}`);
  appLogger.debug("execution.config_resolved", "Execution configuration resolved", {
    command: args.command, url: args.url, provider: args.provider, model: args.model,
    maxSteps: args.maxSteps, personas: args.coverageRuns?.map((run) => run.name) ?? [args.personaName ?? "default"],
    scopePresent: Boolean(args.scope), expectations: args.expectations.length, screenshots: args.screenshots,
  });
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

  appLogger.info("Generating test suite");
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
