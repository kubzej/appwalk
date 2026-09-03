import type {
  LlmProvider,
  ProviderCallOptions,
  ProviderTurn,
  ToolDefinition,
  ToolResult,
} from "./provider.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "./provider.js";
import { estimateRequestTokens, rateLimitHeadersSummary, rateLimitRetryDelayMs, sharedRateLimitCoordinator } from "./rate-limit.js";
import { Logger } from "../logging/logger.js";
import { providerHttpError, ProviderRequestError, withHostedProviderRequest } from "./request-policy.js";

const API_URL = "https://api.openai.com/v1/responses";
interface OpenAiOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAiResponse {
  id: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: OpenAiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export class OpenAIProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private tools: ReturnType<typeof toOpenAiTools> = [];
  private lastResponseId: string | null = null;
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger("quiet")) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<ProviderTurn> {
    this.lastResponseId = null;
    this.tools = toOpenAiTools(params.tools);
    const userContent: unknown[] = [{ type: "input_text", text: params.initialInput }];
    if (params.screenshot) {
      userContent.push({ type: "input_image", image_url: `data:image/jpeg;base64,${params.screenshot}` });
    }
    return this.send([
      { role: "system", content: params.systemPrompt },
      { role: "user", content: userContent },
    ], params.maxOutputTokens, params.signal);
  }

  async continue(toolResult: ToolResult, options?: ProviderCallOptions): Promise<ProviderTurn> {
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
    return this.send(input, undefined, options?.signal);
  }

  private async send(input: unknown[], maxOutputTokens = AGENT_MAX_OUTPUT_TOKENS, signal?: AbortSignal): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug("provider.request_started", "OpenAI request started", { provider: "openai", model: this.model, requestIndex });
    const startedAt = Date.now();

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      tools: this.tools,
      parallel_tool_calls: false,
      max_output_tokens: maxOutputTokens,
    };
    if (this.lastResponseId) body.previous_response_id = this.lastResponseId;

    const requestBody = JSON.stringify(body);

    const result = await withHostedProviderRequest<{ data: OpenAiResponse; headers: Headers }>(async (attemptSignal) => {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: requestBody,
        signal: attemptSignal,
      });
      if (!response.ok) {
        throw providerHttpError("OpenAI", this.model, requestIndex, response.status, await response.text(), response.headers);
      }
      return { data: (await response.json()) as OpenAiResponse, headers: response.headers };
    }, {
      provider: "OpenAI",
      model: this.model,
      requestIndex,
      signal,
      logger: this.logger,
      beforeAttempt: (attemptSignal) => sharedRateLimitCoordinator.beforeRequest(
        `openai:${this.model}`,
        estimateRequestTokens(body, maxOutputTokens),
        this.logger,
        attemptSignal,
      ),
      retryDelayMs: (error) => error instanceof ProviderRequestError && error.failure.status === 429 && error.failure.headers
        ? rateLimitRetryDelayMs(error.failure.headers)
        : undefined,
    });
    const { data } = result;
    const usage = data.usage;
    sharedRateLimitCoordinator.observe(`openai:${this.model}`, result.headers, usage?.input_tokens);
    this.logger.debug("provider.response_received", "OpenAI response received", {
      provider: "openai", model: this.model, requestIndex, durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens ?? 0, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0, totalTokens: usage?.total_tokens ?? 0,
      responseStatus: data.status,
      incompleteReason: data.incomplete_details?.reason,
      rateLimit: rateLimitHeadersSummary(result.headers).trim() || undefined,
    });

    this.lastResponseId = data.id;

    const output = data.output ?? [];
    const functionCalls = output.filter((item) => item.type === "function_call");
    if (functionCalls.length > 1) {
      this.logger.debug("provider.multiple_tool_calls", "OpenAI returned multiple tool calls; processing only the first", {
        provider: "openai", model: this.model, requestIndex, count: functionCalls.length,
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
    return {
      type: "text",
      text,
      incompleteReason: data.incomplete_details?.reason,
    };
  }
}
