import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { Logger } from "../src/logging/logger.js";

function outputFor(level: "normal" | "verbose" | "debug", callback: (logger: Logger) => void): string {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  callback(new Logger(level, stream));
  return output;
}

function coloredOutput(callback: (logger: Logger) => void): string {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  callback(new Logger("debug", stream, {}, { color: true }));
  return output;
}

test("normal output stays concise and omits diagnostic details", () => {
  const output = outputFor("normal", (logger) => logger.info("Exploration started", { action: 1, url: "https://example.test" }));
  assert.equal(output, "Exploration started\n");
});

test("verbose output includes useful details while redacting secrets", () => {
  const output = outputFor("verbose", (logger) => logger.info("Request observed", {
    method: "GET",
    token: "do-not-print",
  }));
  assert.match(output, /method: 'GET'/);
  assert.match(output, /token: '\[REDACTED\]'/);
  assert.doesNotMatch(output, /do-not-print/);
});

test("debug output includes a stable event name", () => {
  const output = outputFor("debug", (logger) => logger.debug("agent.turn_started", "Agent context started", { actionCount: 0 }));
  assert.match(output, /^\[debug\] agent\.turn_started: Agent context started/);
});

test("interactive output uses semantic colors without decorative status symbols", () => {
  const output = coloredOutput((logger) => {
    logger.phase("Exploring application");
    logger.success("Flow 1 replay confirmed");
    logger.warn("Coverage incomplete: action budget reached");
    logger.error("Replay failed");
  });
  assert.match(output, /\u001b\[36;1mExploring application\u001b\[0m/);
  assert.match(output, /\u001b\[32mFlow 1 replay confirmed\u001b\[0m/);
  assert.match(output, /\u001b\[33mCoverage incomplete/);
  assert.match(output, /\u001b\[31;1mReplay failed/);
  assert.doesNotMatch(output, /\[(?:ok|!)\]/);
});

test("debug output keeps its explicit event label and colors are optional", () => {
  const output = coloredOutput((logger) => logger.debug("provider.response_received", "Provider response received"));
  assert.match(output, /\u001b\[90m\[debug\] provider\.response_received: Provider response received\u001b\[0m/);
});

test("action failures are warnings in normal output but muted in verbose output", () => {
  let normal = "";
  let verbose = "";
  const normalStream = new Writable({ write(chunk, _encoding, done) { normal += chunk.toString(); done(); } });
  const verboseStream = new Writable({ write(chunk, _encoding, done) { verbose += chunk.toString(); done(); } });
  new Logger("normal", normalStream, {}, { color: true }).actionFailure("Action failed");
  new Logger("verbose", verboseStream, {}, { color: true }).actionFailure("Action failed");
  assert.match(normal, /\u001b\[33mAction failed\u001b\[0m/);
  assert.match(verbose, /\u001b\[90mAction failed\u001b\[0m/);
});

test("verbose output keeps the action tree clean while debug retains context", () => {
  let verbose = "";
  let debug = "";
  const verboseStream = new Writable({ write(chunk, _encoding, done) { verbose += chunk.toString(); done(); } });
  const debugStream = new Writable({ write(chunk, _encoding, done) { debug += chunk.toString(); done(); } });
  new Logger("verbose", verboseStream, { runId: "run-1", persona: "noah" }).verbose("      Action  1/10: Click");
  new Logger("debug", debugStream, { runId: "run-1", persona: "noah" }).debug("agent.step", "Action completed", { error: "locator.click: \u001b[2mTimeout\u001b[22m" });
  assert.equal(verbose, "      Action  1/10: Click\n");
  assert.match(debug, /runId: 'run-1'/);
  assert.match(debug, /locator\.click: Timeout/);
  assert.doesNotMatch(debug, /%1B|\u001b\[/);
});
