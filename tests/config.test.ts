import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { applyConfig, parseArgs } from "../src/cli/args.js";
import { loadAppwalkConfig, validateResolvedOptions } from "../src/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validOptions = {
  url: "https://example.test",
  output: "./appwalk-output",
  provider: "openai",
  model: "test-model",
  maxSteps: 15,
};

function assertCliUsageError(argv: string[], expected: RegExp): void {
  const originalExit = process.exit;
  const originalError = console.error;
  let output = "";
  process.exit = (() => { throw new Error("CLI usage exit"); }) as typeof process.exit;
  console.error = (...messages: unknown[]) => { output += messages.join(" ") + "\n"; };
  try {
    assert.throws(() => parseArgs(argv), /CLI usage exit/);
    assert.match(output, expected);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

test("accepts a complete resolved configuration", () => {
  assert.doesNotThrow(() => validateResolvedOptions({ ...validOptions, personaName: "noah" }));
});

test("maps a global YAML persona into the resolved run options", () => {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-config-"));
  const path = join(directory, "config.yaml");
  try {
    writeFileSync(path, [
      "version: 1",
      "url: https://example.test",
      "provider: openai",
      "model: test-model",
      "persona: noah",
    ].join("\n"));
    assert.equal(loadAppwalkConfig(path).persona, "noah");
    const resolved = applyConfig(parseArgs(["run", "--config", path]));
    assert.equal(resolved.personaName, "noah");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects missing provider and model instead of applying hidden defaults", () => {
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, provider: undefined }),
    /provider must be one of/,
  );
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, model: "" }),
    /model must be a non-empty string/,
  );
});

test("rejects invalid shared option values", () => {
  assert.throws(() => validateResolvedOptions({ ...validOptions, maxSteps: 0 }), /maxSteps must be a positive integer/);
  assert.throws(() => validateResolvedOptions({ ...validOptions, screenshots: "yes" }), /screenshots must be a boolean/);
  assert.throws(() => validateResolvedOptions({ ...validOptions, blockMethods: ["DELETE", ""] }), /blockMethods must be a list/);
  assert.throws(() => validateResolvedOptions({ ...validOptions, browserEngine: "safari" }), /browser must be one of chromium, firefox, or webkit/);
});

test("rejects malformed and non-web target URLs", () => {
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, url: "not a URL" }),
    /url must be a valid absolute http or https URL in options\./,
  );
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, url: "file:///tmp/app.html" }),
    /url must be a valid absolute http or https URL in options\./,
  );
  assert.doesNotThrow(() => validateResolvedOptions({ ...validOptions, url: "http://localhost:4173" }));
  assert.doesNotThrow(() => validateResolvedOptions({ ...validOptions, url: "https://login.example.test/oauth/start" }));
});

test("rejects unknown, extra, and duplicate CLI arguments", () => {
  assertCliUsageError(
    ["run", "https://example.test", "--max-step", "50"],
    /Unknown option "--max-step"\./,
  );
  assertCliUsageError(
    ["run", "https://example.test", "another-value"],
    /Unexpected positional argument "another-value"\./,
  );
  assertCliUsageError(
    ["run", "https://example.test", "--verbose", "--quiet"],
    /Option "--quiet" was specified more than once\./,
  );
  assert.doesNotThrow(() => parseArgs(["run", "https://example.test", "--expect", "first", "--expect", "second"]));
});

test("rejects unknown YAML keys at every supported config level", () => {
  const cases = [
    ["maxstep: 25", /Unknown config key .*\.maxstep\./],
    ["responses:\n  screenshotss: true", /Unknown config key .*\.responses\.screenshotss\./],
    ["auth:\n  token: secret", /Unknown config key .*\.auth\.token\./],
    ["safety:\n  allowAll: true", /Unknown config key .*\.safety\.allowAll\./],
    ["coverage:\n  unexpected: true", /Unknown config key .*\.coverage\.unexpected\./],
    ["coverage:\n  runs:\n    - name: smoke\n      maxstep: 10", /Unknown config key .*\.coverage\.runs\[0\]\.maxstep\./],
  ] as const;

  for (const [unknownConfig, expected] of cases) {
    const directory = mkdtempSync(join(tmpdir(), "appwalk-config-"));
    const path = join(directory, "config.yaml");
    try {
      writeFileSync(path, ["version: 1", "provider: openai", "model: test-model", unknownConfig].join("\n"));
      assert.throws(() => loadAppwalkConfig(path), expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("rejects partial credential login configuration", () => {
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, email: "user@example.test" }),
    /email and password must be provided together/,
  );
  assert.throws(
    () => validateResolvedOptions({ ...validOptions, password: "secret" }),
    /email and password must be provided together/,
  );
});

test("normalizes block methods consistently from YAML", () => {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-config-"));
  const path = join(directory, "config.yaml");
  try {
    writeFileSync(path, [
      "version: 1",
      "url: https://example.test",
      "provider: openai",
      "model: test-model",
      "safety:",
      "  blockMethods: [\" POST \", \"delete\"]",
    ].join("\n"));
    const resolved = applyConfig(parseArgs(["run", "--config", path]));
    assert.deepEqual(resolved.blockMethods, ["POST", "DELETE"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects partial credentials in YAML auth configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-config-"));
  const path = join(directory, "config.yaml");
  try {
    writeFileSync(path, [
      "version: 1",
      "provider: openai",
      "model: test-model",
      "auth:",
      "  email: user@example.test",
    ].join("\n"));
    assert.throws(() => loadAppwalkConfig(path), /email and password must be provided together/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("defaults to chromium and maps a YAML browser engine override", () => {
  assert.equal(applyConfig(parseArgs(["run", "https://example.test", "--provider", "openai", "--model", "test-model"])).browserEngine, "chromium");

  const directory = mkdtempSync(join(tmpdir(), "appwalk-config-"));
  const path = join(directory, "config.yaml");
  try {
    writeFileSync(path, [
      "version: 1",
      "url: https://example.test",
      "provider: openai",
      "model: test-model",
      "browser: firefox",
    ].join("\n"));
    assert.equal(loadAppwalkConfig(path).browser, "firefox");
    assert.equal(applyConfig(parseArgs(["run", "--config", path])).browserEngine, "firefox");
    // An explicit CLI flag still wins over the config file.
    assert.equal(applyConfig(parseArgs(["run", "--config", path, "--browser", "webkit"])).browserEngine, "webkit");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
