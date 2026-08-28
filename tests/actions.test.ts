import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { executeToolCall } from "../src/agent/tools.js";
import type { TabRegistry } from "../src/agent/tools.js";

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
    assert.match(downloadResult.snapshot, /Download - export\.txt/);

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
