import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { runAgentLoop } from "../src/agent/loop.js";
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
  } finally {
    await browser.close();
  }
});
