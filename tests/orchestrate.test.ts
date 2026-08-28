import assert from "node:assert/strict";
import test from "node:test";
import { chromium, devices } from "playwright";
import { attachPopupDetection, deviceContextOptions } from "../src/cli/orchestrate.js";
import type { Persona } from "../src/agent/personas.js";
import { Logger } from "../src/logging/logger.js";

function spyLogger(): { logger: Logger; verboseMessages: string[] } {
  const logger = new Logger("quiet");
  const verboseMessages: string[] = [];
  logger.verbose = (message: string) => { verboseMessages.push(message); };
  logger.debug = () => {};
  return { logger, verboseMessages };
}

async function routedPage(browser: import("playwright").Browser) {
  const context = await browser.newContext();
  await context.route("https://app.test/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>ok</h1>" });
  });
  const page = await context.newPage();
  await page.goto("https://app.test/");
  return page;
}

test("attachPopupDetection logs a tab the page opens itself via window.open", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await routedPage(browser);
    const { logger, verboseMessages } = spyLogger();
    attachPopupDetection(page, logger);

    await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => { window.open("https://app.test/oauth-consent", "_blank"); }),
    ]);

    assert.equal(verboseMessages.length, 1);
    assert.match(verboseMessages[0]!, /new tab/i);
    assert.match(verboseMessages[0]!, /oauth-consent/);
  } finally {
    await browser.close();
  }
});

test("attachPopupDetection is idempotent — attaching twice does not double-log one popup", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await routedPage(browser);
    const { logger, verboseMessages } = spyLogger();

    // Simulates switchTab revisiting a page already instrumented on an earlier activePage switch.
    attachPopupDetection(page, logger);
    attachPopupDetection(page, logger);

    await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => { window.open("https://app.test/receipt", "_blank"); }),
    ]);

    assert.equal(verboseMessages.length, 1);
  } finally {
    await browser.close();
  }
});

test("attachPopupDetection does not fire for a page appwalk opens itself via context.newPage()", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { logger, verboseMessages } = spyLogger();
    attachPopupDetection(page, logger);

    // openTab's own mechanism — a deliberate second page, not something the original page opened.
    await context.newPage();
    await page.waitForTimeout(50);

    assert.equal(verboseMessages.length, 0);
  } finally {
    await browser.close();
  }
});

function personaWithDevice(devicePreset?: string): Persona {
  return { name: "Test persona", goal: "", intent: "journey", verificationMode: "completion", devicePreset };
}

test("deviceContextOptions returns nothing for a persona without a device preset", () => {
  assert.deepEqual(deviceContextOptions(undefined), {});
  assert.deepEqual(deviceContextOptions(personaWithDevice(undefined)), {});
});

test("deviceContextOptions returns the named device's fields, minus defaultBrowserType", () => {
  const options = deviceContextOptions(personaWithDevice("iPhone 17"));
  const { defaultBrowserType: _defaultBrowserType, ...expected } = devices["iPhone 17"]!;
  assert.deepEqual(options, expected);
  assert.ok(!("defaultBrowserType" in options), "defaultBrowserType is not a valid newContext() option and must be dropped");
});

test("deviceContextOptions throws a clear error for an unknown device name", () => {
  assert.throws(() => deviceContextOptions(personaWithDevice("Nokia 3310")), /Unknown device preset "Nokia 3310"/);
});

test("a context built from deviceContextOptions actually behaves like the named phone", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(deviceContextOptions(personaWithDevice("iPhone 17")));
    const page = await context.newPage();
    // A real navigation, not setContent() — Chromium only wires up the touch-input feature
    // detection (`'ontouchstart' in window`) through an actual page load.
    await page.goto("data:text/html,<h1>ok</h1>");

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const hasTouch = await page.evaluate(() => "ontouchstart" in window);
    const viewport = page.viewportSize();

    assert.match(userAgent, /iPhone/);
    assert.equal(hasTouch, true);
    assert.deepEqual(viewport, devices["iPhone 17"]!.viewport);

    // The browser engine actually running stays whatever was launched (chromium, by default) —
    // a device preset changes viewport/UA/touch, not which engine drives the browser.
    assert.equal(browser.browserType().name(), "chromium");
  } finally {
    await browser.close();
  }
});
