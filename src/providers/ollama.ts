import type {
  LlmProvider,
  ProviderTurn,
  ToolDefinition,
  ToolResult,
} from "./provider.js";
import { Logger } from "../logging/logger.js";

const DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  images?: string[];
}

interface OllamaChatResponse {
  message: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export class OllamaProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private tools: ToolDefinition[] = [];
  private messages: OllamaMessage[] = [];
  private nextCallId = 0;
  private requestIndex = 0;
  private readonly logger: Logger;

  constructor(model: string, baseUrl: string = DEFAULT_BASE_URL, logger = new Logger("quiet")) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.logger = logger;
  }

  async start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
  }): Promise<ProviderTurn> {
    this.tools = params.tools;
    this.messages = [
      { role: "system", content: params.systemPrompt },
      {
        role: "user",
        content: params.initialInput,
        images: params.screenshot ? [params.screenshot] : undefined,
      },
    ];
    return this.send();
  }

  async continue(toolResult: ToolResult): Promise<ProviderTurn> {
    // Ollama matches tool results by name, not by an id — there is no tool_call_id concept.
    // Screenshot support depends entirely on the loaded model being vision-capable —
    // a text-only model makes --screenshots ineffective.
    this.messages.push({
      role: "tool",
      content: toolResult.result,
      tool_name: toolResult.toolName,
      images: toolResult.screenshot ? [toolResult.screenshot] : undefined,
    });
    return this.send();
  }

  private async send(): Promise<ProviderTurn> {
    const requestIndex = ++this.requestIndex;
    this.logger.debug("provider.request_started", "Ollama request started", { provider: "ollama", model: this.model, requestIndex });
    const startedAt = Date.now();

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: toOllamaTools(this.tools),
        stream: false,
        // Thinking models default to verbose chain-of-thought before answering, which is slow
        // for a single tool-call decision. Trade-off: may reduce tool-calling accuracy.
        think: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    this.logger.debug("provider.response_received", "Ollama response received", {
      provider: "ollama", model: this.model, requestIndex, durationMs: Date.now() - startedAt,
      promptTokens: data.prompt_eval_count, outputTokens: data.eval_count,
    });

    const toolCalls = data.message.tool_calls ?? [];
    if (toolCalls.length > 1) {
      this.logger.debug("provider.multiple_tool_calls", "Ollama returned multiple tool calls; processing only the first", {
        provider: "ollama", model: this.model, requestIndex, count: toolCalls.length,
        tools: toolCalls.map((call) => call.function.name),
      });
    }

    const toolCall = toolCalls[0];
    if (toolCall) {
      // Keep only the call that receives a result on the next request. Leaving the other calls
      // in history makes Ollama expect tool results that the single-action agent never sends.
      this.messages.push({ ...data.message, tool_calls: [toolCall] });
      return {
        type: "tool_call",
        toolCall: {
          id: `call-${this.nextCallId++}`,
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        },
      };
    }

    this.messages.push(data.message);
    return { type: "text", text: data.message.content ?? "" };
  }
}
