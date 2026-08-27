import { randomUUID } from "node:crypto";
import type {
  LlmProvider,
  ProviderTurn,
  ToolDefinition,
  ToolResult,
} from "./provider.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "./provider.js";
import { estimateRequestTokens, rateLimitHeadersSummary, sharedRateLimitCoordinator } from "./rate-limit.js";
import { Logger } from "../logging/logger.js";

const API_URL = "https://api.x.ai/v1/responses";

interface GrokOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface GrokResponse {
  id: string;
  output?: GrokOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

function toGrokTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export class GrokProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private convId: string;
  private tools: ReturnType<typeof toGrokTools> = [];
  private lastResponseId: string | null = null;
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger("quiet")) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
    // Passed as x-grok-conv-id on every request — xAI's docs recommend this to route a
    // conversation's requests to the same server, which is what makes cache hits reliable.
    this.convId = randomUUID();
  }

  async start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
  }): Promise<ProviderTurn> {
    this.lastResponseId = null;
    this.convId = randomUUID();
    this.tools = toGrokTools(params.tools);
    const userContent: unknown[] = [{ type: "input_text", text: params.initialInput }];
    if (params.screenshot) {
      userContent.push({ type: "input_image", image_url: `data:image/jpeg;base64,${params.screenshot}` });
    }
    return this.send([
      { role: "system", content: params.systemPrompt },
      { role: "user", content: userContent },
    ]);
  }

  async continue(toolResult: ToolResult): Promise<ProviderTurn> {
    const input: unknown[] = [
      {
        type: "function_call_output",
        call_id: toolResult.toolCallId,
        output: toolResult.result,
      },
    ];
    if (toolResult.screenshot) {
      input.push({
        role: "user",
        content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${toolResult.screenshot}` }],
      });
    }
    return this.send(input);
  }

  private async send(input: unknown[]): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug("provider.request_started", "Grok request started", { provider: "grok", model: this.model, requestIndex });
    const startedAt = Date.now();

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      tools: this.tools,
      parallel_tool_calls: false,
      max_output_tokens: AGENT_MAX_OUTPUT_TOKENS,
    };
    if (this.lastResponseId) body.previous_response_id = this.lastResponseId;

    await sharedRateLimitCoordinator.beforeRequest(
      `grok:${this.model}`,
      estimateRequestTokens(body, AGENT_MAX_OUTPUT_TOKENS),
      this.logger,
    );
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "x-grok-conv-id": this.convId,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 429) {
        this.logger.debug("provider.rate_limited", "Grok request was rate limited", { provider: "grok", model: this.model, requestIndex, status: response.status, body: errorBody });
        throw new Error("Grok rate limit reached; request was not retried.");
      }
      this.logger.debug("provider.request_failed", "Grok request failed", { provider: "grok", model: this.model, requestIndex, status: response.status, body: errorBody });
      throw new Error(`Grok request failed: ${response.status}`);
    }

    const data = (await response.json()) as GrokResponse;
    const usage = data.usage;
    sharedRateLimitCoordinator.observe(`grok:${this.model}`, response.headers, usage?.input_tokens);
    this.logger.debug("provider.response_received", "Grok response received", {
      provider: "grok", model: this.model, requestIndex, durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens ?? 0, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0, totalTokens: usage?.total_tokens ?? 0,
      rateLimit: rateLimitHeadersSummary(response.headers).trim() || undefined,
    });

    this.lastResponseId = data.id;

    const output = data.output ?? [];
    const functionCalls = output.filter((item) => item.type === "function_call");
    if (functionCalls.length > 1) {
      this.logger.debug("provider.multiple_tool_calls", "Grok returned multiple tool calls; processing only the first", {
        provider: "grok", model: this.model, requestIndex, count: functionCalls.length,
        tools: functionCalls.map((call) => call.name),
      });
    }
    const callItem = functionCalls[0];
    if (callItem) {
      return {
        type: "tool_call",
        toolCall: {
          id: callItem.call_id ?? "",
          name: callItem.name ?? "",
          input: callItem.arguments ? (JSON.parse(callItem.arguments) as Record<string, unknown>) : {},
        },
      };
    }

    const text = output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text" || part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    return { type: "text", text };
  }
}
