import { logger } from '../../../logging/logger.js';
import type { ILlmProvider, LlmMessage } from '../../interfaces/llm-provider.interface.js';

export class MockLlmProvider implements ILlmProvider {
  async generateStructuredJson(params: {
    messages: LlmMessage[];
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    logger.debug('MockLlmProvider.generateStructuredJson called', {
      messageCount: params.messages.length,
    });

    return {
      message: "Welcome to IstaSeva! I'd love to help you get set up. What type of service do you provide?",
      profile_updates: {},
      action: 'category_select',
      is_complete: false,
    };
  }
}

export const mockLlmProvider = new MockLlmProvider();
