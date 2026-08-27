import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { executeToolCall } from "../src/agent/tools.js";

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
