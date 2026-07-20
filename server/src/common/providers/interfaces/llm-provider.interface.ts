export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * One declared tool the model is allowed to call. Mirrors Gemini's
 * `functionDeclarations` shape so the Gemini provider can pass it through
 * with no translation; other providers (OpenAI, Anthropic) wrap as needed.
 */
export interface LlmToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema (subset Gemini accepts: type, properties, required, enum, items). */
  parameters: Record<string, unknown>;
}

/**
 * A model-emitted call to one of the declared tools. The runner executes it
 * and feeds the result back as an `LlmToolResponse` on the next turn.
 */
export interface LlmToolCall {
  /** Stable id we mint per call so multi-tool turns can pair call→response. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmToolResponse {
  id: string;
  name: string;
  /** Arbitrary JSON-serialisable payload — usually `{ ok: true, data: ... }`. */
  response: Record<string, unknown>;
}

/**
 * One conversational message in a tool-using exchange. Either a normal
 * user/assistant text message, OR an assistant message that emitted tool
 * calls, OR the tool's response feeding back. The provider layer maps these
 * to whatever shape the underlying SDK requires.
 */
export type LlmTurn =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; toolCalls: LlmToolCall[] }
  | { role: 'tool'; responses: LlmToolResponse[] };

export interface LlmToolingResult {
  /** When the model decides to call tools, this is non-empty. */
  toolCalls: LlmToolCall[];
  /** When the model decides it's done, this is the final user-facing text. */
  text?: string;
}

/**
 * Implementations:
 * - Gemini (primary — via @google/genai)
 * - OpenAI (via openai SDK)
 * - Anthropic (via fetch)
 * - Mock (development/testing)
 */
export interface ILlmProvider {
  generateStructuredJson(params: {
    messages: LlmMessage[];
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<Record<string, unknown>>;

  /**
   * Tool-calling primitive. The agent loop calls this in a cycle:
   *   1. send user turn with declared tools → model returns toolCalls or text
   *   2. if toolCalls, execute them, append responses, call again
   *   3. repeat until text returned or max-turns hit
   *
   * Optional — Phase 1 only the Gemini implementation has it. Callers must
   * check for presence and fall back to `generateStructuredJson` otherwise.
   */
  generateWithTools?(params: {
    turns: LlmTurn[];
    systemPrompt?: string;
    tools: LlmToolDeclaration[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<LlmToolingResult>;
}
