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
