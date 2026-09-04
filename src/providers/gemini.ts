import { GoogleGenAI } from '@google/genai';
import type { Content, Part } from '@google/genai';
import type { LlmProvider, ProviderCallOptions, ProviderTurn, ToolDefinition, ToolResult } from './provider.js';
import { AGENT_MAX_OUTPUT_TOKENS } from './provider.js';
import { estimateRequestTokens, sharedRateLimitCoordinator } from './rate-limit.js';
import { Logger } from '../logging/logger.js';
import { providerStatus, withHostedProviderRequest, HOSTED_PROVIDER_REQUEST_TIMEOUT_MS } from './request-policy.js';

function toGeminiTools(tools: ToolDefinition[]) {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    },
  ];
}

export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private systemPrompt = '';
  private tools: ReturnType<typeof toGeminiTools> = [];
  // Full growing history, resent on every request — implicit caching only detects a
  // repeated prefix if it's literally present in the request.
  private contents: Content[] = [];
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger('quiet')) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: HOSTED_PROVIDER_REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });
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
    this.systemPrompt = params.systemPrompt;
    this.tools = toGeminiTools(params.tools);
    const parts: Part[] = [{ text: params.initialInput }];
    if (params.screenshot) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: params.screenshot } });
    }
    this.contents = [{ role: 'user', parts }];
    return this.send(params.maxOutputTokens, params.signal);
  }

  async continue(toolResult: ToolResult, options?: ProviderCallOptions): Promise<ProviderTurn> {
    const parts: Part[] = [
      {
        functionResponse: {
          name: toolResult.toolName,
          response: { output: toolResult.result },
        },
      },
    ];
    if (toolResult.screenshot) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: toolResult.screenshot } });
    }
    this.contents.push({ role: 'user', parts });
    return this.send(undefined, options?.signal);
  }

  private async send(maxOutputTokens = AGENT_MAX_OUTPUT_TOKENS, signal?: AbortSignal): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug('provider.request_started', 'Gemini request started', {
      provider: 'gemini',
      model: this.model,
      requestIndex,
    });
    const startedAt = Date.now();

    const request = {
      model: this.model,
      contents: this.contents,
      config: {
        systemInstruction: this.systemPrompt,
        tools: this.tools,
        maxOutputTokens,
      },
    };
    const result = await withHostedProviderRequest<Awaited<ReturnType<typeof this.client.models.generateContent>>>(
      async (attemptSignal) =>
        this.client.models.generateContent({
          ...request,
          config: { ...request.config, abortSignal: attemptSignal },
        }),
      {
        provider: 'Gemini',
        model: this.model,
        requestIndex,
        signal,
        logger: this.logger,
        beforeAttempt: (attemptSignal) =>
          sharedRateLimitCoordinator.beforeRequest(
            `gemini:${this.model}`,
            estimateRequestTokens(request, maxOutputTokens),
            this.logger,
            attemptSignal,
          ),
        retryDelayMs: (error) =>
          providerStatus(error) === 429 ? sharedRateLimitCoordinator.retryDelayMs(`gemini:${this.model}`) : undefined,
      },
    );
    const response = result;
    const responseHeaders = response.sdkHttpResponse?.responseInternal.headers;
    if (responseHeaders)
      sharedRateLimitCoordinator.observe(
        `gemini:${this.model}`,
        responseHeaders,
        response.usageMetadata?.promptTokenCount,
      );

    const usage = response.usageMetadata;
    this.logger.debug('provider.response_received', 'Gemini response received', {
      provider: 'gemini',
      model: this.model,
      requestIndex,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.promptTokenCount ?? 0,
      cachedTokens: usage?.cachedContentTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    });

    const candidateContent = response.candidates?.[0]?.content;
    const functionCalls = response.functionCalls;

    if (candidateContent && functionCalls && functionCalls.length > 0) {
      if (functionCalls.length > 1) {
        this.logger.debug(
          'provider.multiple_tool_calls',
          'Gemini returned multiple tool calls; processing only the first',
          {
            provider: 'gemini',
            model: this.model,
            requestIndex,
            count: functionCalls.length,
            tools: functionCalls.map((call) => call.name),
          },
        );
      }
      // Only act on the first call — keep history consistent with what we'll respond to.
      const firstCallPart = (candidateContent.parts ?? []).find((p: Part) => p.functionCall);
      this.contents.push({ role: 'model', parts: firstCallPart ? [firstCallPart] : [] });

      const [call] = functionCalls;
      return {
        type: 'tool_call',
        toolCall: {
          id: call?.id ?? call?.name ?? '',
          name: call?.name ?? '',
          input: call?.args ?? {},
        },
      };
    }

    if (candidateContent) this.contents.push(candidateContent);
    return {
      type: 'text',
      text: response.text ?? '',
      incompleteReason: response.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'MAX_TOKENS' : undefined,
    };
  }
}
