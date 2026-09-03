import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError, withHostedProviderRequest } from "../src/providers/request-policy.js";
import { OpenAIProvider } from "../src/providers/openai.js";

test("hosted provider policy retries transient failures and stops after a bounded number of attempts", async () => {
  let attempts = 0;
  const value = await withHostedProviderRequest(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary network failure");
      return "ok";
    },
    {
      provider: "TestProvider",
      model: "test-model",
      requestIndex: 1,
      retryDelayMs: () => 0,
    },
  );

  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("hosted provider policy turns cancellation into a structured provider error", async () => {
  const controller = new AbortController();
  const request = withHostedProviderRequest(
    async (signal) => new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    {
      provider: "TestProvider",
      model: "test-model",
      requestIndex: 2,
      signal: controller.signal,
    },
  );
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.match(error.message, /cancelled/);
    return true;
  });
});

test("OpenAI adapter rejects malformed successful responses instead of silently producing a flow", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  try {
    await assert.rejects(
      new OpenAIProvider("test-key", "malformed-response-model").start({
        systemPrompt: "test",
        tools: [],
        initialInput: "test",
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
