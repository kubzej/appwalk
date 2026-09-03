import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidenceLog } from "../src/evidence/log.js";
import { loadManifest } from "../src/cli/manifest.js";

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-artifact-validation-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("rejects structurally invalid evidence even when the JSON is valid", () => {
  withTempDirectory((directory) => {
    const path = join(directory, "evidence.jsonl");
    writeFileSync(path, JSON.stringify({
      index: 0,
      flowIndex: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      network: "not-an-array",
      console: [],
    }) + "\n");

    const result = readEvidenceLog(path);
    assert.equal(result.entries.length, 0);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!.reason, /evidence line 1\.network: must be an array/);
  });
});

test("rejects a manifest with invalid flow references and unknown fields", () => {
  withTempDirectory((directory) => {
    const path = join(directory, "discovery.json");
    writeFileSync(path, JSON.stringify({
      version: 2,
      url: "https://example.test",
      createdAt: "2026-01-01T00:00:00.000Z",
      exhausted: false,
      setup: { requiresLogin: false },
      intent: { expectations: [] },
      runs: [{
        id: "run-1",
        name: "Baseline",
        maxSteps: 10,
        expectations: [],
        exhausted: false,
        flowIds: [99],
      }],
      flows: [{
        id: 1,
        runId: "missing-run",
        name: "Broken flow",
        verified: true,
        replayConfirmed: true,
        startIndex: 0,
        endIndex: 0,
        startUrl: "https://example.test",
        unknownField: true,
      }],
    }) + "\n");

    assert.throws(
      () => loadManifest(path),
      /Invalid discovery manifest .*manifest\.flows\[0\]\.unknownField: unknown field.*must reference an existing run.*must reference an existing flow/,
    );
  });
});

test("accepts a structurally valid manifest", () => {
  withTempDirectory((directory) => {
    const path = join(directory, "discovery.json");
    writeFileSync(path, JSON.stringify({
      version: 2,
      url: "https://example.test",
      createdAt: "2026-01-01T00:00:00.000Z",
      exhausted: false,
      setup: { requiresLogin: false },
      intent: { expectations: [] },
      runs: [{
        id: "run-1",
        name: "Baseline",
        maxSteps: 10,
        expectations: [],
        exhausted: false,
        flowIds: [1],
      }],
      flows: [{
        id: 1,
        runId: "run-1",
        runFlowIndex: 0,
        name: "A real flow",
        verified: true,
        replayConfirmed: true,
        startIndex: 0,
        endIndex: 1,
        startUrl: "https://example.test",
        origin: "discovered",
      }],
    }) + "\n");

    assert.equal(loadManifest(path).flows[0]?.name, "A real flow");
  });
});
