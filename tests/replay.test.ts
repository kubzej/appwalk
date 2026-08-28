import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { installResponseFixtures, type ResponseFixture, type ResponseVariant } from "../src/response/variants.js";
import { EvidenceRecorder } from "../src/evidence/recorder.js";
import { replay } from "../src/verify/replay.js";
import type { ToolCall } from "../src/providers/provider.js";

const startUrl = "https://example.test/start";
const sourceUrl = "https://example.test/api/state";

async function runVariantReplay(fetchOnClick: boolean) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route(startUrl, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><button aria-label="Load state">Load</button><div role="status">${fetchOnClick ? "Original" : "Changed"}</div><script>
      document.querySelector('button').addEventListener('click', async () => {
        ${fetchOnClick ? "const response = await fetch('/api/state'); const body = await response.json(); document.querySelector('[role=status]').textContent = body.status;" : ""}
      });
    </script>`,
  }));
  const fixture: ResponseFixture = {
    method: "GET",
    url: sourceUrl,
    occurrence: 1,
    status: 200,
    body: { status: "Original" },
  };
  const variant: ResponseVariant = {
    name: "Changed state",
    sourceMethod: "GET",
    sourceUrl,
    sourceOccurrence: 1,
    patches: [{ path: "$.status", value: "Changed" }],
    expectation: { assertion: "containsText", locator: "role=status", value: "Changed" },
  };
  const variantFixtures = [{ ...fixture, body: { status: "Changed" } }];
  let sourceMatched = false;
  await installResponseFixtures(page, variantFixtures, {
    onFixtureApplied: (applied) => {
      if (applied.url === variant.sourceUrl && applied.method === variant.sourceMethod && applied.occurrence === variant.sourceOccurrence) {
        sourceMatched = true;
      }
    },
  });
  await page.goto(startUrl);
  const recorder = new EvidenceRecorder(page.context());
  const actions: ToolCall[] = [{ id: "click", name: "click", input: { locator: "role=button[name=\"Load state\"]" } }];
  const result = await replay(
    page,
    actions,
    "preservation",
    recorder,
    [],
    variant.expectation,
    undefined,
    undefined,
    { selector: { method: variant.sourceMethod, url: variant.sourceUrl, occurrence: variant.sourceOccurrence }, isMatched: () => sourceMatched },
  );
  await browser.close();
  return result;
}

test("does not confirm a response variant when the source response was never applied", async () => {
  const result = await runVariantReplay(false);
  assert.equal(result.variantSourceMatched, false);
  assert.equal(result.variantExpectationResult, undefined);
  assert.equal(result.reproduced, false);
});

test("confirms a response variant only after its source response was applied", async () => {
  const result = await runVariantReplay(true);
  assert.equal(result.variantSourceMatched, true);
  assert.equal(result.variantExpectationResult?.expectation?.status, "met");
  assert.equal(result.variantExpectationStep, 0);
  assert.equal(result.reproduced, true);
});
