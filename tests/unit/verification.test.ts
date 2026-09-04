import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyFlow, type VerificationContext } from '../../src/agent/verification.js';

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    flowStartUrl: 'https://example.test/form',
    flowStartSnapshot: '- heading: Form',
    finalUrl: 'https://example.test/form',
    finalSnapshot: '- heading: Form',
    network: [],
    ...overrides,
  };
}

test('completion ignores a pre-existing success signal', () => {
  assert.equal(
    verifyFlow(
      'completion',
      context({
        flowStartUrl: 'https://example.test/success',
        finalUrl: 'https://example.test/success',
        flowStartSnapshot: '- heading: Thank you for your order',
        finalSnapshot: '- heading: Thank you for your order',
      }),
    ),
    false,
  );
});

test('completion accepts a new success result', () => {
  assert.equal(
    verifyFlow(
      'completion',
      context({
        finalSnapshot: '- heading: Thank you for your order',
        network: [{ method: 'POST', url: 'https://example.test/api/orders', status: 201 }],
      }),
    ),
    true,
  );
});

test('completion does not treat an unrelated state-changing request as success', () => {
  assert.equal(
    verifyFlow(
      'completion',
      context({
        finalSnapshot: '- heading: Form\n- status: Draft saved locally',
        network: [{ method: 'POST', url: 'https://example.test/api/telemetry', status: 204 }],
      }),
    ),
    false,
  );
});

test('recovery recognizes a transport failure without an HTTP status', () => {
  assert.equal(
    verifyFlow(
      'recovery',
      context({
        finalSnapshot: '- heading: Successfully completed',
        runtimeErrors: [
          {
            kind: 'request_failed',
            message: 'net::ERR_INTERNET_DISCONNECTED',
            method: 'POST',
            url: 'https://example.test/api/save',
          },
        ],
      }),
    ),
    true,
  );
});

test('recovery ignores lifecycle cancellation as a transport failure', () => {
  assert.equal(
    verifyFlow(
      'recovery',
      context({
        finalSnapshot: '- heading: Successfully completed',
        runtimeErrors: [
          {
            kind: 'request_failed',
            message: 'net::ERR_ABORTED',
            method: 'GET',
            url: 'https://example.test/form',
            lifecycle: true,
          },
        ],
      }),
    ),
    false,
  );
});

test('rejection ignores an alert that existed before the flow', () => {
  assert.equal(
    verifyFlow(
      'rejection',
      context({
        flowStartSnapshot: '- alert: Invalid email\n- heading: Sign in',
        finalSnapshot: '- alert: Invalid email\n- heading: Sign in\n- paragraph: Try again',
      }),
    ),
    false,
  );
});

test('removal requires an explicit observed expectation', () => {
  const changedPage = context({
    finalUrl: 'https://example.test/items',
    finalSnapshot: '- heading: Items',
  });
  assert.equal(verifyFlow('removal', changedPage), false);
  assert.equal(
    verifyFlow('removal', {
      ...changedPage,
      expectations: [
        {
          expectationIndex: 1,
          status: 'met',
          assertion: 'count',
          locator: 'role=listitem',
          expectedCount: 0,
          detail: 'The removed item is no longer listed.',
        },
      ],
    }),
    true,
  );
});

test('rejection does not treat a met expectation confirming the success signal as rejection evidence', () => {
  // The exact shape of the bug: the agent checked that a success heading is visible — which is
  // true, and mechanically "met" — but that confirms the opposite of rejection, not rejection.
  const acceptedHostileInput = context({
    finalUrl: 'https://example.test/orders/42',
    expectations: [
      {
        expectationIndex: 1,
        status: 'met',
        assertion: 'visible',
        locator: 'role=heading[name="Order Confirmed!"]',
        detail: 'Locator role=heading[name="Order Confirmed!"] is visible.',
      },
    ],
  });
  assert.equal(verifyFlow('rejection', acceptedHostileInput), false);
});

test('rejection treats a met expectation confirming the success signal is absent as real rejection evidence', () => {
  const trulyRejected = context({
    expectations: [
      {
        expectationIndex: 1,
        status: 'met',
        assertion: 'hidden',
        locator: 'role=heading[name="Order Confirmed!"]',
        detail: 'Locator role=heading[name="Order Confirmed!"] is not visible.',
      },
    ],
  });
  assert.equal(verifyFlow('rejection', trulyRejected), true);
});

test('rejection still accepts a met expectation confirming an explicit error signal', () => {
  const explicitError = context({
    expectations: [
      {
        expectationIndex: 1,
        status: 'met',
        assertion: 'containsText',
        locator: 'role=alert',
        value: 'First name is required',
        detail: 'Locator role=alert contains the expected text.',
      },
    ],
  });
  assert.equal(verifyFlow('rejection', explicitError), true);
});

test('removal does not treat a met expectation confirming the success signal as removal evidence', () => {
  const looksRemovedButActuallySucceeded = context({
    expectations: [
      {
        expectationIndex: 1,
        status: 'met',
        assertion: 'visible',
        locator: 'role=heading[name="Order Confirmed!"]',
        detail: 'Locator role=heading[name="Order Confirmed!"] is visible.',
      },
    ],
  });
  assert.equal(verifyFlow('removal', looksRemovedButActuallySucceeded), false);
});

test('completion still accepts a met expectation confirming the success signal is present', () => {
  const confirmedSuccess = context({
    expectations: [
      {
        expectationIndex: 1,
        status: 'met',
        assertion: 'visible',
        locator: 'role=heading[name="Order Confirmed!"]',
        detail: 'Locator role=heading[name="Order Confirmed!"] is visible.',
      },
    ],
  });
  assert.equal(verifyFlow('completion', confirmedSuccess), true);
});

test('consistency and visual do not fall back to completion', () => {
  const successfulPage = context({
    finalUrl: 'https://example.test/success',
    finalSnapshot: '- heading: Successfully completed',
    network: [{ method: 'POST', url: 'https://example.test/api/save', status: 200 }],
  });
  assert.equal(verifyFlow('consistency', successfulPage), false);
  assert.equal(verifyFlow('visual', successfulPage), false);
  assert.equal(
    verifyFlow('visual', {
      ...successfulPage,
      expectations: [
        {
          expectationIndex: 1,
          status: 'met',
          assertion: 'visible',
          locator: 'role=status',
          detail: 'The result is visible.',
        },
      ],
    }),
    true,
  );
});

test('visual accepts a new layout signal observed after the flow started', () => {
  const layoutSignal =
    'Layout: the page is wider than its own viewport (unexpected horizontal scroll).\nAccessibility tree:';
  assert.equal(
    verifyFlow(
      'visual',
      context({
        finalSnapshot: layoutSignal,
        snapshots: [layoutSignal],
      }),
    ),
    true,
  );
});

test('visual ignores a layout signal that already existed before the flow', () => {
  const layoutSignal =
    'Layout: the page is wider than its own viewport (unexpected horizontal scroll).\nAccessibility tree:';
  assert.equal(
    verifyFlow(
      'visual',
      context({
        flowStartSnapshot: layoutSignal,
        finalSnapshot: layoutSignal,
        snapshots: [layoutSignal],
      }),
    ),
    false,
  );
});

test('consistency requires a value or state assertion', () => {
  const visibleExpectation = {
    expectationIndex: 1,
    status: 'met' as const,
    assertion: 'visible' as const,
    locator: 'role=status',
    detail: 'The dependent status is visible.',
  };
  assert.equal(verifyFlow('consistency', context({ expectations: [visibleExpectation] })), false);
  assert.equal(
    verifyFlow(
      'consistency',
      context({
        expectations: [{ ...visibleExpectation, assertion: 'containsText', value: 'Total: 20' }],
      }),
    ),
    true,
  );
});
