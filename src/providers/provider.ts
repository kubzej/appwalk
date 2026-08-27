export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
  /** Base64 JPEG, no data-URI prefix. Only consumed by providers that implement vision fallback — others ignore it. */
  screenshot?: string;
}

/** Tool calls are intentionally small; a large completion only increases token pressure. */
export const AGENT_MAX_OUTPUT_TOKENS = 1024;

export type ProviderTurn =
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "text"; text: string; incompleteReason?: string };

export interface LlmProvider {
  start(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    initialInput: string;
    /** Base64 JPEG, no data-URI prefix. Only consumed by providers that implement vision fallback. */
    screenshot?: string;
    /** Optional per-request output budget for one-shot operations such as response planning. */
    maxOutputTokens?: number;
  }): Promise<ProviderTurn>;

  continue(toolResult: ToolResult): Promise<ProviderTurn>;
}
