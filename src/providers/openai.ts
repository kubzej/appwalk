import OpenAI from 'openai';
import type { LlmProvider, ProviderCallOptions, ProviderTurn, ToolDefinition, ToolResult } from './provider.js';
import { AGENT_MAX_OUTPUT_TOKENS } from './provider.js';
import {
  estimateRequestTokens,
  rateLimitHeadersSummary,
  rateLimitRetryDelayMs,
  sharedRateLimitCoordinator,
} from './rate-limit.js';
import { Logger } from '../logging/logger.js';
import {
  providerHeaders,
  providerStatus,
  withHostedProviderRequest,
  HOSTED_PROVIDER_REQUEST_TIMEOUT_MS,
} from './request-policy.js';

function toOpenAiTools(tools: ToolDefinition[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: null,
  }));
}

export class OpenAIProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private tools: OpenAI.Responses.FunctionTool[] = [];
  private lastResponseId: string | null = null;
  // The Responses API resends only the newest turn — server-side history reconstructed from
  // previous_response_id isn't in the wire body estimateRequestTokens() sees, so this
  // conversation's own last-observed size is the only way to guess what the server will really
  // count. Kept per instance (not in the shared rate-limit coordinator), since a coordinator key
  // is shared by every persona on the same model and their conversations grow independently.
  private lastObservedInputTokens: number | undefined;
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger('quiet')) {
    // Same reasoning as AnthropicProvider: the SDK's own retry loop is blind to the reset
    // time in rate-limit headers, so we disable it and retry ourselves in send() instead.
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: HOSTED_PROVIDER_REQUEST_TIMEOUT_MS });
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
    this.lastObservedInputTokens = undefined;
    this.tools = toOpenAiTools(params.tools);
    const userContent: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: params.initialInput }];
    if (params.screenshot) {
      userContent.push({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${params.screenshot}`,
        detail: 'auto',
      });
    }
    return this.send(
      [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: userContent },
      ],
      params.maxOutputTokens,
      params.signal,
    );
  }

  async continue(toolResult: ToolResult, options?: ProviderCallOptions): Promise<ProviderTurn> {
    const input: OpenAI.Responses.ResponseInput = [
      {
        type: 'function_call_output',
        call_id: toolResult.toolCallId,
        output: toolResult.result,
      },
    ];
    if (toolResult.screenshot) {
      input.push({
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:image/jpeg;base64,${toolResult.screenshot}`, detail: 'auto' },
        ],
      });
    }
    return this.send(input, undefined, options?.signal);
  }

  private async send(
    input: OpenAI.Responses.ResponseInput,
    maxOutputTokens = AGENT_MAX_OUTPUT_TOKENS,
    signal?: AbortSignal,
  ): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug('provider.request_started', 'OpenAI request started', {
      provider: 'openai',
      model: this.model,
      requestIndex,
    });
    const startedAt = Date.now();

    const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.model,
      input,
      tools: this.tools,
      parallel_tool_calls: false,
      max_output_tokens: maxOutputTokens,
    };
    if (this.lastResponseId) body.previous_response_id = this.lastResponseId;

    const result = await withHostedProviderRequest<{ data: OpenAI.Responses.Response; response: { headers: Headers } }>(
      async (attemptSignal) => this.client.responses.create(body, { signal: attemptSignal }).withResponse(),
      {
        provider: 'OpenAI',
        model: this.model,
        requestIndex,
        signal,
        logger: this.logger,
        beforeAttempt: (attemptSignal) =>
          sharedRateLimitCoordinator.acquire(
            `openai:${this.model}`,
            Math.max(
              estimateRequestTokens(body, maxOutputTokens),
              this.lastObservedInputTokens === undefined ? 0 : Math.ceil(this.lastObservedInputTokens * 1.5),
            ),
            this.logger,
            attemptSignal,
          ),
        retryDelayMs: (error) =>
          providerStatus(error) === 429 && providerHeaders(error)
            ? rateLimitRetryDelayMs(providerHeaders(error) as Headers)
            : undefined,
      },
    );
    const data = result.data;
    const usage = data.usage;
    if (usage?.input_tokens !== undefined) this.lastObservedInputTokens = usage.input_tokens;
    sharedRateLimitCoordinator.observe(`openai:${this.model}`, result.response.headers);
    this.logger.debug('provider.response_received', 'OpenAI response received', {
      provider: 'openai',
      model: this.model,
      requestIndex,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens ?? 0,
      cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      responseStatus: data.status,
      incompleteReason: data.incomplete_details?.reason,
      rateLimit: rateLimitHeadersSummary(result.response.headers).trim() || undefined,
    });

    this.lastResponseId = data.id;

    const output = data.output ?? [];
    const functionCalls = output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
    );
    if (functionCalls.length > 1) {
      this.logger.debug(
        'provider.multiple_tool_calls',
        'OpenAI returned multiple tool calls; processing only the first',
        {
          provider: 'openai',
          model: this.model,
          requestIndex,
          count: functionCalls.length,
          tools: functionCalls.map((call) => call.name),
        },
      );
    }
    const callItem = functionCalls[0];
    if (callItem) {
      return {
        type: 'tool_call',
        toolCall: {
          id: callItem.call_id ?? '',
          name: callItem.name ?? '',
          input: callItem.arguments ? (JSON.parse(callItem.arguments) as Record<string, unknown>) : {},
        },
      };
    }

    const text = output
      .filter((item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message')
      .flatMap((item) => item.content)
      .filter((part) => part.type === 'output_text')
      .map((part) => (part.type === 'output_text' ? part.text : ''))
      .join('');
    return {
      type: 'text',
      text,
      incompleteReason: data.incomplete_details?.reason ?? undefined,
    };
  }
}
