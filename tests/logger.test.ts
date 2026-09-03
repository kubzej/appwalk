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

test("interactive output carries status through color alone, never a status glyph", () => {
  const output = coloredOutput((logger) => {
    logger.phase("Exploring application");
    logger.success("Flow 1 replay confirmed");
    logger.warn("Coverage incomplete: action budget reached");
    logger.error("Replay failed");
  });
  assert.match(output, /36mExploring application/);
  assert.match(output, /32mFlow 1 replay confirmed/);
  assert.match(output, /33mCoverage incomplete/);
  assert.match(output, /31mReplay failed/);
  // No checkmarks, arrows, or warning signs anywhere — color alone is the status signal (never
  // bold — a tone is never boosted to bold), and the old ad hoc "ok"/"!" bracket tags never
  // come back either.
  assert.doesNotMatch(output, /[✓✗⚠▸]|ok\]|!\]|;1m/);
});

test("info carries no color at all; debug gets neutral gray, never a status color", () => {
  const infoOutput = coloredOutput((logger) => logger.info("Request observed"));
  assert.doesNotMatch(infoOutput, /\[\d/);

  const debugOutput = coloredOutput((logger) => logger.debug("agent.turn_started", "Agent context started"));
  assert.match(debugOutput, /90m/);
  assert.doesNotMatch(debugOutput, /3[1236];?1?m/);
});

test("debug output keeps its explicit event label and colors are optional", () => {
  const output = coloredOutput((logger) => logger.debug("provider.response_received", "Provider response received"));
  assert.match(output, /90m\[debug\] provider\.response_received: Provider response received/);
});

test("action failures are warnings in normal output but muted in verbose output", () => {
  let normal = "";
  let verbose = "";
  const normalStream = new Writable({ write(chunk, _encoding, done) { normal += chunk.toString(); done(); } });
  const verboseStream = new Writable({ write(chunk, _encoding, done) { verbose += chunk.toString(); done(); } });
  new Logger("normal", normalStream, {}, { color: true }).actionFailure("Action failed");
  new Logger("verbose", verboseStream, {}, { color: true }).actionFailure("Action failed");
  assert.match(normal, /33m.*Action failed/);
  assert.match(verbose, /90mAction failed/);
});

test("verbose output keeps the action tree clean while debug retains context", () => {
  let verbose = "";
  let debug = "";
  const verboseStream = new Writable({ write(chunk, _encoding, done) { verbose += chunk.toString(); done(); } });
  const debugStream = new Writable({ write(chunk, _encoding, done) { debug += chunk.toString(); done(); } });
  new Logger("verbose", verboseStream, { runId: "run-1", persona: "noah" }).verbose("Action  1/10: Click");
  new Logger("debug", debugStream, { runId: "run-1", persona: "noah" }).debug("agent.step", "Action completed", { error: "locator.click: Timeout" });
  assert.equal(verbose, "[noah] Action  1/10: Click\n");
  assert.match(debug, /runId: 'run-1'/);
  assert.match(debug, /locator\.click: Timeout/);
});

test("child() nests indentation one level per scope and never needs hand-typed spaces", () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const root = new Logger("normal", stream);
  const run = root.child({ runId: "run-1" });
  const flow = run.child({ flowIndex: 1 });
  root.phase("Starting execution");
  run.phase("Exploring application");
  flow.phase("Verifying flow 1");
  const lines = output.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.endsWith("Starting execution") && !lines[0]!.startsWith(" "));
  assert.ok(lines[1]!.endsWith("Exploring application") && lines[1]!.startsWith("  ") && !lines[1]!.startsWith("    "));
  assert.ok(lines[2]!.endsWith("Verifying flow 1") && lines[2]!.startsWith("    "));
});

test("phase() badges a scope's persona so interleaved multi-run output stays attributable", () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const run = new Logger("normal", stream).child({ persona: "Frustrated Buyer" });
  run.phase("Exploring application");
  assert.match(output, /\[Frustrated Buyer\]/);
  assert.match(output, /Exploring application/);
});

test("task() reports success with elapsed time and never spins on a non-color stream", async () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const logger = new Logger("normal", stream);
  const result = await logger.task("Launching browser", async () => 42);
  assert.equal(result, 42);
  const lines = output.split("\n").filter(Boolean);
  assert.equal(lines[0], "Launching browser");
  assert.match(lines[1]!, /Launching browser/);
});

test("task() reports failure and rethrows", async () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const logger = new Logger("normal", stream);
  await assert.rejects(() => logger.task("Launching browser", async () => { throw new Error("boom"); }), /boom/);
  const lines = output.split("\n").filter(Boolean);
  assert.equal(lines[0], "Launching browser");
  assert.match(lines[1]!, /Launching browser/);
});

test("task() is a plain passthrough at quiet level", async () => {
  const logger = new Logger("quiet", new Writable({ write(_c, _e, done) { done(); } }));
  const result = await logger.task("Launching browser", async () => "ok");
  assert.equal(result, "ok");
});
