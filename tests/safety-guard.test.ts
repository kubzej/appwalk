import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { evaluateSafetyRequest, installDestructiveActionGuard } from "../src/safety/guard.js";

// Playwright dispatches the most-recently-registered route handler first for an overlapping
// pattern, and a handler that calls route.continue()/fulfill()/abort() does not chain to an
// earlier one — so the content mock (an exact page URL) is registered *after* the guard, letting
// it win for page loads, while the broad guard is the only handler left for anything else (the
// /api/cart fetches below), which is exactly what each test needs to exercise.
async function pageServedFrom(context: import("playwright").BrowserContext) {
  await context.route("https://app.test/", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>ok</h1>" });
  });
  const page = await context.newPage();
  await page.goto("https://app.test/");
  return page;
}

test("a context-level guard blocks a destructive request from a second page in the same context, with no reinstall", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const blocked: Array<{ method: string; url: string }> = [];

    // Installed once, on the context — never called again for the second page below.
    await installDestructiveActionGuard(context, {
      allowDestructive: false,
      onBlocked: (request) => blocked.push(request),
    });

    const firstPage = await pageServedFrom(context);
    await firstPage.evaluate(async () => {
      try { await fetch("https://app.test/api/cart", { method: "POST" }); } catch { /* aborted */ }
    });

    // A page appwalk itself opens later in the same context (openTab's mechanism) — no call to
    // installDestructiveActionGuard happens for it here, unlike the page-scoped guard this
    // replaces, which needed exactly that to protect a second tab.
    const secondPage = await context.newPage();
    await secondPage.goto("https://app.test/");
    await secondPage.evaluate(async () => {
      try { await fetch("https://app.test/api/cart", { method: "DELETE" }); } catch { /* aborted */ }
    });

    assert.equal(blocked.length, 2);
    assert.deepEqual(blocked.map((request) => request.method).sort(), ["DELETE", "POST"]);
  } finally {
    await browser.close();
  }
});

test("a context-level guard allows non-destructive requests, and installing it twice is a no-op", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let blockedCount = 0;
    const options = { allowDestructive: false, onBlocked: () => { blockedCount += 1; } };

    await installDestructiveActionGuard(context, options);
    await installDestructiveActionGuard(context, options); // idempotent — must not double-block

    const page = await pageServedFrom(context);
    await page.evaluate(async () => {
      try { await fetch("https://app.test/api/cart", { method: "GET" }); } catch { /* real network attempt, may fail for unrelated DNS reasons */ }
    });
    assert.equal(blockedCount, 0, "a GET must never reach onBlocked");

    await page.evaluate(async () => {
      try { await fetch("https://app.test/api/cart", { method: "POST" }); } catch { /* aborted */ }
    });
    assert.equal(blockedCount, 1, "a POST must be blocked exactly once, not twice from the duplicate install");
  } finally {
    await browser.close();
  }
});

test("allowDestructive disables default method blocking but preserves explicit URL blocks", () => {
  const options = {
    allowDestructive: true,
    config: {
      block: ["https://app.test/api/admin/**"],
      allow: ["https://app.test/api/admin/health"],
    },
  };

  assert.equal(
    evaluateSafetyRequest("POST", "https://app.test/api/admin/users", options).blocked,
    true,
  );
  assert.equal(
    evaluateSafetyRequest("GET", "https://app.test/api/admin/health", options).blocked,
    false,
  );
  assert.equal(
    evaluateSafetyRequest("POST", "https://app.test/api/orders", options).blocked,
    false,
  );
});
