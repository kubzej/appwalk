import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserContext } from 'playwright';
import { Redactor, REDACTED_VALUE } from '../../src/security/redaction.js';
import { RedactingProvider } from '../../src/providers/redacting.js';
import type { ProviderTurn, ToolDefinition, ToolResult } from '../../src/providers/provider.js';
import { EvidenceRecorder } from '../../src/evidence/recorder.js';

const tools: ToolDefinition[] = [];

test('redacts known secrets, sensitive keys, URLs, and bearer/JWT values through one policy', () => {
  const redactor = new Redactor(['user@example.test', 'super-secret-password']);
  const safe = redactor.redact({
    url: 'https://example.test/orders?order=42&access_token=raw-token',
    credentials: { password: 'super-secret-password' },
    response: { authorization: 'Bearer another-token' },
    text: 'jwt=eyJheader.payload.signature',
  }) as Record<string, unknown>;

  assert.equal(safe.url, 'https://example.test/orders?order=42&access_token=%5BREDACTED%5D');
  assert.deepEqual(safe.credentials, { password: REDACTED_VALUE });
  assert.deepEqual(safe.response, { authorization: REDACTED_VALUE });
  assert.equal(safe.text, `jwt=${REDACTED_VALUE}`);
  assert.equal(redactor.text('contact user@example.test'), `contact ${REDACTED_VALUE}`);
});

test('keeps non-sensitive replay input while masking password-like targets', () => {
  const redactor = new Redactor();
  const input = {
    input: {
      name: 'fill',
      locator: 'input[type=password]',
      value: 'secret-value',
      filePaths: ['agent-inputs/uploads/uma/valid.png'],
    },
  };

  assert.deepEqual(redactor.redact(input, { preserveToolInputs: true }), {
    input: {
      name: 'fill',
      locator: 'input[type=password]',
      value: REDACTED_VALUE,
      filePaths: ['agent-inputs/uploads/uma/valid.png'],
    },
  });
  assert.deepEqual(redactor.redact(input), {
    input: {
      name: 'fill',
      locator: 'input[type=password]',
      value: REDACTED_VALUE,
      filePaths: REDACTED_VALUE,
    },
  });
});

test('sensitive-data detection is repeatable and recursive', () => {
  const redactor = new Redactor();
  const value = { payload: [{ nested: { refreshToken: 'token' } }] };
  assert.equal(redactor.hasSensitiveData(value), true);
  assert.equal(redactor.hasSensitiveData(value), true);
});

test('evidence recorder applies the configured policy at collection time', async () => {
  const context = new EventEmitter() as unknown as BrowserContext;
  const recorder = new EvidenceRecorder(context, undefined, { redactor: new Redactor(['secret-value']) });
  const response = {
    request: () => ({ method: () => 'GET' }),
    url: () => 'https://example.test/api?access_token=secret-value&item=42',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => ({ token: 'secret-value', status: 'ok' }),
  };
  (context as unknown as { emit: (event: string, value: unknown) => boolean }).emit('response', response);
  await recorder.waitForPendingBodies();
  recorder.recordWebSocketFrame({
    url: 'https://example.test/socket?session=secret-value',
    direction: 'received',
    payload: 'token=secret-value',
  });

  assert.equal(recorder.network[0]?.url, 'https://example.test/api?access_token=%5BREDACTED%5D&item=42');
  assert.deepEqual(recorder.network[0]?.body, { token: REDACTED_VALUE, status: 'ok' });
  assert.equal(recorder.webSocketFrames[0]?.url, 'https://example.test/socket?session=%5BREDACTED%5D');
  assert.equal(recorder.webSocketFrames[0]?.payload, `token=${REDACTED_VALUE}`);
});

test('redacting provider sanitizes every textual provider boundary', async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const inner = {
    async start(params: {
      systemPrompt: string;
      tools: ToolDefinition[];
      initialInput: string;
    }): Promise<ProviderTurn> {
      calls.push({ kind: 'start', value: params });
      return { type: 'text', text: 'ok' };
    },
    async continue(result: ToolResult): Promise<ProviderTurn> {
      calls.push({ kind: 'continue', value: result });
      return { type: 'text', text: 'ok' };
    },
  };
  const provider = new RedactingProvider(inner, new Redactor(['secret-value']));

  await provider.start({
    systemPrompt: 'system',
    tools,
    initialInput: 'password=secret-value',
  });
  await provider.continue({ toolCallId: '1', toolName: 'fill', result: 'secret-value' });

  assert.equal((calls[0]?.value as { initialInput: string }).initialInput, `password=${REDACTED_VALUE}`);
  assert.equal((calls[1]?.value as ToolResult).result, REDACTED_VALUE);
});

test('redact() terminates on a self-referential object instead of recursing forever', () => {
  const redactor = new Redactor();
  const node: Record<string, unknown> = { name: 'root' };
  node.self = node; // a direct cycle — the shape a raw Playwright Page's internals can have

  const safe = redactor.redact(node) as Record<string, unknown>;
  assert.equal(safe.name, 'root');
  assert.equal(safe.self, '[REDACTED: circular reference]');
});

test('redact() still walks the same object reused twice as siblings, not just as an ancestor', () => {
  const redactor = new Redactor();
  const shared = { value: 'shared-value' };
  const safe = redactor.redact({ a: shared, b: shared }) as Record<string, unknown>;
  // Reused-but-not-circular data must still be redacted normally in both places, not
  // short-circuited just because the same reference appears twice.
  assert.deepEqual(safe.a, { value: 'shared-value' });
  assert.deepEqual(safe.b, { value: 'shared-value' });
});

test('redact() terminates on a cycle running through an array', () => {
  const redactor = new Redactor();
  const arr: unknown[] = ['first'];
  const node: Record<string, unknown> = { items: arr };
  arr.push(node);

  const safe = redactor.redact(node) as Record<string, unknown>;
  const items = safe.items as unknown[];
  assert.equal(items[0], 'first');
  assert.equal(items[1], '[REDACTED: circular reference]');
});

test('hasSensitiveData() terminates on a self-referential object instead of recursing forever', () => {
  const redactor = new Redactor(['super-secret-password']);
  const node: Record<string, unknown> = { note: 'nothing sensitive here' };
  node.self = node;
  assert.equal(redactor.hasSensitiveData(node), false);

  node.password = 'super-secret-password';
  assert.equal(redactor.hasSensitiveData(node), true);
});
