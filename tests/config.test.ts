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
