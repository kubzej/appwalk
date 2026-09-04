import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFINITIONS } from '../../src/agent/tools.js';
import { validateToolInput } from '../../src/agent/validation.js';

function definition(name: string) {
  const result = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  assert.ok(result, `missing tool definition: ${name}`);
  return result;
}

test('runtime tool validation rejects malformed scalar values before dispatch', () => {
  assert.throws(
    () => validateToolInput(definition('setOffline'), { offline: 'false' }),
    /Invalid input for tool "setOffline": \$\.offline must be a boolean\./,
  );
  assert.throws(
    () => validateToolInput(definition('handleDialog'), { behavior: 'ignore' }),
    /Invalid input for tool "handleDialog": \$\.behavior must be one of accept, dismiss\./,
  );
});

test('runtime tool validation enforces action limits and rejects unknown fields', () => {
  assert.throws(
    () => validateToolInput(definition('burst'), { action: 'click', locator: '#submit', count: 2.5 }),
    /\$\.count must be a integer\./,
  );
  assert.throws(
    () => validateToolInput(definition('burst'), { action: 'click', locator: '#submit', count: 21 }),
    /\$\.count must be at most 20\./,
  );
  assert.throws(
    () => validateToolInput(definition('click'), { locator: '#submit', unexpected: true }),
    /\$\.unexpected is not allowed\./,
  );
});

test('runtime tool validation accepts valid optional values and nested headers', () => {
  const input = validateToolInput(definition('apiRequest'), {
    method: 'GET',
    url: 'https://example.test/api/orders',
    headers: { Accept: 'application/json' },
  });
  assert.deepEqual(input, {
    method: 'GET',
    url: 'https://example.test/api/orders',
    headers: { Accept: 'application/json' },
  });
});
