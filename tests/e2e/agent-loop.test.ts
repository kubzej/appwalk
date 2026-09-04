import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { buildSystemPrompt, runAgentLoop } from '../../src/agent/loop.js';
import { captureSnapshot } from '../../src/browser/snapshot.js';
import { attachPopupDetection } from '../../src/cli/orchestrate.js';
import type { TabRegistryHandle } from '../../src/agent/tools.js';
import { Logger } from '../../src/logging/logger.js';
import { Redactor } from '../../src/security/redaction.js';
import type { LlmProvider, ProviderTurn, ToolDefinition, ToolResult } from '../../src/providers/provider.js';

class TextOnlyProvider implements LlmProvider {
  async start(_params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
  }): Promise<ProviderTurn> {
    return { type: 'text', text: 'I found a page, but did not complete a flow.' };
  }

  async continue(_toolResult: ToolResult): Promise<ProviderTurn> {
    return { type: 'text', text: 'stop' };
  }
}

/** Plays back a fixed sequence of turns, ignoring whatever the loop passes in — for tests that need
 * exact, predetermined tool calls rather than a text-generation model's actual reasoning. */
class ScriptedProvider implements LlmProvider {
  constructor(private readonly turns: ProviderTurn[]) {}
  async start(): Promise<ProviderTurn> {
    return this.turns.shift()!;
  }
  async continue(): Promise<ProviderTurn> {
    return this.turns.shift()!;
  }
}

test('stops on plain provider text without inventing a flow', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><h1>Example</h1></main>');
    const result = await runAgentLoop(page, new TextOnlyProvider(), { maxSteps: 5 });
    assert.equal(result.flows.length, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0]?.finalText, 'I found a page, but did not complete a flow.');
    assert.equal(result.exhausted, false);
    assert.equal(result.stopReason, 'agent_stopped');
  } finally {
    await browser.close();
  }
});

test('charges every burst repetition against the agent action budget', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<button id="target" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">Submit</button>`,
    );
    const provider = new ScriptedProvider([
      {
        type: 'tool_call',
        toolCall: { id: '1', name: 'burst', input: { action: 'click', locator: '#target', count: 3 } },
      },
      { type: 'tool_call', toolCall: { id: '2', name: 'flowComplete', input: { summary: 'Rapid submit' } } },
    ]);

    const result = await runAgentLoop(page, provider, { maxSteps: 3 });

    assert.equal(await page.locator('#target').getAttribute('data-clicks'), '3');
    assert.equal(result.flows.length, 1);
    assert.equal(result.history.length, 2, 'the completed flow must not start another flow with leftover burst budget');
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.exhausted, false);
  } finally {
    await browser.close();
  }
});

test('a popup discovered mid-flow is reachable via switchTab inside the real agent loop', async () => {
  // A target="_blank" link to a data: URI never actually opens (Chromium blocks top-level
  // navigation to data: URLs), so this needs a real same-origin destination to pop up at all.
  const server = createServer((req, res) => {
    if (req.url === '/popped') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>popped</h1>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a id="opener" href="/popped" target="_blank">open</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // Wired the same way orchestrate.ts wires it in production: attached before the loop starts,
    // and handed to runAgentLoop so a popup registered while flow N's registry is current lands in
    // that same registry, not a stale one.
    const tabRegistryHandle: TabRegistryHandle = { tabs: new Map() };
    attachPopupDetection(page, new Logger('quiet'), tabRegistryHandle);

    const provider = new ScriptedProvider([
      { type: 'tool_call', toolCall: { id: '1', name: 'click', input: { locator: '#opener' } } },
      { type: 'tool_call', toolCall: { id: '2', name: 'switchTab', input: { tabId: 'tab-1' } } },
      {
        type: 'tool_call',
        toolCall: { id: '3', name: 'flowComplete', input: { summary: 'Reached the popup via switchTab.' } },
      },
    ]);

    // maxSteps matches the two real actions exactly, so the loop returns right after flowComplete
    // instead of starting a second flow context that would need a fourth scripted turn.
    const result = await runAgentLoop(page, provider, { maxSteps: 2, tabRegistryHandle });

    // The model has no way to see attachPopupDetection's own logging (that's CLI output for a
    // human) — the click step's own result text is the only channel it actually reads, so the new
    // tab id must be named there, not just mechanically registered in the background.
    const clickStep = result.history[0];
    assert.match(clickStep!.result!.snapshot, /new tab opened on its own.*tab-1/is);

    const switchStep = result.history[1];
    assert.equal(switchStep?.toolCall?.name, 'switchTab');
    assert.equal(switchStep?.error, undefined, "switchTab must not fail to find the popup's tab id");
    assert.match(switchStep!.result!.snapshot, /popped/);
    assert.equal(result.flows.length, 1);

    // switchTab (like openTab/openInNewTab/reopenBrowser) returns a raw Playwright Page under
    // `activePage` so the loop can retarget itself — it must never survive into the step's
    // persisted result. A raw Page has circular internal references, and both this history entry
    // and the evidence log run it through Redactor.redact(), which used to recurse into whatever
    // it was given with no cycle guard — leaking a live Page here crashed the whole run with
    // "Maximum call stack size exceeded" (see FINDINGS-round2.md point 4).
    assert.ok(!('activePage' in switchStep!.result!), 'a step result must never carry the raw Page it switched to');
    assert.doesNotThrow(() => new Redactor().redact(result.history));
  } finally {
    await browser.close();
    server.close();
  }
});

test('grounds expectations in behavior performed by the current flow', () => {
  const prompt = buildSystemPrompt(20, false, undefined, 'Checkout', ['A completed order reaches confirmation']);
  assert.match(prompt, /current flow itself/);
  assert.match(prompt, /read-only flow that opens an existing record/);
  assert.match(prompt, /Do not verify an expectation just because the page contains similar text/);
});

test('page observation supplements accessibility tree with stable DOM hints', async () => {
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

test('page observation flags an element whose content overflows its own box', async () => {
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
    const fitsLine = snapshot.split('\n').find((line) => line.includes('"Fits fine"'));
    assert.ok(fitsLine, 'expected a line for the #fits button');
    assert.doesNotMatch(fitsLine!, /content-overflows/);
  } finally {
    await browser.close();
  }
});

test('page observation does not flag a deliberately line-clamped description as overflowing', async () => {
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
    const clampedLine = snapshot.split('\n').find((line) => line.includes('A long product description'));
    assert.ok(clampedLine, 'expected a line for the clamped description');
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
