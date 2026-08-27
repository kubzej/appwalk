import assert from "node:assert/strict";
import test from "node:test";
import { applyResponseVariant, extractResponseFixtures, parseResponseVariants, parseResponseVariantsDetailed } from "../src/response/variants.js";
import type { EvidenceEntry } from "../src/evidence/log.js";

const applicationUrl = "https://example.test";
const apiUrl = `${applicationUrl}/api/orders/42`;

function evidence(): EvidenceEntry[] {
  return [
    {
      index: 0,
      flowIndex: 0,
      timestamp: new Date(0).toISOString(),
      network: [
        { method: "GET", url: apiUrl, status: 200, body: { status: "pending", total: 10 } },
        { method: "GET", url: apiUrl, status: 200, body: { status: "shipped", total: 10 } },
      ],
      console: [],
    },
  ];
}

test("keeps repeated responses and assigns occurrences", () => {
  const fixtures = extractResponseFixtures(evidence(), applicationUrl);
  assert.equal(fixtures.length, 2);
  assert.deepEqual(fixtures.map((fixture) => fixture.occurrence), [1, 2]);
  assert.equal(fixtures[0]?.urlPattern, `${applicationUrl}/api/orders/*`);
});

test("applies a variant to the selected response occurrence", () => {
  const fixtures = extractResponseFixtures(evidence(), applicationUrl);
  const variants = parseResponseVariants(
    JSON.stringify([
      {
        name: "Second response is cancelled",
        sourceMethod: "GET",
        sourceUrl: apiUrl,
        sourceOccurrence: 2,
        patches: [{ path: "$.status", value: "cancelled" }],
        expectation: { assertion: "containsText", locator: "text=Cancelled", value: "Cancelled" },
      },
    ]),
    fixtures,
  );

  assert.equal(variants.length, 1);
  const changed = applyResponseVariant(fixtures, variants[0]!);
  assert.equal(changed?.[0]?.body && (changed[0].body as { status: string }).status, "pending");
  assert.equal(changed?.[1]?.body && (changed[1].body as { status: string }).status, "cancelled");
});

test("does not silently choose an ambiguous response", () => {
  const fixtures = extractResponseFixtures(evidence(), applicationUrl);
  const variants = parseResponseVariants(
    JSON.stringify([
      {
        name: "Ambiguous response",
        sourceUrl: apiUrl,
        patches: [{ path: "$.status", value: "cancelled" }],
        expectation: { assertion: "urlContains", value: "/orders/42" },
      },
    ]),
    fixtures,
  );
  assert.equal(variants.length, 0);
});

test("explains when the planner returns no proposals", () => {
  const fixtures = extractResponseFixtures(evidence(), applicationUrl);
  const result = parseResponseVariantsDetailed(JSON.stringify({
    variants: [],
    reason: "No observable alternate order state was available.",
  }), fixtures, 5);
  assert.deepEqual(result.variants, []);
  assert.equal(result.candidates, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.plannerReason, "No observable alternate order state was available.");
  assert.equal(result.reason, "Planner returned no variant proposals: No observable alternate order state was available.");
});

test("explains proposals rejected by validation", () => {
  const fixtures = extractResponseFixtures(evidence(), applicationUrl);
  const result = parseResponseVariantsDetailed(JSON.stringify([{
    name: "Invalid patch",
    sourceMethod: "GET",
    sourceUrl: apiUrl,
    sourceOccurrence: 1,
    patches: [{ path: "$.missing", value: "cancelled" }],
    expectation: { assertion: "urlContains", value: "/orders/42" },
  }]), fixtures, 5);
  assert.deepEqual(result.variants, []);
  assert.equal(result.candidates, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.reason, "All planner proposals were rejected by Appwalk validation.");
  assert.deepEqual(result.rejectionReasons, ["patch did not apply to the captured response"]);
});
