import type { Redactor } from "../security/redaction.js";
import type { LlmProvider, ProviderCallOptions, ProviderTurn, ToolDefinition, ToolResult } from "./provider.js";

/**
 * Enforces the data boundary immediately before an LLM adapter receives browser output.
 * Callers may keep richer in-memory state for deterministic replay, but provider adapters must
 * never be trusted to remember to sanitize every request shape they construct.
 */
export class RedactingProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly redactor: Redactor,
  ) {}

  start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    screenshot?: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<ProviderTurn> {
    return this.inner.start({
      ...params,
      systemPrompt: this.redactor.text(params.systemPrompt),
      initialInput: this.redactor.text(params.initialInput),
    });
  }

  continue(toolResult: ToolResult, options?: ProviderCallOptions): Promise<ProviderTurn> {
    return this.inner.continue({
      ...toolResult,
      result: this.redactor.text(toolResult.result),
    }, options);
  }
}
