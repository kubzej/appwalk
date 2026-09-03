import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_UPLOAD_INPUT_ROOT,
  UploadInputPolicy,
} from "../src/security/upload-inputs.js";

test("default upload input policy accepts only the project's approved agent input", () => {
  const [resolved] = new UploadInputPolicy().resolvePaths([
    "agent-inputs/uploads/uma/valid.png",
  ]);

  assert.equal(resolved, realpathSync(join(DEFAULT_UPLOAD_INPUT_ROOT, "uma/valid.png")));
});

test("upload input policy rejects absolute, traversal, and outside-root paths", () => {
  const policy = new UploadInputPolicy();

  assert.throws(() => policy.resolvePaths(["/etc/passwd"]), /must be a relative path/);
  assert.throws(
    () => policy.resolvePaths(["agent-inputs/uploads/../package.json"]),
    /must be a relative path without traversal/,
  );
  assert.throws(
    () => policy.resolvePaths(["package.json"]),
    /must be inside agent-inputs\/uploads/,
  );
});

test("upload input policy rejects missing paths, directories, symlinks, and too many files", () => {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-upload-inputs-"));
  const baseDir = join(directory, "project");
  const root = join(baseDir, "agent-inputs", "uploads");
  const outside = join(directory, "outside.txt");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "allowed.txt"), "allowed");
  mkdirSync(join(root, "directory"));
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "escape.txt"));

  try {
    const policy = new UploadInputPolicy({ root, baseDir });

    assert.throws(() => policy.resolvePaths(["agent-inputs/uploads/missing.txt"]), /does not exist/);
    assert.throws(() => policy.resolvePaths(["agent-inputs/uploads/directory"]), /not a regular file/);
    assert.throws(() => policy.resolvePaths(["agent-inputs/uploads/escape.txt"]), /symbolic links/);
    assert.throws(
      () => policy.resolvePaths(Array.from({ length: 11 }, () => "agent-inputs/uploads/allowed.txt")),
      /no more than 10/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
