import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSpec, generateSpecBundle } from "../src/codegen/spec.js";
import { writeGeneratedSuite } from "../src/cli/generated-suite.js";

test("generated login helpers are typed and duplicate flow titles are unique", () => {
  const spec = generateSpec([
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Bluetooth Speaker", entries: [] },
    { title: "Checkout Order Confirmation", name: "Checkout Order Confirmation for Webcam", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  });

  assert.match(spec, /import \{ loginWithConfiguredCredentials \} from '\.\/auth\.js';/);
  assert.match(spec, /await loginWithConfiguredCredentials\(page\);/);
  assert.doesNotMatch(spec, /tester|secret/);
  assert.doesNotMatch(spec, /findLoginField|loginWithCredentials\(page: Page/);
  const auth = generateSpecBundle([
    { title: "Login", name: "Login", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  }).artifacts.find((artifact) => artifact.relativePath === "auth.ts");
  assert.ok(auth);
  assert.match(auth.content, /findLoginField\(root: Page \| Locator, \.\.\.patterns: RegExp\[\]\): Promise<Locator \| null>/);
  assert.match(auth.content, /loginWithCredentials\(page: Page, username: string, password: string\): Promise<void>/);
  assert.match(auth.content, /remainsOnLoginRoute/);
  assert.match(auth.content, /Login did not complete/);
  assert.match(auth.content, /APPWALK_USERNAME/);
  assert.match(auth.content, /APPWALK_PASSWORD/);
  const credentials = generateSpecBundle([
    { title: "Login", name: "Login", entries: [] },
  ], {
    url: "https://example.test",
    username: "tester",
    password: "secret",
  }).artifacts.find((artifact) => artifact.relativePath === ".secrets.json");
  assert.ok(credentials);
  assert.match(credentials.content, /"username": "tester"/);
  assert.match(credentials.content, /"password": "secret"/);
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

test("generated credential sidecar is immediately usable and owner-readable only", () => {
  const directory = mkdtempSync(join(tmpdir(), "appwalk-generated-suite-"));
  try {
    const output = writeGeneratedSuite(directory, [{ name: "Login", entries: [] }], {
      url: "https://example.test",
      username: "tester",
      password: "secret",
    });

    assert.ok(output.credentialsPath);
    assert.equal(readFileSync(output.credentialsPath, "utf8"), '{\n  "username": "tester",\n  "password": "secret"\n}\n');
    assert.equal(statSync(output.credentialsPath).mode & 0o777, 0o600);
    assert.match(readFileSync(join(directory, "discovered.spec.ts"), "utf8"), /loginWithConfiguredCredentials/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated suites copy supplied storage state beside the spec", () => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), "appwalk-storage-source-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "appwalk-storage-output-"));
  const sourcePath = join(sourceDirectory, "state.json");
  writeFileSync(sourcePath, JSON.stringify({ cookies: [{ name: "session", value: "secret-token" }], origins: [] }));
  try {
    const output = writeGeneratedSuite(outputDirectory, [{ name: "Returning user", entries: [] }], {
      url: "https://example.test",
      storageStatePath: sourcePath,
    });

    assert.ok(output.storageStatePath);
    const spec = readFileSync(join(outputDirectory, "discovered.spec.ts"), "utf8");
    assert.match(spec, /test\.use\(\{ storageState: join\(generatedSuiteDirectory, '\.storage-state\.json'\) \}\);/);
    assert.doesNotMatch(spec, /secret-token/);
    assert.equal(JSON.parse(readFileSync(output.storageStatePath, "utf8")).cookies[0].value, "secret-token");
    assert.equal(statSync(output.storageStatePath).mode & 0o777, 0o600);
    assert.equal(output.credentialsPath, undefined);
  } finally {
    rmSync(sourceDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
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
  assert.match(spec, /import \{ stat \} from 'node:fs\/promises';/);
  assert.match(spec, /const downloadStats = await stat\(downloadPath\);/);
  assert.match(spec, /expect\(downloadStats\.size\)\.toBeGreaterThan\(0\);/);
  assert.match(spec, /page\.locator\('#tags'\)\.selectOption\(\['one', 'three'\]\);/);
});

test("generated tab flows register popups opened by the application", () => {
  const spec = generateSpec([
    {
      name: "OAuth popup flow",
      entries: [
        { index: 0, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "click", input: { locator: "role=button[name=\"Continue\"]" } }, network: [], console: [] },
        { index: 1, flowIndex: 0, timestamp: "2026-01-01T00:00:00.000Z", toolCall: { name: "switchTab", input: { tabId: "tab-1" } }, network: [], console: [] },
      ],
    },
  ], { url: "https://example.test" });

  assert.match(spec, /const popupPages = new WeakSet<typeof page>\(\);/);
  assert.match(spec, /sourcePage\.on\('popup', \(popup\) => \{/);
  assert.match(spec, /tabs\[newId\] = popup;/);
  assert.match(spec, /registerPopupPage\(popup\);/);
  assert.match(spec, /registerPopupPage\(page\);/);
  assert.match(spec, /page = tabs\['tab-1'\];/);
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

test("a device preset does not inline captured storage state", () => {
  const storageState = JSON.stringify({ cookies: [], origins: [] });
  const bundle = generateSpecBundle([
    {
      name: "Mobile returning user",
      devicePreset: "iPhone 17",
      startUrl: "https://example.test/account",
      startStorageState: storageState,
      entries: [],
    },
  ], { url: "https://example.test" });
  const spec = bundle.spec;

  assert.match(spec, /const flowContext = await browser\.newContext\(\{ \.\.\.devices\['iPhone 17'\] \}\);/);
  assert.doesNotMatch(spec, /loadStorageState/);
  assert.doesNotMatch(spec, /"cookies"|"origins"/);
  assert.match(spec, /await page\.goto\('https:\/\/example\.test\/account'\);/);
});

test("a flow without a device preset still uses the plain ambient page fixture", () => {
  const spec = generateSpec([
    { name: "Desktop checkout", entries: [] },
  ], { url: "https://example.test" });

  assert.doesNotMatch(spec, /devices/);
  assert.match(spec, /test\('Desktop checkout', async \(\{ page \}\) => \{/);
});
