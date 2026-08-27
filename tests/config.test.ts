import assert from "node:assert/strict";
import test from "node:test";
import { validateResolvedOptions } from "../src/config.js";

const validOptions = {
  url: "https://example.test",
  output: "./appwalk-output",
  provider: "openai",
  model: "test-model",
  maxSteps: 15,
};

test("accepts a complete resolved configuration", () => {
  assert.doesNotThrow(() => validateResolvedOptions(validOptions));
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
});
