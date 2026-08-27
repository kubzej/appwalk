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
