import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import type {
  LlmProvider,
  ProviderTurn,
  ToolDefinition,
  ToolResult,
} from "./provider.js";
import { AGENT_MAX_OUTPUT_TOKENS } from "./provider.js";
import { estimateRequestTokens, sharedRateLimitCoordinator, sleep } from "./rate-limit.js";
import { Logger } from "../logging/logger.js";

/** Retries a 429 this many times before giving up — each attempt waits for the window the
 * coordinator last observed, so this only helps a request that got caught behind another
 * request's usage, not one whose own size will never fit in a single window (see rate-limit.ts). */
const MAX_RATE_LIMIT_RETRIES = 3;

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
  private systemPrompt = "";
  private tools: ReturnType<typeof toGeminiTools> = [];
  // Full growing history, resent on every request — implicit caching only detects a
  // repeated prefix if it's literally present in the request.
  private contents: Content[] = [];
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(apiKey: string, model: string, logger = new Logger("quiet")) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { retryOptions: { attempts: 1 } },
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
  }): Promise<ProviderTurn> {
    this.systemPrompt = params.systemPrompt;
    this.tools = toGeminiTools(params.tools);
    const parts: Part[] = [{ text: params.initialInput }];
    if (params.screenshot) {
      parts.push({ inlineData: { mimeType: "image/jpeg", data: params.screenshot } });
    }
    this.contents = [{ role: "user", parts }];
    return this.send(params.maxOutputTokens);
  }

  async continue(toolResult: ToolResult): Promise<ProviderTurn> {
    const parts: Part[] = [
      {
        functionResponse: {
          name: toolResult.toolName,
          response: { output: toolResult.result },
        },
      },
    ];
    if (toolResult.screenshot) {
      parts.push({ inlineData: { mimeType: "image/jpeg", data: toolResult.screenshot } });
    }
    this.contents.push({ role: "user", parts });
    return this.send();
  }

  private async send(maxOutputTokens = AGENT_MAX_OUTPUT_TOKENS): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug("provider.request_started", "Gemini request started", { provider: "gemini", model: this.model, requestIndex });
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
    await sharedRateLimitCoordinator.beforeRequest(
      `gemini:${this.model}`,
      estimateRequestTokens(request, maxOutputTokens),
      this.logger,
    );
    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.client.models.generateContent(request);
        break;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 429) throw error;

        // Gemini's ApiError doesn't expose the response headers, so we fall back to the
        // coordinator's own last-observed reset time for this model rather than a bare guess.
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = sharedRateLimitCoordinator.retryDelayMs(`gemini:${this.model}`);
          this.logger.warn(`Gemini rate limit hit; retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).`);
          this.logger.debug("provider.rate_limited", "Gemini request was rate limited; retrying", { provider: "gemini", model: this.model, requestIndex, attempt, waitMs, error: (error as Error).message });
          await sleep(waitMs);
          continue;
        }
        this.logger.debug("provider.rate_limited", "Gemini request was rate limited; retries exhausted", { provider: "gemini", model: this.model, requestIndex, error: (error as Error).message });
        throw new Error(`Gemini rate limit reached; retried ${MAX_RATE_LIMIT_RETRIES} times without success.`);
      }
    }

    const responseHeaders = response.sdkHttpResponse?.responseInternal.headers;
    if (responseHeaders) sharedRateLimitCoordinator.observe(`gemini:${this.model}`, responseHeaders, response.usageMetadata?.promptTokenCount);

    const usage = response.usageMetadata;
    this.logger.debug("provider.response_received", "Gemini response received", {
      provider: "gemini", model: this.model, requestIndex, durationMs: Date.now() - startedAt,
      inputTokens: usage?.promptTokenCount ?? 0, cachedTokens: usage?.cachedContentTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0, totalTokens: usage?.totalTokenCount ?? 0,
    });

    const candidateContent = response.candidates?.[0]?.content;
    const functionCalls = response.functionCalls;

    if (candidateContent && functionCalls && functionCalls.length > 0) {
      if (functionCalls.length > 1) {
        this.logger.debug("provider.multiple_tool_calls", "Gemini returned multiple tool calls; processing only the first", {
          provider: "gemini", model: this.model, requestIndex, count: functionCalls.length,
          tools: functionCalls.map((call) => call.name),
        });
      }
      // Only act on the first call — keep history consistent with what we'll respond to.
      const firstCallPart = (candidateContent.parts ?? []).find((p: Part) => p.functionCall);
      this.contents.push({ role: "model", parts: firstCallPart ? [firstCallPart] : [] });

      const [call] = functionCalls;
      return {
        type: "tool_call",
        toolCall: {
          id: call?.id ?? call?.name ?? "",
          name: call?.name ?? "",
          input: call?.args ?? {},
        },
      };
    }

    if (candidateContent) this.contents.push(candidateContent);
    return {
      type: "text",
      text: response.text ?? "",
      incompleteReason: response.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "MAX_TOKENS" : undefined,
    };
  }
}
