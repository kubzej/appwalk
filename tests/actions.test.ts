import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { executeToolCall } from "../src/agent/tools.js";
import { burst } from "../src/browser/actions.js";
import type { TabRegistry } from "../src/agent/tools.js";

test("burst enforces its count limit even when called outside tool dispatch", async () => {
  const page = {} as import("playwright").Page;
  for (const count of [0, 2.5, 21]) {
    await assert.rejects(
      burst(page, "click", "#target", count),
      /burst: count must be a safe integer between 1 and 20\./,
    );
  }
});

test("navigate rejects non-web URLs before calling Playwright", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      executeToolCall(page, { id: "1", name: "navigate", input: { url: "file:///tmp/secret.txt" } }),
      /navigate URL must be a valid absolute http or https URL\./,
    );
  } finally {
    await browser.close();
  }
});

test("executes expanded pointer, drag, download, and state assertion actions", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://app.test/file.txt", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-disposition": "attachment; filename=export.txt" },
        body: "export",
      });
    });
    await page.setContent(`
      <button id="target">Target</button>
      <div id="source" draggable="true">Source</div>
      <div id="drop">Drop</div>
      <input id="value" value="ready">
      <input id="checked" type="checkbox" checked>
      <button id="disabled" disabled>Disabled</button>
      <select id="tags" multiple><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></select>
      <div class="item">One</div><div class="item">Two</div>
      <a id="download" href="https://app.test/file.txt" download>Download</a>
      <script>
        target.addEventListener('dblclick', () => target.dataset.doubleClicked = 'true');
        source.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'source'));
        drop.addEventListener('dragover', event => event.preventDefault());
        drop.addEventListener('drop', () => drop.dataset.dropped = 'true');
      </script>
    `);

    await executeToolCall(page, { id: "1", name: "doubleClick", input: { locator: "#target" } });
    assert.equal(await page.locator("#target").getAttribute("data-double-clicked"), "true");

    await executeToolCall(page, { id: "2", name: "dragAndDrop", input: { source: "#source", target: "#drop" } });
    assert.equal(await page.locator("#drop").getAttribute("data-dropped"), "true");

    const downloadResult = await executeToolCall(page, { id: "3", name: "download", input: { locator: "#download" } });
    assert.match(downloadResult.snapshot, /Download - export\.txt \(6 bytes\)/);

    await executeToolCall(page, { id: "3b", name: "select", input: { locator: "#tags", value: ["one", "three"] } });
    assert.deepEqual(
      await page.locator("#tags").evaluate((element) => Array.from((element as HTMLSelectElement).selectedOptions).map((option) => option.value)),
      ["one", "three"],
    );

    for (const [id, input] of [
      ["4", { expectationIndex: 1, assertion: "value", locator: "#value", value: "ready" }],
      ["5", { expectationIndex: 2, assertion: "checked", locator: "#checked" }],
      ["6", { expectationIndex: 3, assertion: "disabled", locator: "#disabled" }],
      ["7", { expectationIndex: 4, assertion: "count", locator: ".item", expectedCount: 2 }],
    ] as const) {
      const result = await executeToolCall(page, { id, name: "verifyExpectation", input });
      assert.equal(result.expectation?.status, "met");
    }
  } finally {
    await browser.close();
  }
});

test("apiRequest reaches the API directly, using the current session's cookies", async () => {
  // page.request is a real, separate HTTP client — page.route() mocks (which don't touch real
  // DNS/network) can't stand in for the target here the way they do for browser-driven requests;
  // a real local server is needed, same reasoning as the WebSocket and setOffline tests above.
  const { createServer } = await import("node:http");
  let seenCookie: string | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "session=abc123; Path=/" });
      res.end("<h1>ok</h1>");
      return;
    }
    if (req.url === "/api/admin") {
      seenCookie = req.headers.cookie;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secret: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/login`);

    const apiUrl = `http://127.0.0.1:${port}/api/admin`;
    const result = await executeToolCall(page, { id: "1", name: "apiRequest", input: { method: "GET", url: apiUrl } });

    assert.equal(seenCookie, "session=abc123", "the request must carry the same session cookies as the browser");
    assert.match(result.snapshot, new RegExp(`API GET ${apiUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} -> 200`));
    assert.match(result.snapshot, /"secret":true/);
  } finally {
    await browser.close();
    server.close();
  }
});

test("apiRequest rejects a non-GET/HEAD method at runtime, not just via the tool schema", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");

    // A nonexistent domain: if the runtime guard didn't run before dispatch, this would instead
    // reject with a DNS/network error, not the guard's own message — proving the check happens
    // before any request is attempted, not just that *some* rejection occurred.
    await assert.rejects(
      executeToolCall(page, { id: "1", name: "apiRequest", input: { method: "DELETE", url: "https://this-domain-does-not-exist.invalid/api/thing" } }),
      /Invalid input for tool "apiRequest": \$\.method must be one of GET, HEAD\./,
    );
  } finally {
    await browser.close();
  }
});

test("apiRequest applies URL safety rules while keeping GET allowed elsewhere", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/read-only`;
  const blocked: Array<{ method: string; url: string }> = [];
  const safety = {
    allowDestructive: false,
    config: { block: [url], allow: [] },
    onBlocked: (request: { method: string; url: string }) => blocked.push(request),
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      executeToolCall(page, { id: "1", name: "apiRequest", input: { method: "GET", url } }, undefined, safety),
      /apiRequest: blocked by safety policy: GET/,
    );
    assert.deepEqual(blocked, [{ method: "GET", url: `http://127.0.0.1:${port}/api/read-only` }]);

    const allowedUrl = `${url}/allowed`;
    const allowed = await executeToolCall(
      page,
      { id: "2", name: "apiRequest", input: { method: "GET", url: allowedUrl } },
      undefined,
      { allowDestructive: false, config: { block: [`http://127.0.0.1:${port}/**`], allow: [allowedUrl] } },
    );
    assert.match(allowed.snapshot, /API GET .*\/allowed -> 200/);
  } finally {
    await browser.close();
    server.close();
  }
});

test("documents why apiRequest is read-only-only: page.request bypasses the context-level safety guard entirely", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let routeSawIt = false;
    await context.route("**/*", async (route) => { routeSawIt = true; await route.abort(); });
    const page = await context.newPage();

    // If this ever starts failing because Playwright made page.request respect context.route(),
    // that's good news — it would mean apiRequest could safely support mutating methods too by
    // routing them through the same guard, instead of being restricted to GET/HEAD.
    const response = await page.request.get(`http://127.0.0.1:${port}/`).catch((error: Error) => error);
    assert.equal(routeSawIt, false, "context.route() must not see an APIRequestContext call");
    assert.ok(!(response instanceof Error), "the request must succeed unblocked, proving the guard never saw it");
  } finally {
    await browser.close();
    server.close();
  }
});

test("download flags a 0-byte file as an empty download, not a silent success", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://app.test/empty.txt", async (route) => {
      await route.fulfill({ status: 200, headers: { "content-disposition": "attachment; filename=empty.txt" }, body: "" });
    });
    await page.setContent(`<a id="download" href="https://app.test/empty.txt" download>Download</a>`);

    const result = await executeToolCall(page, { id: "1", name: "download", input: { locator: "#download" } });
    assert.match(result.snapshot, /Download - empty\.txt \(0 bytes — an empty file was downloaded\)/);
  } finally {
    await browser.close();
  }
});

test("download reports a real failure reason instead of claiming success", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://app.test/**", async (route) => {
      if (route.request().url().endsWith("/page")) {
        await route.fulfill({ status: 200, contentType: "text/html", body: `<a id="download" href="/broken.bin" download>Download</a>` });
        return;
      }
      // A Content-Length promising far more than the body actually delivers reliably makes
      // Playwright report the download as failed/canceled — a real, reproducible failure, not a
      // contrived one.
      await route.fulfill({
        status: 200,
        headers: { "content-disposition": "attachment; filename=broken.bin", "content-length": "1000000" },
        body: "short",
      });
    });
    await page.goto("https://app.test/page");

    const result = await executeToolCall(page, { id: "1", name: "download", input: { locator: "#download" } });
    assert.match(result.snapshot, /Download - broken\.bin FAILED: /);
  } finally {
    await browser.close();
  }
});

test("setOffline drops every request in the context, not just one armed request, and restores it again", async () => {
  // A page.route() mock never actually reaches Chromium's network layer, so setOffline (which
  // simulates that layer being down) wouldn't affect it — a real local server is needed to
  // genuinely exercise the same network path a real request takes, without depending on the
  // outside internet being reachable from wherever this test runs.
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const beforeOk = await page.evaluate((p) => fetch(`http://127.0.0.1:${p}/api`).then(() => true).catch(() => false), port);
    assert.equal(beforeOk, true, "sanity check: the real local server is reachable before going offline");

    await executeToolCall(page, { id: "1", name: "setOffline", input: { offline: true } });
    const firstFailed = await page.evaluate((p) => fetch(`http://127.0.0.1:${p}/api/one`).then(() => false).catch(() => true), port);
    const secondFailed = await page.evaluate((p) => fetch(`http://127.0.0.1:${p}/api/two`).then(() => false).catch(() => true), port);
    assert.equal(firstFailed, true, "first request must fail while offline");
    assert.equal(secondFailed, true, "a second, different request must also fail — not just the first one armed");

    await executeToolCall(page, { id: "2", name: "setOffline", input: { offline: false } });
    const restored = await page.evaluate((p) => fetch(`http://127.0.0.1:${p}/api/one`).then(() => true).catch(() => false), port);
    assert.equal(restored, true, "connectivity must be restored after setOffline(false)");
  } finally {
    await browser.close();
    server.close();
  }
});

test("verifyExpectation catches a value that becomes true shortly after the check starts, not just an already-true one", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="status" hidden>Saved</div>
      <input id="field" value="">
      <script>
        setTimeout(() => {
          document.getElementById('status').hidden = false;
          document.getElementById('field').value = 'saved-value';
        }, 300);
      </script>
    `);

    // Fired immediately, the same instant the delayed update is only just armed — this is exactly
    // the race a real async re-render creates, and would have read as "violated" before polling.
    const visibleResult = await executeToolCall(page, {
      id: "1", name: "verifyExpectation",
      input: { expectationIndex: 1, assertion: "visible", locator: "#status" },
    });
    assert.equal(visibleResult.expectation?.status, "met");

    const valueResult = await executeToolCall(page, {
      id: "2", name: "verifyExpectation",
      input: { expectationIndex: 2, assertion: "value", locator: "#field", value: "saved-value" },
    });
    assert.equal(valueResult.expectation?.status, "met");
  } finally {
    await browser.close();
  }
});

test("verifyExpectation still reports violated for a condition that never becomes true", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="status" hidden>Saved</div>`);

    const result = await executeToolCall(page, {
      id: "1", name: "verifyExpectation",
      input: { expectationIndex: 1, assertion: "visible", locator: "#status" },
    });
    assert.equal(result.expectation?.status, "violated");
  } finally {
    await browser.close();
  }
});

test("openTab and switchTab track multiple pages by id and share live storage like real browser tabs", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // openTab requires an explicit context — the browser.newPage() shorthand reserves its context for
    // a single page and rejects a second context.newPage(), which is exactly what openTab needs to
    // produce a genuine second tab instead of a storageState clone.
    const context = await browser.newContext();
    await context.route("https://app.test/cart", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Cart</h1>" });
    });
    const originalPage = await context.newPage();
    await originalPage.goto("https://app.test/cart");
    await originalPage.evaluate(() => localStorage.setItem("counter", "1"));
    const tabs: TabRegistry = new Map([["tab-0", originalPage]]);

    const openResult = await executeToolCall(originalPage, { id: "1", name: "openTab", input: {} }, tabs);
    assert.match(openResult.snapshot, /Opened tab: tab-1\. Open tabs: tab-0, tab-1 \(active: tab-1\)\./);
    assert.ok(openResult.activePage);
    assert.equal(tabs.size, 2);
    const newTabPage = openResult.activePage!;
    assert.equal(tabs.get("tab-1"), newTabPage);
    assert.equal(tabs.get("tab-0"), originalPage);

    // Real shared storage, not a point-in-time clone: the new tab sees what the original tab has right
    // now, and a write made in the new tab is visible back in the original tab too — both directions,
    // proving it's the same underlying store rather than two copies that happened to start equal.
    assert.equal(await newTabPage.evaluate(() => localStorage.getItem("counter")), "1");
    await newTabPage.evaluate(() => localStorage.setItem("counter", "2"));
    assert.equal(await originalPage.evaluate(() => localStorage.getItem("counter")), "2");

    const switchResult = await executeToolCall(newTabPage, { id: "2", name: "switchTab", input: { tabId: "tab-0" } }, tabs);
    assert.match(switchResult.snapshot, /Switched to tab: tab-0\. Open tabs: tab-0, tab-1 \(active: tab-0\)\./);
    assert.equal(switchResult.activePage, originalPage);

    await assert.rejects(
      executeToolCall(newTabPage, { id: "3", name: "switchTab", input: { tabId: "tab-9" } }, tabs),
      /no open tab with id "tab-9"/,
    );

    await assert.rejects(
      executeToolCall(originalPage, { id: "4", name: "openTab", input: {} }),
      /no tab registry available/,
    );
  } finally {
    await browser.close();
  }
});
