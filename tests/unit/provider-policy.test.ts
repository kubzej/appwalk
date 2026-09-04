import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRequestError, withHostedProviderRequest } from '../../src/providers/request-policy.js';
import { OpenAIProvider } from '../../src/providers/openai.js';

function jsonRateLimitResponse(body: unknown, remainingTokens: number, resetTokens = '5s'): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining-tokens': String(remainingTokens),
        'x-ratelimit-reset-tokens': resetTokens,
      },
    });
}

test('hosted provider policy retries transient failures and stops after a bounded number of attempts', async () => {
  let attempts = 0;
  const value = await withHostedProviderRequest(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary network failure');
      return 'ok';
    },
    {
      provider: 'TestProvider',
      model: 'test-model',
      requestIndex: 1,
      retryDelayMs: () => 0,
    },
  );

  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});

test('hosted provider policy turns cancellation into a structured provider error', async () => {
  const controller = new AbortController();
  const request = withHostedProviderRequest(
    async (signal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    {
      provider: 'TestProvider',
      model: 'test-model',
      requestIndex: 2,
      signal: controller.signal,
    },
  );
  controller.abort(new Error('cancelled by test'));

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.match(error.message, /cancelled/);
    return true;
  });
});

test('OpenAI adapter rejects malformed successful responses instead of silently producing a flow', async () => {
  const originalFetch = globalThis.fetch;
  // Real OpenAI responses are always application/json; without that header the SDK treats
  // the body as opaque text instead of attempting to parse it, so the fixture wouldn't
  // exercise the malformed-JSON path it's named for.
  globalThis.fetch = async () =>
    new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      new OpenAIProvider('test-key', 'malformed-response-model').start({
        systemPrompt: 'test',
        tools: [],
        initialInput: 'test',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.failure.retryable, false);
        assert.equal(error.failure.attempt, 0);
        assert.match(error.message, /OpenAI request failed/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persona's inflated conversation-size estimate is not diluted by a concurrent sibling's smaller usage on the same model", async () => {
  const originalFetch = globalThis.fetch;
  const scriptedResponses: Array<() => Response> = [];
  globalThis.fetch = async () => {
    const next = scriptedResponses.shift();
    if (!next) throw new Error('test bug: no more scripted responses queued');
    return next();
  };
  const textOutput = (id: string, inputTokens: number) => ({
    id,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 },
  });
  try {
    const model = 'shared-inflation-model';
    const providerA = new OpenAIProvider('test-key', model);
    const providerB = new OpenAIProvider('test-key', model);

    // A's first turn reports a large true server-side history (5000 input tokens) and leaves
    // the shared account with 2000 tokens remaining — enough for a small request, nowhere near
    // enough for A's own next turn once inflated by that 5000-token history.
    scriptedResponses.push(jsonRateLimitResponse(textOutput('resp-a1', 5000), 2000));
    await providerA.start({ systemPrompt: 's', tools: [], initialInput: 'hi' });

    // B is a separate, freshly started conversation on the *same model* (same rate-limit key)
    // — its own tiny turn must not corrupt the inflation estimate used for A's next request.
    // B's own small request comfortably fits the 2000 remaining, so it must NOT block here.
    scriptedResponses.push(jsonRateLimitResponse(textOutput('resp-b1', 50), 2000));
    await providerB.start({ systemPrompt: 's', tools: [], initialInput: 'hi' });

    // A's next turn sends only a small tool result over the wire, but A's own last-observed
    // size (5000) means its true server-side history is nowhere near the 2000 remaining tokens.
    // It must still block, rather than being wrongly admitted using B's much smaller size.
    const controller = new AbortController();
    let resolved = false;
    const pending = providerA
      .continue({ toolCallId: 'call_1', toolName: 'noop', result: 'ok' }, { signal: controller.signal })
      .then(() => {
        resolved = true;
      })
      .catch(() => {
        // Expected once we abort below.
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, "A's inflated estimate must still block it even after B's smaller request");
    controller.abort(new Error('test cleanup'));
    await pending;
  } finally {
    globalThis.fetch = originalFetch;
  }
});
