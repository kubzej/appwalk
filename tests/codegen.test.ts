import assert from "node:assert/strict";
import test from "node:test";
import { generateSpec } from "../src/codegen/spec.js";

test("generated login helpers are typed and duplicate flow titles are unique", () => {
  const spec = generateSpec([
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Bluetooth Speaker", entries: [] },
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Webcam", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  });

  assert.match(spec, /type Locator, type Page/);
  assert.match(spec, /findByLabelOrRole\(page: Page, \.\.\.patterns: RegExp\[\]\): Promise<Locator \| null>/);
  assert.match(spec, /loginFirstMatch\(page: Page, username: string, password: string\): Promise<void>/);
  assert.match(spec, /test\('Checkout Order Confirmation - Checkout Order Confirmation for Bluetooth Speaker',/);
  assert.match(spec, /test\('Checkout Order Confirmation - Checkout Order Confirmation for Webcam',/);
});
