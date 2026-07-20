/**
 * Stub LLM provider for the onboarding agent replay harness.
 *
 * Replays a pre-recorded sequence of `generateWithTools` results in
 * order. The agent loop calls `generateWithTools` once per "LLM round
 * trip within the user-facing turn" — typically one for the
 * tool-emitting response and one for the final-text response — so a
 * single user message usually needs 2 stub responses.
 *
 * What this CAN test: that the registry-derived schemas, the
 * normalization passes, and the submit-gate plumbing behave the way
 * we expect when fed realistic model outputs. The model itself is
 * mocked, so this CANNOT detect prompt regressions where the actual
 * Gemini call would produce different toolCalls. Those are caught by
 * manual smoke testing against staging.
 *
 * When you intentionally change the prompt or the schemas, the
 * recorded `LlmToolingResult` payloads here may need to be re-recorded
 * by hand from a real Gemini run.
 */
import type {
  ILlmProvider,
  LlmToolingResult,
  LlmMessage,
} from '../../../../../../common/providers/interfaces/llm-provider.interface.js';

export class StubLlmProvider implements ILlmProvider {
  private idx = 0;
  constructor(private readonly responses: LlmToolingResult[]) {}

  async generateStructuredJson(_params: {
    messages: LlmMessage[];
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    throw new Error('StubLlmProvider.generateStructuredJson should not be called by the agent loop');
  }

  async generateWithTools(): Promise<LlmToolingResult> {
    const r = this.responses[this.idx++];
    if (!r) {
      throw new Error(
        `StubLlmProvider: ran out of canned responses at index ${this.idx - 1} (provided ${this.responses.length})`,
      );
    }
    return r;
  }

  /** Number of stub responses consumed so far. */
  get consumed(): number {
    return this.idx;
  }
}

let stubCallId = 0;
/** Generate a unique stub call id — Gemini wire format requires each
 *  function call to have a stable id so its `tool` response can be
 *  paired back to it. */
export function nextCallId(prefix = 'stub'): string {
  return `${prefix}-${++stubCallId}`;
}
