import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmProvider,
  ProviderTurn,
  ToolDefinition,
  ToolResult,
} from "./provider.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "./provider.js";
import { estimateRequestTokens, rateLimitHeadersSummary, rateLimitRetryDelayMs, sharedRateLimitCoordinator, sleep } from "./rate-limit.js";
import { Logger } from "../logging/logger.js";

/** Retries a 429 this many times before giving up — each attempt waits for the window the
 * response itself reported, so this only helps a request that got caught behind another
 * request's usage, not one whose own size will never fit in a single window (see rate-limit.ts). */
const MAX_RATE_LIMIT_RETRIES = 3;

// TS can't verify a cache_control-bearing spread against a discriminated union (ContentBlockParam)
// without collapsing it — cast through `object` and back to `T` rather than fighting the inference.
function cached<T>(block: T): T {
  return { ...(block as object), cache_control: { type: "ephemeral" } } as T;
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private systemPrompt = "";
  private tools: Anthropic.Tool[] = [];
  private messages: Anthropic.MessageParam[] = [];
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger("quiet")) {
    // The SDK retries 429s by default with its own backoff, blind to the reset time in the
    // response headers. We disable that and retry ourselves (see send()) so the wait actually
    // matches the window the provider reported instead of a generic exponential guess.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    this.model = model;
    this.logger = logger;
  }

  async start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
    maxOutputTokens?: number;
  }): Promise<ProviderTurn> {
    this.systemPrompt = params.systemPrompt;
    this.tools = params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: params.initialInput }];
    if (params.screenshot) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: params.screenshot },
      });
    }
    this.messages = [{ role: "user", content }];
    return this.send(params.maxOutputTokens);
  }

  async continue(toolResult: ToolResult): Promise<ProviderTurn> {
    // Anthropic lets an image ride inside the tool_result block itself, unlike the
    // OpenAI/Grok Responses API shape, which needs a separate synthetic user message.
    const resultContent: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
      { type: "text", text: toolResult.result },
    ];
    if (toolResult.screenshot) {
      resultContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: toolResult.screenshot },
      });
    }
    this.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolResult.toolCallId,
          content: resultContent,
        },
      ],
    });
    return this.send();
  }

  private async send(maxOutputTokens = AGENT_MAX_OUTPUT_TOKENS): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    // Cache breakpoints on the last tool, the system prompt, and the last message block —
    // both are identical every turn, and history only ever grows, so each breakpoint lets
    // Anthropic reuse everything before it instead of re-billing it as fresh input. Built
    // fresh per request; `this.messages` itself stays plain.
    const tools = this.tools.map((tool, i) => (i === this.tools.length - 1 ? cached(tool) : tool));
    const system: Anthropic.TextBlockParam[] = [cached({ type: "text", text: this.systemPrompt })];
    const messages = this.messages.map((message, i) => {
      if (i !== this.messages.length - 1) return message;
      const content: Anthropic.ContentBlockParam[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content;
      const lastIndex = content.length - 1;
      return {
        ...message,
        content: content.map((block, j) => (j === lastIndex ? cached(block) : block)),
      };
    });

    const request = {
      model: this.model,
      max_tokens: maxOutputTokens,
      system,
      messages,
      tools,
      // Our loop executes one action at a time — without this, Claude can return
      // multiple tool_use blocks in one turn, and we'd only ever resolve the first,
      // leaving the rest without a tool_result (Anthropic's API rejects that on the next call).
      tool_choice: { type: "auto" as const, disable_parallel_tool_use: true },
    };
    this.logger.debug("provider.request_started", "Anthropic request started", { provider: "anthropic", model: this.model, requestIndex });
    await sharedRateLimitCoordinator.beforeRequest(
      `anthropic:${this.model}`,
      estimateRequestTokens(request, maxOutputTokens),
      this.logger,
    );

    let response: Anthropic.Message;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.client.messages.create(request).withResponse();
        response = result.data;
        sharedRateLimitCoordinator.observe(
          `anthropic:${this.model}`,
          result.response.headers,
          response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0),
        );
        this.logger.debug("provider.rate_limits_observed", "Anthropic rate limits observed", { provider: "anthropic", model: this.model, requestIndex, rateLimit: rateLimitHeadersSummary(result.response.headers).trim() || undefined });
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 429) throw error;

        const headers = (error as { headers?: Headers }).headers;
        const limitHint = headers ? rateLimitHeadersSummary(headers) : "";
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = headers ? rateLimitRetryDelayMs(headers) : 5_000;
          this.logger.warn(`Anthropic rate limit hit; retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).${limitHint}`);
          this.logger.debug("provider.rate_limited", "Anthropic request was rate limited; retrying", { provider: "anthropic", model: this.model, requestIndex, attempt, waitMs, hint: limitHint });
          await sleep(waitMs);
          continue;
        }
        this.logger.debug("provider.rate_limited", "Anthropic request was rate limited; retries exhausted", { provider: "anthropic", model: this.model, requestIndex, hint: limitHint });
        throw new Error(`Anthropic rate limit reached; retried ${MAX_RATE_LIMIT_RETRIES} times without success.${limitHint}`);
      }
    }

    const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } =
      response.usage;
    this.logger.debug("provider.response_received", "Anthropic response received", {
      provider: "anthropic", model: this.model, requestIndex, inputTokens: input_tokens, outputTokens: output_tokens,
      cacheWriteTokens: cache_creation_input_tokens ?? 0, cacheReadTokens: cache_read_input_tokens ?? 0,
    });

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (toolUses.length > 1) {
      this.logger.debug("provider.multiple_tool_calls", "Anthropic returned multiple tool calls; processing only the first", {
        provider: "anthropic", model: this.model, requestIndex, count: toolUses.length,
        tools: toolUses.map((tool) => tool.name),
      });
    }

    const toolUse = toolUses[0];
    if (toolUse && toolUse.type === "tool_use") {
      // The request disables parallel calls, but normalize a non-conforming response before
      // adding it to history so the next tool_result has no unresolved sibling call.
      this.messages.push({
        role: "assistant",
        content: response.content.filter((block) => block.type !== "tool_use" || block === toolUse),
      });
      return {
        type: "tool_call",
        toolCall: {
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
        },
      };
    }

    this.messages.push({ role: "assistant", content: response.content });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { type: "text", text, incompleteReason: response.stop_reason === "max_tokens" ? "max_tokens" : undefined };
  }
}
