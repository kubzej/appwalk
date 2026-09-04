import type { ProviderName } from '../config.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { GrokProvider } from '../providers/grok.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenAIProvider } from '../providers/openai.js';
import { RedactingProvider } from '../providers/redacting.js';
import type { LlmProvider } from '../providers/provider.js';
import { Redactor } from '../security/redaction.js';
import { appLogger } from './logger-state.js';
import type { Logger } from '../logging/logger.js';

export function createProvider(
  provider: ProviderName,
  model: string,
  apiKey: string | undefined,
  redactor: Redactor,
  logger: Logger = appLogger,
): LlmProvider {
  const inner =
    provider === 'gemini'
      ? new GeminiProvider(apiKey!, model, logger)
      : provider === 'ollama'
        ? new OllamaProvider(model, undefined, logger)
        : provider === 'grok'
          ? new GrokProvider(apiKey!, model, logger)
          : provider === 'openai'
            ? new OpenAIProvider(apiKey!, model, logger)
            : new AnthropicProvider(apiKey!, model, logger);
  return new RedactingProvider(inner, redactor);
}
