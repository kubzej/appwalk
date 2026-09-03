import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chromium, type BrowserContext, type Response } from "playwright";
import { EvidenceRecorder } from "../src/evidence/recorder.js";

test("records browser runtime errors without exposing sensitive values", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const recorder = new EvidenceRecorder(page.context());
    await page.evaluate(() => {
      console.error("token=do-not-print");
      setTimeout(() => { throw new Error("password=do-not-print"); }, 0);
    });
    await page.waitForTimeout(20);

    const drained = recorder.drain();
    assert.equal(drained.runtimeErrors.length, 2);
    assert.equal(drained.runtimeErrors[0]?.kind, "console_error");
    assert.equal(drained.runtimeErrors[1]?.kind, "page_error");
    assert.doesNotMatch(JSON.stringify(drained.runtimeErrors), /do-not-print/);
  } finally {
    await browser.close();
  }
});

test("marks request failures caused by a safety block", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const recorder = new EvidenceRecorder(page.context());
    const url = "https://example.test/api/cart";
    await page.route(url, async (route) => route.abort());
    recorder.markSafetyBlocked({ method: "POST", url });
    await page.evaluate(async () => {
      try {
        await fetch("https://example.test/api/cart", { method: "POST" });
      } catch {
        // The rejected fetch is the browser-visible result of the intentional abort.
      }
    });
    await page.waitForTimeout(20);

    const blockedError = recorder.runtimeErrors.find((error) => error.kind === "request_failed");
    assert.equal(blockedError?.safetyRelated, true);
  } finally {
    await browser.close();
  }
});

test("marks a related fetch console error as safety-related without matching an app-specific message", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const recorder = new EvidenceRecorder(page.context());
    recorder.markSafetyBlocked({ method: "POST", url: "https://example.test/api/cart" });
    await page.evaluate(() => console.error("Request failed: Failed to fetch"));

    const consoleError = recorder.runtimeErrors.find((error) => error.kind === "console_error");
    assert.equal(consoleError?.safetyRelated, true);
  } finally {
    await browser.close();
  }
});

test("does not block cleanup on a JSON response body that never settles", async () => {
  const context = new EventEmitter() as unknown as BrowserContext;
  const recorder = new EvidenceRecorder(context, undefined, { bodyReadTimeoutMs: 10 });
  const response = {
    request: () => ({ method: () => "GET" }),
    url: () => "https://example.test/api/stream",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    json: () => new Promise<unknown>(() => undefined),
  } as unknown as Response;

  (context as unknown as { emit: (event: string, value: unknown) => boolean }).emit("response", response);
  await recorder.waitForPendingBodies();

  assert.equal(recorder.network[0]?.body, undefined);
  assert.equal(recorder.network[0]?.bodyReadTimedOut, true);
});

test("does not mutate evidence when a timed-out JSON body resolves later", async () => {
  const context = new EventEmitter() as unknown as BrowserContext;
  const recorder = new EvidenceRecorder(context, undefined, { bodyReadTimeoutMs: 10 });
  let resolveBody!: (body: unknown) => void;
  const bodyPromise = new Promise<unknown>((resolve) => { resolveBody = resolve; });
  const response = {
    request: () => ({ method: () => "GET" }),
    url: () => "https://example.test/api/slow",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    json: () => bodyPromise,
  } as unknown as Response;

  (context as unknown as { emit: (event: string, value: unknown) => boolean }).emit("response", response);
  await recorder.waitForPendingBodies();
  resolveBody({ arrivedAfterFinalization: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recorder.network[0]?.body, undefined);
  assert.equal(recorder.network[0]?.bodyReadTimedOut, true);
});

test("captures network and console activity from a second page in the same context with no reattach", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://app.test/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>ok</h1>" });
    });
    const recorder = new EvidenceRecorder(context);

    const firstPage = await context.newPage();
    await firstPage.goto("https://app.test/");

    // A page opened later in the same context (openTab's mechanism, or a popup the app opens
    // itself) — reattach() is never called for it, unlike before this change.
    const secondPage = await context.newPage();
    await secondPage.goto("https://app.test/second");
    await secondPage.evaluate(() => console.error("second-page-error"));
    await secondPage.waitForTimeout(20);

    const urls = recorder.network.map((entry) => entry.url);
    assert.ok(urls.some((url) => url === "https://app.test/"), "first page's navigation was captured");
    assert.ok(urls.some((url) => url === "https://app.test/second"), "second page's navigation was captured with no reattach");
    assert.ok(
      recorder.runtimeErrors.some((error) => error.kind === "console_error" && error.message.includes("second-page-error")),
      "second page's console error was captured with no reattach",
    );
  } finally {
    await browser.close();
  }
});

test("reattach is idempotent — calling it twice for the same context does not double-count events", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://app.test/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>ok</h1>" });
    });
    const page = await context.newPage();
    const recorder = new EvidenceRecorder(context);

    // Simulates what happens on every activePage switch (openTab, switchTab) within one context —
    // reattach(page) is called unconditionally; it must not add a second listener each time.
    recorder.reattach(page);
    recorder.reattach(page);
    recorder.reattach(page);

    await page.goto("https://app.test/");
    await page.waitForTimeout(20);

    const matchingEntries = recorder.network.filter((entry) => entry.url === "https://app.test/");
    assert.equal(matchingEntries.length, 1);
  } finally {
    await browser.close();
  }
});

test("classifies navigation cancellation as lifecycle noise", () => {
  const context = new EventEmitter() as unknown as BrowserContext;
  const recorder = new EvidenceRecorder(context);
  const request = {
    method: () => "GET",
    url: () => "https://example.test/catalog",
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  };

  (context as unknown as { emit: (event: string, value: unknown) => boolean }).emit("requestfailed", request);

  assert.equal(recorder.runtimeErrors[0]?.kind, "request_failed");
  assert.equal(recorder.runtimeErrors[0]?.lifecycle, true);
});
