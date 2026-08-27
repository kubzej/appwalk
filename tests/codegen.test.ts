import assert from "node:assert/strict";
import test from "node:test";
import { generateSpec, generateSpecBundle } from "../src/codegen/spec.js";

test("generated login helpers are typed and duplicate flow titles are unique", () => {
  const spec = generateSpec([
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Bluetooth Speaker", entries: [] },
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Webcam", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  });

  assert.match(spec, /import \{ loginWithCredentials \} from '\.\/auth\.js';/);
  assert.doesNotMatch(spec, /findLoginField|loginWithCredentials\(page: Page/);
  const auth = generateSpecBundle([
    { title: "Login", name: "Login", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  }).artifacts.find((artifact) => artifact.relativePath === "auth.ts");
  assert.ok(auth);
  assert.match(auth.content, /findLoginField\(page: Page, \.\.\.patterns: RegExp\[\]\): Promise<Locator \| null>/);
  assert.match(auth.content, /loginWithCredentials\(page: Page, username: string, password: string\): Promise<void>/);
  assert.match(spec, /test\('Checkout Order Confirmation - Checkout Order Confirmation for Bluetooth Speaker',/);
  assert.match(spec, /test\('Checkout Order Confirmation - Checkout Order Confirmation for Webcam',/);
});

test("generated response fixtures live in shared artifacts and variants use patches", () => {
  const baseFixtures = [{
    method: "GET",
    url: "https://example.test/api/orders/42",
    occurrence: 1,
    urlPattern: "https://example.test/api/orders/*",
    status: 200,
    body: { status: "pending", total: 42 },
  }];
  const variant = {
    name: "Shipped order",
    sourceMethod: "GET",
    sourceUrl: "https://example.test/api/orders/42",
    sourceOccurrence: 1,
    patches: [{ path: "$.status", value: "shipped" }],
    expectation: { assertion: "containsText" as const, locator: "text=Shipped", value: "Shipped" },
  };

  const bundle = generateSpecBundle([
    {
      fixtureBaseId: "base-1",
      name: "Checkout order",
      entries: [],
      responseFixtures: baseFixtures,
    },
    {
      fixtureBaseId: "base-1",
      baseResponseFixtures: baseFixtures,
      responseFixtures: [{ ...baseFixtures[0]!, body: { status: "shipped", total: 42 } }],
      responseVariant: variant,
      origin: "derived",
      name: "Checkout order - Shipped order",
      entries: [],
    },
  ], { url: "https://example.test" });

  assert.match(bundle.spec, /import \{ installFixtures, loadScenario \} from '\.\/fixtures\.js';/);
  assert.match(bundle.spec, /loadScenario\('flow-001\.base'\)/);
  assert.match(bundle.spec, /loadScenario\('flow-001-variant-001'\)/);
  assert.doesNotMatch(bundle.spec, /const fixtures = \[/);

  const artifactPaths = bundle.artifacts.map((artifact) => artifact.relativePath);
  assert.deepEqual(artifactPaths, [
    "fixtures.ts",
    "fixtures/flow-001.base.json",
    "fixtures/flow-001-variant-001.json",
  ]);
  const variantArtifact = bundle.artifacts.find((artifact) => artifact.relativePath.endsWith("variant-001.json"));
  assert.ok(variantArtifact);
  assert.match(variantArtifact.content, /"base": "flow-001\.base\.json"/);
  assert.match(variantArtifact.content, /"path": "\$\.status"/);
});
