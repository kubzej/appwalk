import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionReport, type ReportSafety } from "../src/report/contract.js";
import { renderHtmlReport } from "../src/report/html-report.js";

const safety: ReportSafety = {
  blockedRequests: 2,
  explorationBlocked: 1,
  replayBlocked: 1,
  byMethod: { PATCH: 2 },
  samples: [{ phase: "exploration", method: "PATCH", url: "https://example.test/api/cart" }],
  safetyRelatedRuntimeErrors: 0,
};

function reportInput(overrides: Partial<Parameters<typeof buildExecutionReport>[0]> = {}) {
  return {
    executionId: "execution-1",
    command: "explore" as const,
    url: "https://example.test",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    expectations: [],
    generatedTests: 0,
    artifacts: { reportJson: "report.json", reportHtml: "report.html", discovery: "discovery.json", evidence: "evidence.jsonl" },
    runs: [{
      id: "run-1",
      name: "Noah baseline",
      persona: "noah",
      personaIntent: "journey" as const,
      maxSteps: 25,
      scope: undefined,
      expectations: [],
      flowsFound: 1,
      replayConfirmed: 1,
      generatedTests: 0,
      exhausted: true,
      stopReason: "budget_exhausted" as const,
      safety,
      runtimeErrors: [{
        phase: "exploration" as const,
        kind: "console_error" as const,
        message: "Failed to sync cart",
        occurrences: 1,
      }],
      flows: [],
      findings: [],
      responseVariants: [],
    }],
    ...overrides,
  };
}

test("incomplete and safety-limited coverage is inconclusive", () => {
  const report = buildExecutionReport(reportInput());
  assert.equal(report.exitCode, 3);
  assert.equal(report.summary.coverageIncomplete, true);
  assert.equal(report.summary.safetyBlockedRequests, 2);
  assert.equal(report.summary.runtimeErrors, 1);
  assert.equal("status" in report, false);
  assert.equal("status" in report.runs[0]!, false);
  assert.equal(report.runs[0]?.stopReason, "budget_exhausted");
});

test("HTML report explains incomplete coverage and runtime review", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput()));
  assert.match(html, /Coverage incomplete/);
  assert.match(html, /Safety limited coverage/);
  assert.match(html, /class="r-meta-row"><strong class="r-meta-label">Command:<\/strong>/);
  assert.match(html, /class="r-meta-row"><strong class="r-meta-label">URL:<\/strong>/);
  assert.match(html, /class="r-meta-row"><strong class="r-meta-label">Execution:<\/strong>/);
  assert.doesNotMatch(html, /\.r-card \{[^}]*border:/);
  assert.doesNotMatch(html, /\.r-callout-warning \{[^}]*border:/);
  assert.match(html, /\.r-stat-grid > div \{ background:/);
  assert.match(html, /\.r-stat-grid \.r-stat \{ text-align: center;/);
  const masthead = html.match(/<header class="r-masthead">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.doesNotMatch(masthead, /r-badge/);
  assert.doesNotMatch(html, /Select a flow from the list to see its steps/);
  assert.doesNotMatch(html, /Potential bugs to review/);
  assert.doesNotMatch(html, /Failed to sync cart/);
});

test("a complete replay remains confirmed", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
    }],
  });
  const report = buildExecutionReport(input);
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.coverageIncomplete, false);
});

test("runtime issues do not change a confirmed flow into a potential bug", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
      flows: [{
        id: "run-1-flow-1",
        title: "Manage cart",
        summary: "Updated the cart.",
        origin: "discovered" as const,
        discoveryVerified: true,
        replayConfirmed: true,
        runtimeIssues: [{
          phase: "replay" as const,
          kind: "http_error" as const,
          message: "HTTP 503 response",
          occurrences: 1,
        }],
        steps: [],
      }],
    }],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /class="r-flow-status r-tone-good">Confirmed<\/p>/);
  assert.match(html, /class="r-callout-title">APPLICATION ERROR OBSERVED<\/p>/);
});

test("renders scope without a redundant section title", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput({ scope: "Explore checkout" })));
  assert.doesNotMatch(html, /What was evaluated/);
  assert.match(html, /Scope/);
  assert.match(html, /Explore checkout/);
});

test("renders persona coverage summary as centered stat cards", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      flowsFound: 5,
      replayConfirmed: 1,
      generatedTests: 1,
    }],
  })));
  assert.match(html, /class="r-persona-stat-grid"/);
  assert.match(html, /Flows found/);
  assert.match(html, /Baseline replay confirmed/);
  assert.match(html, /Generated tests/);
  assert.match(html, /\.r-persona-stat-grid \.r-stat \{ text-align: center;/);
  assert.match(html, /<p class="r-stat">5<\/p>/);
});

test("preserves run-level evaluation metadata", () => {
  const report = buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      maxSteps: 80,
      scope: "Explore checkout",
      expectations: ["The order reaches confirmation"],
    }],
  }));
  assert.equal(report.runs[0]?.maxSteps, 80);
  assert.equal(report.runs[0]?.scope, "Explore checkout");
  assert.deepEqual(report.runs[0]?.expectations, ["The order reaches confirmation"]);
  const html = renderHtmlReport(report);
  assert.match(html, /Max steps/);
  assert.match(html, /Explore checkout/);
  assert.match(html, /The order reaches confirmation/);
});

test("safety-related runtime errors are excluded from potential bug review", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { ...safety, safetyRelatedRuntimeErrors: 3 },
      runtimeErrors: [{
        phase: "exploration" as const,
        kind: "request_failed" as const,
        message: "net::ERR_FAILED",
        method: "POST",
        url: "https://example.test/api/cart",
        occurrences: 3,
        safetyRelated: true,
      }],
    }],
  });
  const report = buildExecutionReport(input);
  const html = renderHtmlReport(report);
  assert.equal(report.summary.runtimeErrors, 0);
  assert.doesNotMatch(html, /Potential bug · review/);
  assert.match(html, /excluded from potential bug review/);
});

test("lifecycle request cancellations do not make coverage incomplete", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      replayConfirmed: 1,
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [{
        phase: "replay" as const,
        kind: "request_failed" as const,
        message: "net::ERR_ABORTED",
        occurrences: 1,
        lifecycle: true,
      }],
    }],
  });
  const report = buildExecutionReport(input);
  assert.equal(report.summary.runtimeErrors, 0);
  assert.equal(report.summary.coverageIncomplete, false);
});

test("HTML report explains replay failures and flow-level runtime signals", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [{
        phase: "replay" as const,
        kind: "http_error" as const,
        message: "HTTP 503 response",
        method: "GET",
        url: "https://example.test/orders",
        status: 503,
        occurrences: 1,
      }],
      flows: [{
        id: "run-1-flow-1",
        title: "Review orders",
        summary: "Opened order history.",
        origin: "discovered" as const,
        discoveryVerified: true,
        replayConfirmed: false,
        runtimeIssues: [{
          phase: "replay" as const,
          kind: "http_error" as const,
          message: "HTTP 503 response",
          method: "GET",
          url: "https://example.test/orders",
          status: 503,
          occurrences: 1,
        }],
        replayFailure: {
          reason: "A recorded action could not be completed in the clean replay session.",
          cause: "authentication",
          step: 3,
          action: "click",
          error: "locator.click: Timeout 5000ms exceeded",
          lastUrl: "https://example.test/orders",
          lastSnapshot: "main\nlink Order history",
        },
        steps: [{
          number: 10,
          action: "Click",
          target: 'role=button[name="Sign in"]',
          error: "locator.click: Error: strict mode violation",
          errorLabel: "Exploration action failed",
        }],
      }],
    }],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /Needs review/);
  assert.match(html, /class="r-flow-status r-tone-warning">Needs review<\/p>/);
  assert.match(html, /class="r-badge r-badge-warning">Needs review<\/span>/);
  assert.match(html, /class="r-flow-checks"/);
  assert.match(html, /Discovery<\/p><p class="r-flow-check-value r-tone-good">Verified/);
  assert.match(html, /Replay<\/p><p class="r-flow-check-value">Not confirmed/);
  assert.match(html, /class="r-badge r-badge-warning">Needs review<\/span>/);
  assert.match(html, /<strong>Step:<\/strong> <code>3<\/code>/);
  assert.match(html, /class="r-code-block"><code>locator\.click: Timeout 5000ms exceeded<\/code>/);
  assert.match(html, /HTTP 503 response/);
  assert.match(html, /class="r-callout-title">APPLICATION ERROR OBSERVED<\/p>/);
  assert.match(html, /<strong>Phase:<\/strong> Replay/);
  assert.match(html, /<strong>Request:<\/strong> <code>GET https:\/\/example\.test\/orders<\/code>/);
  assert.match(html, /Likely cause:<\/strong> The replay session was not authenticated/);
  assert.match(html, /not linked to a recorded action/);
  assert.doesNotMatch(html, /Runtime signals during replay/);
  assert.match(html, /Exploration action failed/);

  const confirmedWithIssues = buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [{
        phase: "replay" as const,
        kind: "http_error" as const,
        message: "HTTP 503 response",
        occurrences: 1,
      }],
      flows: [{
        id: "run-1-flow-1",
        title: "Checkout",
        summary: "Completed checkout.",
        origin: "discovered" as const,
        discoveryVerified: true,
        replayConfirmed: true,
        runtimeIssues: [{
          phase: "replay" as const,
          kind: "http_error" as const,
          message: "HTTP 503 response",
          occurrences: 1,
        }],
        steps: [],
      }],
      responseVariants: [{
        flowIndex: 0,
        enabled: true,
        fixturesFound: 8,
        fixtures: [{ method: "GET", url: "https://example.test/api/orders/42", bytes: 120 }],
        planningStatus: "completed" as const,
        plannerCandidates: 0,
        plannerRejected: 0,
        plannerRejectionReasons: [],
        plannerReason: "Planner returned no variant proposals.",
        proposed: 0,
        confirmed: 0,
        confirmedScenarios: [],
        skipped: [],
      }],
    }],
  }));
  const confirmedWithIssuesHtml = renderHtmlReport(confirmedWithIssues);
  assert.match(confirmedWithIssuesHtml, /Potential bug/);
  assert.doesNotMatch(confirmedWithIssuesHtml, /Confirmed with issues/);
  assert.match(confirmedWithIssuesHtml, /Fixtures:<\/strong><span class="r-meta-value">8 captured/);
  assert.match(confirmedWithIssuesHtml, /Planner returned no variant proposals/);
});

test("response variant results have readable sections and diagnostics", () => {
  const input = reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
      flows: [{
        id: "run-1-flow-1",
        title: "Checkout",
        summary: "Completed checkout.",
        origin: "discovered" as const,
        discoveryVerified: true,
        replayConfirmed: true,
        runtimeIssues: [],
        steps: [],
      }],
      responseVariants: [{
        flowIndex: 0,
        enabled: true,
        fixturesFound: 7,
        fixtures: [{ method: "GET", url: "https://example.test/api/orders/42", bytes: 120 }],
        planningStatus: "completed" as const,
        plannerCandidates: 4,
        plannerRejected: 0,
        plannerRejectionReasons: [],
        proposed: 2,
        confirmed: 1,
        confirmedScenarios: ["Shipped order"],
        skipped: [{ name: "Zero quantity", reason: "locator.click: Timeout 5000ms exceeded \uFFFD[2m" }],
      }],
    }],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /Variants:<\/strong><span class="r-meta-value">2 accepted · 1 replay confirmed · 1 skipped/);
  assert.match(html, /Captured fixtures/);
  assert.match(html, /<code class="r-code r-fixture-url">https:\/\/example\.test\/api\/orders\/42<\/code>/);
  assert.match(html, /Replay-confirmed variants/);
  assert.match(html, /Skipped variants/);
  assert.match(html, /Shipped order/);
  assert.match(html, /Zero quantity/);
  assert.match(html, /class="r-code-block r-scenario-code"><code>locator\.click: Timeout 5000ms exceeded<\/code>/);
  assert.doesNotMatch(html, /�\[2m/);
});

test("response variant report surfaces planner rejections as a separate result", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
      flows: [{
        id: "run-1-flow-1",
        title: "Checkout",
        summary: "Completed checkout.",
        origin: "discovered" as const,
        discoveryVerified: true,
        replayConfirmed: true,
        runtimeIssues: [],
        steps: [],
      }],
      responseVariants: [{
        flowIndex: 0,
        enabled: true,
        fixturesFound: 3,
        fixtures: [],
        planningStatus: "completed" as const,
        plannerCandidates: 6,
        plannerRejected: 6,
        plannerRejectionReasons: ["patch did not apply to the captured response"],
        proposed: 0,
        confirmed: 0,
        confirmedScenarios: [],
        skipped: [],
        plannerReason: "All planner proposals were rejected by Appwalk validation.",
      }],
    }],
  })));
  assert.match(html, /Variants:<\/strong><span class="r-meta-value">0 accepted · 6 rejected · 0 replay confirmed · 0 skipped/);
  assert.match(html, /Rejected proposals/);
  assert.match(html, /6 planner proposals<\/strong> rejected by Appwalk validation/);
  assert.match(html, /Reason: patch did not apply to the captured response/);
  assert.doesNotMatch(html, /All planner proposals were rejected by Appwalk validation\.<\/p>/);
});

test("marks similar baseline flows in navigation without changing their titles", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
      flows: [
        {
          id: "run-1-flow-1",
          title: "Complete checkout",
          summary: "Completed checkout.",
          origin: "discovered" as const,
          discoveryVerified: true,
          replayConfirmed: true,
          runtimeIssues: [],
          steps: [],
        },
        {
          id: "run-1-flow-2",
          title: "Complete checkout",
          summary: "Completed checkout again.",
          origin: "discovered" as const,
          similarTo: "run-1-flow-1",
          discoveryVerified: true,
          replayConfirmed: true,
          runtimeIssues: [],
          steps: [],
        },
      ],
    }],
  })));
  assert.match(html, /class="r-flow-secondary">Similar to Flow 1<\/span>/);
});

test("keeps response variants under their baseline flow in navigation and panels", () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput({
    runs: [{
      ...reportInput().runs[0]!,
      exhausted: false,
      stopReason: "completed",
      safety: { blockedRequests: 0, explorationBlocked: 0, replayBlocked: 0, byMethod: {}, samples: [], safetyRelatedRuntimeErrors: 0 },
      runtimeErrors: [],
      flows: [
        {
          id: "run-1-flow-1",
          title: "Checkout",
          summary: "Completed checkout.",
          origin: "discovered" as const,
          discoveryVerified: true,
          replayConfirmed: true,
          runtimeIssues: [],
          steps: [],
        },
        {
          id: "scenario-1",
          parentFlowId: "run-1-flow-1",
          title: "Checkout — Cancelled order",
          summary: "Checkout with a cancelled order.",
          origin: "derived" as const,
          discoveryVerified: true,
          replayConfirmed: true,
          runtimeIssues: [],
          steps: [],
        },
      ],
      responseVariants: [],
    }],
  })));
  assert.match(html, /class="r-index-variants"/);
  assert.match(html, /class="r-variant-group-label">Variants<\/span>/);
  assert.match(html, /class="r-variant-label">Variant<\/span>/);
  assert.ok(html.indexOf("Checkout") < html.indexOf("Checkout — Cancelled order"));
  assert.ok(html.indexOf("panel-flow-0-0") < html.indexOf("panel-flow-0-1"));
});
