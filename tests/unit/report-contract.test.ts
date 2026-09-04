import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExecutionReport, type ReportSafety } from '../../src/report/contract.js';
import { renderHtmlReport } from '../../src/report/html-report.js';

const safety: ReportSafety = {
  blockedRequests: 2,
  explorationBlocked: 1,
  replayBlocked: 1,
  byMethod: { PATCH: 2 },
  samples: [{ phase: 'exploration', method: 'PATCH', url: 'https://example.test/api/cart' }],
  safetyRelatedRuntimeErrors: 0,
};

function reportInput(overrides: Partial<Parameters<typeof buildExecutionReport>[0]> = {}) {
  return {
    executionId: 'execution-1',
    command: 'explore' as const,
    url: 'https://example.test',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    expectations: [],
    generatedTests: 0,
    artifacts: {
      reportJson: 'report.json',
      reportHtml: 'report.html',
      discovery: 'discovery.json',
      evidence: 'evidence.jsonl',
    },
    runs: [
      {
        id: 'run-1',
        name: 'Noah baseline',
        persona: 'noah',
        personaIntent: 'journey' as const,
        maxSteps: 25,
        scope: undefined,
        expectations: [],
        flowsFound: 1,
        replayConfirmed: 1,
        generatedTests: 0,
        exhausted: true,
        stopReason: 'budget_exhausted' as const,
        safety,
        runtimeErrors: [
          {
            phase: 'exploration' as const,
            kind: 'console_error' as const,
            message: 'Failed to sync cart',
            occurrences: 1,
          },
        ],
        flows: [],
        findings: [],
        responseVariants: [],
      },
    ],
    ...overrides,
  };
}

test('incomplete and safety-limited coverage is inconclusive', () => {
  const report = buildExecutionReport(reportInput());
  assert.equal(report.exitCode, 3);
  assert.equal(report.summary.coverageIncomplete, true);
  assert.equal(report.summary.safetyBlockedRequests, 2);
  assert.equal(report.summary.runtimeErrors, 1);
  assert.equal('status' in report, false);
  assert.equal('status' in report.runs[0]!, false);
  assert.equal(report.runs[0]?.stopReason, 'budget_exhausted');
});

test('report.html surfaces the inconclusive outcome and persona identity', () => {
  const html = renderHtmlReport(buildExecutionReport(reportInput()));
  assert.match(html, /inconclusive — coverage incomplete or nothing replay-confirmed/);
  assert.match(html, /<span class="case-name">noah<\/span>/);
  assert.match(html, /<span class="intent journey">journey<\/span>/);
  assert.match(html, /class="mono">explore<\/span>|class="chip muted">explore<\/span>/);
  assert.match(html, /https:\/\/example\.test/);
  assert.match(html, /execution-1/);
  // Diagnostic noise (the raw runtime error message) never leaks into the report body
  // unless it belongs to a flow's own runtimeIssues — this run has no flows at all.
  assert.doesNotMatch(html, /Failed to sync cart/);
});

test('a complete replay remains confirmed', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [],
      },
    ],
  });
  const report = buildExecutionReport(input);
  assert.equal(report.exitCode, 0);
  assert.equal(report.summary.coverageIncomplete, false);
});

test('runtime issues on a flow do not change its replay-confirmed status', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [],
        flows: [
          {
            id: 'run-1-flow-1',
            title: 'Manage cart',
            summary: 'Updated the cart.',
            origin: 'discovered' as const,
            discoveryVerified: true,
            replayConfirmed: true,
            runtimeIssues: [
              {
                phase: 'replay' as const,
                kind: 'http_error' as const,
                message: 'HTTP 503 response',
                method: 'GET',
                url: 'https://example.test/api/cart',
                status: 503,
                occurrences: 1,
              },
            ],
            steps: [],
          },
        ],
      },
    ],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(
    html,
    /<h3>Manage cart<\/h3><span class="chip-group"><span class="chip success">replay confirmed<\/span>/,
  );
  // The request line (method + status + url) already carries the status — the message field's
  // fixed "HTTP <status> response" template must not be repeated on top of it.
  assert.match(html, /<strong>HTTP error<\/strong> <span class="mono">GET 503 https:\/\/example\.test\/api\/cart<\/span>/);
  assert.doesNotMatch(html, /HTTP 503 response/);
});

test('renders scope and expectations for a run', () => {
  const html = renderHtmlReport(
    buildExecutionReport(
      reportInput({
        runs: [{ ...reportInput().runs[0]!, scope: 'Explore checkout' }],
      }),
    ),
  );
  assert.match(html, /<span class="eyebrow">Scope<\/span>Explore checkout/);
});

test('renders run-level metadata (max steps, scope, expectations)', () => {
  const report = buildExecutionReport(
    reportInput({
      runs: [
        {
          ...reportInput().runs[0]!,
          maxSteps: 80,
          scope: 'Explore checkout',
          expectations: ['The order reaches confirmation'],
        },
      ],
    }),
  );
  assert.equal(report.runs[0]?.maxSteps, 80);
  assert.equal(report.runs[0]?.scope, 'Explore checkout');
  assert.deepEqual(report.runs[0]?.expectations, ['The order reaches confirmation']);
  const html = renderHtmlReport(report);
  assert.match(html, /Explore checkout/);
  assert.match(html, /The order reaches confirmation/);
});

test('safety-related runtime errors are excluded from the runtime error count', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        safety: { ...safety, safetyRelatedRuntimeErrors: 3 },
        runtimeErrors: [
          {
            phase: 'exploration' as const,
            kind: 'request_failed' as const,
            message: 'net::ERR_FAILED',
            method: 'POST',
            url: 'https://example.test/api/cart',
            occurrences: 3,
            safetyRelated: true,
          },
        ],
      },
    ],
  });
  const report = buildExecutionReport(input);
  assert.equal(report.summary.runtimeErrors, 0);
});

test('lifecycle request cancellations do not make coverage incomplete', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        replayConfirmed: 1,
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [
          {
            phase: 'replay' as const,
            kind: 'request_failed' as const,
            message: 'net::ERR_ABORTED',
            occurrences: 1,
            lifecycle: true,
          },
        ],
      },
    ],
  });
  const report = buildExecutionReport(input);
  assert.equal(report.summary.runtimeErrors, 0);
  assert.equal(report.summary.coverageIncomplete, false);
});

test('report.html explains a replay failure with its summarized reason, not the raw call log', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [
          {
            phase: 'replay' as const,
            kind: 'http_error' as const,
            message: 'HTTP 503 response',
            method: 'GET',
            url: 'https://example.test/orders',
            status: 503,
            occurrences: 1,
          },
        ],
        flows: [
          {
            id: 'run-1-flow-1',
            title: 'Review orders',
            summary: 'Opened order history.',
            origin: 'discovered' as const,
            discoveryVerified: true,
            replayConfirmed: false,
            runtimeIssues: [
              {
                phase: 'replay' as const,
                kind: 'http_error' as const,
                message: 'HTTP 503 response',
                method: 'GET',
                url: 'https://example.test/orders',
                status: 503,
                occurrences: 1,
              },
            ],
            replayFailure: {
              reason:
                'A recorded action could not be completed in the clean replay session.\nCall log:\n  - waiting for locator("role=button")',
              cause: 'authentication',
              step: 3,
              action: 'click',
              error: 'locator.click: Timeout 5000ms exceeded',
              lastUrl: 'https://example.test/orders',
              lastSnapshot: 'main\nlink Order history',
            },
            steps: [
              {
                number: 10,
                action: 'click',
                target: 'role=button[name="Sign in"]',
                error: 'locator.click: Error: strict mode violation',
                errorLabel: 'Exploration action failed',
              },
            ],
          },
        ],
      },
    ],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /<span class="chip warning">not confirmed<\/span>/);
  assert.match(html, /A recorded action could not be completed in the clean replay session\./);
  assert.doesNotMatch(html, /Call log:/);
  assert.match(html, /Exploration action failed: locator\.click: Error: strict mode violation/);
  assert.match(html, /<strong>HTTP error<\/strong>.*GET 503 https:\/\/example\.test\/orders/);
});

test('a confirmed finding renders as a critical flow status with its summary', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        persona: 'della',
        personaIntent: 'challenge' as const,
        exhausted: false,
        stopReason: 'completed',
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [],
        flows: [
          {
            id: 'run-1-flow-1',
            title: 'Double submit order',
            summary: 'Submitted the same order twice.',
            origin: 'discovered' as const,
            discoveryVerified: true,
            replayConfirmed: true,
            runtimeIssues: [],
            steps: [],
            finding: {
              status: 'confirmed' as const,
              summary: 'Duplicate order accepted',
              failure: 'Two identical orders were created from one submission.',
            },
          },
        ],
      },
    ],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /<span class="intent challenge">challenge<\/span>/);
  assert.match(html, /<span class="chip critical">finding confirmed<\/span>/);
  assert.match(html, /Two identical orders were created from one submission\./);
});

test('response variant planning surfaces fixtures, confirmed scenarios, and skip reasons', () => {
  const input = reportInput({
    runs: [
      {
        ...reportInput().runs[0]!,
        exhausted: false,
        stopReason: 'completed',
        safety: {
          blockedRequests: 0,
          explorationBlocked: 0,
          replayBlocked: 0,
          byMethod: {},
          samples: [],
          safetyRelatedRuntimeErrors: 0,
        },
        runtimeErrors: [],
        flows: [
          {
            id: 'run-1-flow-1',
            title: 'Checkout',
            summary: 'Completed checkout.',
            origin: 'discovered' as const,
            discoveryVerified: true,
            replayConfirmed: true,
            runtimeIssues: [],
            steps: [],
          },
        ],
        responseVariants: [
          {
            flowIndex: 0,
            enabled: true,
            fixturesFound: 7,
            fixtures: [{ method: 'GET', url: 'https://example.test/api/orders/42', bytes: 120 }],
            planningStatus: 'completed' as const,
            plannerCandidates: 4,
            plannerRejected: 0,
            plannerRejectionReasons: [],
            proposed: 2,
            confirmed: 1,
            confirmedScenarios: ['Shipped order'],
            skipped: [
              { name: 'Zero quantity', reason: 'locator.click: Timeout 5000ms exceeded\nCall log:\n  - waiting' },
            ],
          },
        ],
      },
    ],
  });
  const html = renderHtmlReport(buildExecutionReport(input));
  assert.match(html, /Response scenarios · planning completed/);
  assert.match(html, /7 fixtures captured/);
  assert.match(html, /2 proposed/);
  assert.match(html, /1 confirmed/);
  assert.match(html, /<strong>Zero quantity<\/strong> skipped — locator\.click: Timeout 5000ms exceeded/);
  assert.doesNotMatch(html, /Call log:/);
});

test('response variant report surfaces planner rejections with their reasons', () => {
  const html = renderHtmlReport(
    buildExecutionReport(
      reportInput({
        runs: [
          {
            ...reportInput().runs[0]!,
            exhausted: false,
            stopReason: 'completed',
            safety: {
              blockedRequests: 0,
              explorationBlocked: 0,
              replayBlocked: 0,
              byMethod: {},
              samples: [],
              safetyRelatedRuntimeErrors: 0,
            },
            runtimeErrors: [],
            flows: [
              {
                id: 'run-1-flow-1',
                title: 'Checkout',
                summary: 'Completed checkout.',
                origin: 'discovered' as const,
                discoveryVerified: true,
                replayConfirmed: true,
                runtimeIssues: [],
                steps: [],
              },
            ],
            responseVariants: [
              {
                flowIndex: 0,
                enabled: true,
                fixturesFound: 3,
                fixtures: [],
                planningStatus: 'completed' as const,
                plannerCandidates: 6,
                plannerRejected: 6,
                plannerRejectionReasons: ['patch did not apply to the captured response'],
                proposed: 0,
                confirmed: 0,
                confirmedScenarios: [],
                skipped: [],
                plannerReason: 'All planner proposals were rejected by Appwalk validation.',
              },
            ],
          },
        ],
      }),
    ),
  );
  assert.match(html, /6 rejected/);
  assert.match(html, /Rejected: patch did not apply to the captured response/);
  assert.match(html, /All planner proposals were rejected by Appwalk validation\./);
});

test('marks a similar baseline flow without changing its own title', () => {
  const html = renderHtmlReport(
    buildExecutionReport(
      reportInput({
        runs: [
          {
            ...reportInput().runs[0]!,
            exhausted: false,
            stopReason: 'completed',
            safety: {
              blockedRequests: 0,
              explorationBlocked: 0,
              replayBlocked: 0,
              byMethod: {},
              samples: [],
              safetyRelatedRuntimeErrors: 0,
            },
            runtimeErrors: [],
            flows: [
              {
                id: 'run-1-flow-1',
                title: 'Complete checkout',
                summary: 'Completed checkout.',
                origin: 'discovered' as const,
                discoveryVerified: true,
                replayConfirmed: true,
                runtimeIssues: [],
                steps: [],
              },
              {
                id: 'run-1-flow-2',
                title: 'Complete checkout',
                summary: 'Completed checkout again.',
                origin: 'discovered' as const,
                similarTo: 'run-1-flow-1',
                discoveryVerified: true,
                replayConfirmed: true,
                runtimeIssues: [],
                steps: [],
              },
            ],
          },
        ],
      }),
    ),
  );
  assert.match(html, /<span class="chip muted">similar to Flow 1<\/span>/);
  const titleCount = html.match(/<h3>Complete checkout<\/h3>/g)?.length ?? 0;
  assert.equal(titleCount, 2);
});

test('keeps a confirmed response scenario nested under its baseline flow', () => {
  const html = renderHtmlReport(
    buildExecutionReport(
      reportInput({
        runs: [
          {
            ...reportInput().runs[0]!,
            exhausted: false,
            stopReason: 'completed',
            safety: {
              blockedRequests: 0,
              explorationBlocked: 0,
              replayBlocked: 0,
              byMethod: {},
              samples: [],
              safetyRelatedRuntimeErrors: 0,
            },
            runtimeErrors: [],
            flows: [
              {
                id: 'run-1-flow-1',
                title: 'Checkout',
                summary: 'Completed checkout.',
                origin: 'discovered' as const,
                discoveryVerified: true,
                replayConfirmed: true,
                runtimeIssues: [],
                steps: [],
              },
              {
                id: 'scenario-1',
                parentFlowId: 'run-1-flow-1',
                title: 'Checkout — Cancelled order',
                summary: 'Checkout with a cancelled order.',
                origin: 'derived' as const,
                discoveryVerified: true,
                replayConfirmed: true,
                runtimeIssues: [],
                steps: [],
              },
            ],
            responseVariants: [],
          },
        ],
      }),
    ),
  );
  assert.match(html, /<span class="eyebrow">Response scenarios confirmed \(1\)<\/span>/);
  assert.ok(html.indexOf('<h3>Checkout</h3>') < html.indexOf('<h3>Checkout — Cancelled order</h3>'));
  assert.match(
    html,
    /<div class="variants">[\s\S]*Checkout — Cancelled order[\s\S]*<span class="chip muted">derived scenario<\/span>/,
  );
});
