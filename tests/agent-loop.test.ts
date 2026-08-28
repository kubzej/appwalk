import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { buildSystemPrompt, runAgentLoop } from "../src/agent/loop.js";
import { captureSnapshot } from "../src/browser/snapshot.js";
import type { LlmProvider, ProviderTurn, ToolDefinition, ToolResult } from "../src/providers/provider.js";

class TextOnlyProvider implements LlmProvider {
  async start(_params: { systemPrompt: string; tools: ToolDefinition[]; initialInput: string; screenshot?: string }): Promise<ProviderTurn> {
    return { type: "text", text: "I found a page, but did not complete a flow." };
  }

  async continue(_toolResult: ToolResult): Promise<ProviderTurn> {
    return { type: "text", text: "stop" };
  }
}

test("stops on plain provider text without inventing a flow", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<main><h1>Example</h1></main>");
    const result = await runAgentLoop(page, new TextOnlyProvider(), { maxSteps: 5 });
    assert.equal(result.flows.length, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0]?.finalText, "I found a page, but did not complete a flow.");
    assert.equal(result.exhausted, false);
    assert.equal(result.stopReason, "agent_stopped");
  } finally {
    await browser.close();
  }
});

test("grounds expectations in behavior performed by the current flow", () => {
  const prompt = buildSystemPrompt(20, false, undefined, "Checkout", ["A completed order reaches confirmation"]);
  assert.match(prompt, /current flow itself/);
  assert.match(prompt, /read-only flow that opens an existing record/);
  assert.match(prompt, /Do not verify an expectation just because the page contains similar text/);
});

test("page observation supplements accessibility tree with stable DOM hints", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
        <main>
          <div data-testid="save-card" onclick="this.dataset.saved = 'true'">Save card</div>
          <div class="account-menu flex items-center" style="width: 20px; height: 20px" onclick="this.hidden = true"></div>
          <button id="submit" disabled>Submit</button>
        <label for="email">Email</label><input id="email" name="email" placeholder="you@example.com" required>
        <select data-testid="country" multiple><option value="cz" selected>Czechia</option><option value="sk">Slovakia</option></select>
        <iframe title="Payment provider" src="/payment"></iframe>
      </main>
    `);

    const snapshot = await captureSnapshot(page);

    assert.match(snapshot, /Accessibility tree:/);
    assert.match(snapshot, /Interactive elements:/);
    assert.match(snapshot, /Save card.*\[data-testid="save-card"\]/);
    assert.match(snapshot, /div.*\[class~="account-menu"\]/);
    assert.match(snapshot, /button "Submit".*disabled/);
    assert.match(snapshot, /textbox "Email".*\[id="email"\].*required/);
    assert.match(snapshot, /combobox "Czechia Slovakia".*multiple.*options: Czechia=cz \(selected\), Slovakia=sk/);
    assert.match(snapshot, /Frames:/);
    assert.match(snapshot, /Payment provider/);
  } finally {
    await browser.close();
  }
});

test("page observation flags an element whose content overflows its own box", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button id="clipped" style="width: 40px; overflow: hidden; white-space: nowrap;">Verylongunbrokenproductnamethatoverflows</button>
        <button id="fits" style="width: 200px;">Fits fine</button>
      </main>
    `);

    const snapshot = await captureSnapshot(page);

    assert.match(snapshot, /button "Verylongunbrokenproductnamethatoverflows".*content-overflows/);
    // The element that fits gets no such flag — must not appear right after its own entry.
    const fitsLine = snapshot.split("\n").find((line) => line.includes('"Fits fine"'));
    assert.ok(fitsLine, "expected a line for the #fits button");
    assert.doesNotMatch(fitsLine!, /content-overflows/);
  } finally {
    await browser.close();
  }
});

test("page observation does not flag a deliberately line-clamped description as overflowing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <div id="clamped" tabindex="0" style="width: 150px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
          A long product description that runs well past two lines and is deliberately clamped with an ellipsis, exactly like a real product card.
        </div>
      </main>
    `);

    const snapshot = await captureSnapshot(page);
    const clampedLine = snapshot.split("\n").find((line) => line.includes("A long product description"));
    assert.ok(clampedLine, "expected a line for the clamped description");
    assert.doesNotMatch(clampedLine!, /content-overflows/);
  } finally {
    await browser.close();
  }
});

test("page observation flags real page-level horizontal overflow, and only when it's real", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const overflowPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await overflowPage.setContent(`<div style="width: 900px; height: 20px;">Too wide for the viewport</div>`);
    const overflowSnapshot = await captureSnapshot(overflowPage);
    assert.match(overflowSnapshot, /^Layout: the page is wider than its own viewport/);

    const fittedPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await fittedPage.setContent(`<div style="width: 200px; height: 20px;">Fits within the viewport</div>`);
    const fittedSnapshot = await captureSnapshot(fittedPage);
    assert.doesNotMatch(fittedSnapshot, /Layout:/);
    assert.match(fittedSnapshot, /^Accessibility tree:/);
  } finally {
    await browser.close();
  }
});
