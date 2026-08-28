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

test("generates iframe locators and expanded actions as Playwright APIs", () => {
  const spec = generateSpec([
    {
      name: "Payment interaction",
      entries: [
        { index: 0, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "doubleClick", input: { locator: "frame=iframe[title=\"Payment\"] >> role=button[name=\"Pay\"]" } }, network: [], console: [] },
        { index: 1, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "dragAndDrop", input: { source: "#source", target: "#drop" } }, network: [], console: [] },
        { index: 2, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "download", input: { locator: "#download" } }, network: [], console: [] },
        { index: 3, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "select", input: { locator: "#tags", value: ["one", "three"] } }, network: [], console: [] },
      ],
    },
  ], { url: "https://example.test" });

  assert.match(spec, /page\.frameLocator\('iframe\[title="Payment"\]'\)\.getByRole\('button'/);
  assert.match(spec, /\.dblclick\(\);/);
  assert.match(spec, /page\.locator\('#source'\)\.dragTo\(page\.locator\('#drop'\)\);/);
  assert.match(spec, /page\.waitForEvent\('download'\)/);
  assert.match(spec, /expect\(await download\.failure\(\)\)\.toBeNull\(\);/);
  assert.match(spec, /expect\(downloadPath\)\.toBeTruthy\(\);/);
  assert.match(spec, /page\.locator\('#tags'\)\.selectOption\(\['one', 'three'\]\);/);
});

test("generates a genuine context-wide setOffline call, not a route mock", () => {
  const spec = generateSpec([
    {
      name: "Offline resilience",
      entries: [
        { index: 0, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "setOffline", input: { offline: true } }, network: [], console: [] },
        { index: 1, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "setOffline", input: { offline: false } }, network: [], console: [] },
      ],
    },
  ], { url: "https://example.test" });

  assert.match(spec, /await page\.context\(\)\.setOffline\(true\);/);
  assert.match(spec, /await page\.context\(\)\.setOffline\(false\);/);
});

test("a flow with a device preset gets its own context with the device spread in, and imports devices", () => {
  const spec = generateSpec([
    {
      name: "Mobile checkout",
      devicePreset: "iPhone 17",
      entries: [
        { index: 0, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "click", input: { locator: "role=button[name=\"Checkout\"]" } }, network: [], console: [] },
      ],
    },
  ], { url: "https://example.test" });

  assert.match(spec, /import \{ test, expect, devices \} from '@playwright\/test';/);
  assert.match(spec, /test\('Mobile checkout', async \(\{ browser \}\) => \{/);
  assert.match(spec, /const flowContext = await browser\.newContext\(\{ \.\.\.devices\['iPhone 17'\] \}\);/);
  assert.match(spec, /let page = await flowContext\.newPage\(\);/);
  assert.match(spec, /await page\.goto\('https:\/\/example\.test'\);/);
  assert.match(spec, /await flowContext\.close\(\);/);
});

test("a device preset combines with the flow's own storageState in one newContext() call", () => {
  const storageState = JSON.stringify({ cookies: [], origins: [] });
  const spec = generateSpec([
    {
      name: "Mobile returning user",
      devicePreset: "iPhone 17",
      startUrl: "https://example.test/account",
      startStorageState: storageState,
      entries: [],
    },
  ], { url: "https://example.test" });

  assert.match(spec, /const flowContext = await browser\.newContext\(\{ \.\.\.devices\['iPhone 17'\], storageState: \{"cookies":\[\],"origins":\[\]\} \}\);/);
  assert.match(spec, /await page\.goto\('https:\/\/example\.test\/account'\);/);
});

test("a flow without a device preset still uses the plain ambient page fixture", () => {
  const spec = generateSpec([
    { name: "Desktop checkout", entries: [] },
  ], { url: "https://example.test" });

  assert.doesNotMatch(spec, /devices/);
  assert.match(spec, /test\('Desktop checkout', async \(\{ page \}\) => \{/);
});
