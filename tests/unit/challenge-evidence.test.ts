import assert from 'node:assert/strict';
import test from 'node:test';
import { hasMinimumChallengeEvidence } from '../../src/cli/orchestrate.js';
import type { NetworkEntry, RuntimeErrorEntry } from '../../src/evidence/recorder.js';

test('a flow with no expectation, no failed request, and no runtime error has no evidence', () => {
  assert.equal(hasMinimumChallengeEvidence(0, [], []), false);
});

test('a flow with no expectation but only successful requests still has no evidence', () => {
  // The exact shape of iris's 19 wrongly-"confirmed" flows in round 2: two bare navigates, both
  // returning 200, nothing else observed.
  const network: NetworkEntry[] = [
    { method: 'GET', url: 'https://example.test/orders', status: 200 },
    { method: 'GET', url: 'https://example.test/orders/1', status: 200 },
  ];
  assert.equal(hasMinimumChallengeEvidence(0, network, []), false);
});

test('an explicit expectation counts as evidence on its own', () => {
  assert.equal(hasMinimumChallengeEvidence(1, [], []), true);
});

test('a failed (4xx/5xx) request counts as evidence on its own', () => {
  // The one genuinely confirmed case in round 2: a direct API call that got a real 401.
  const network: NetworkEntry[] = [{ method: 'GET', url: 'https://example.test/api/admin/users', status: 401 }];
  assert.equal(hasMinimumChallengeEvidence(0, network, []), true);
});

test('a successful (2xx/3xx) request alone does not count as evidence', () => {
  const network: NetworkEntry[] = [{ method: 'GET', url: 'https://example.test/api/orders', status: 200 }];
  assert.equal(hasMinimumChallengeEvidence(0, network, []), false);
});

test('a recorded runtime error counts as evidence on its own', () => {
  const runtimeErrors: RuntimeErrorEntry[] = [
    { kind: 'request_failed', message: 'net::ERR_CONNECTION_RESET', url: 'https://example.test/api/orders' },
  ];
  assert.equal(hasMinimumChallengeEvidence(0, [], runtimeErrors), true);
});
