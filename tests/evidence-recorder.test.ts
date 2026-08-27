import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { chromium, type Page, type Response } from "playwright";
import { EvidenceRecorder } from "../src/evidence/recorder.js";

test("records browser runtime errors without exposing sensitive values", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const recorder = new EvidenceRecorder(page);
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
    const recorder = new EvidenceRecorder(page);
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
    const recorder = new EvidenceRecorder(page);
    recorder.markSafetyBlocked({ method: "POST", url: "https://example.test/api/cart" });
    await page.evaluate(() => console.error("Request failed: Failed to fetch"));

    const consoleError = recorder.runtimeErrors.find((error) => error.kind === "console_error");
    assert.equal(consoleError?.safetyRelated, true);
  } finally {
    await browser.close();
  }
});

test("does not block cleanup on a JSON response body that never settles", async () => {
  const page = new EventEmitter() as unknown as Page;
  const recorder = new EvidenceRecorder(page, undefined, { bodyReadTimeoutMs: 10 });
  const response = {
    request: () => ({ method: () => "GET" }),
    url: () => "https://example.test/api/stream",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    json: () => new Promise<unknown>(() => undefined),
  } as unknown as Response;

  (page as unknown as { emit: (event: string, value: unknown) => boolean }).emit("response", response);
  await recorder.waitForPendingBodies();

  assert.equal(recorder.network[0]?.body, undefined);
});

test("classifies navigation cancellation as lifecycle noise", () => {
  const page = new EventEmitter() as unknown as Page;
  const recorder = new EvidenceRecorder(page);
  const request = {
    method: () => "GET",
    url: () => "https://example.test/catalog",
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  };

  (page as unknown as { emit: (event: string, value: unknown) => boolean }).emit("requestfailed", request);

  assert.equal(recorder.runtimeErrors[0]?.kind, "request_failed");
  assert.equal(recorder.runtimeErrors[0]?.lifecycle, true);
});
