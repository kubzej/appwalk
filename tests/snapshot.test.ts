import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ACCESSIBILITY_TREE_CHARS, truncateAccessibilityTree } from "../src/browser/snapshot.js";

test("truncateAccessibilityTree leaves a tree at or under the cap untouched", () => {
  const tree = "- navigation \"Main\":\n  - link \"Home\"";
  assert.equal(truncateAccessibilityTree(tree), tree);
});

test("truncateAccessibilityTree cuts an oversized tree at a line boundary and notes what was omitted", () => {
  const line = "  - listitem \"Order #1\":\n";
  const tree = line.repeat(Math.ceil((MAX_ACCESSIBILITY_TREE_CHARS + 5_000) / line.length));
  const result = truncateAccessibilityTree(tree);

  const markerIndex = result.indexOf("\n... [truncated");
  assert.ok(markerIndex > 0, "result must contain the truncation marker");
  const head = result.slice(0, markerIndex);

  assert.ok(result.length < tree.length, "result must be shorter than the original");
  assert.ok(result.includes("truncated"), "result must note that it was truncated");
  assert.ok(result.includes("more characters omitted"), "result must report how much was cut");
  assert.equal((head.length + 1) % line.length, 0, "cut must land on a line boundary, not mid-line");
  assert.ok(head.length <= MAX_ACCESSIBILITY_TREE_CHARS, "kept head must not exceed the cap");
});

test("truncateAccessibilityTree keeps the start of the tree, not the end", () => {
  const tree = `${"x".repeat(MAX_ACCESSIBILITY_TREE_CHARS)}\nSTART-MARKER\n${"y\n".repeat(20_000)}END-MARKER`;
  const result = truncateAccessibilityTree(tree);
  assert.ok(result.includes("x".repeat(100)), "must keep content from the start of the tree");
  assert.ok(!result.includes("END-MARKER"), "must not keep content from the end of an oversized tree");
});
