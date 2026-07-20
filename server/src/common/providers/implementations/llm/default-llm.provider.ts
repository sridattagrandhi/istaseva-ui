import { config } from '../../../config/index.js';
import { logger } from '../../../logging/logger.js';
import type { ILlmProvider } from '../../interfaces/llm-provider.interface.js';

export class DefaultLlmProvider implements ILlmProvider {
  async generateStructuredJson(params: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    const fullMessages = params.systemPrompt
      ? [{ role: 'system' as const, content: params.systemPrompt }, ...params.messages]
      : params.messages;

    let response = '{}';

    if (config.llm.provider === 'openai' && config.llm.openaiApiKey) {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: config.llm.openaiApiKey });

      const completion = await openai.chat.completions.create({
        model: config.llm.model,
        messages: fullMessages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 500,
        response_format: { type: 'json_object' },
      });

      response = completion.choices[0]?.message?.content || '{}';
    } else if (config.llm.provider === 'anthropic' && config.llm.anthropicApiKey) {
      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.llm.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.llm.model || 'claude-sonnet-4-20250514',
          max_tokens: params.maxTokens ?? 500,
          system: params.systemPrompt,
          messages: params.messages.map((message) => ({
            role: message.role === 'system' ? 'user' : message.role,
            content: message.content,
          })),
        }),
      });
      const data = await anthropicResponse.json() as any;
      response = data.content?.[0]?.text || '{}';
    }

    try {
      return JSON.parse(response);
    } catch (err) {
      logger.error('Failed to parse LLM JSON response', { response });
      throw err;
    }
  }
}

export const defaultLlmProvider = new DefaultLlmProvider();
