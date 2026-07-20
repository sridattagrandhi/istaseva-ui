/**
 * Gemini LLM provider — routes text chat through Vertex AI using the same
 * service-account credentials as the Live voice pipeline.
 *
 * Why Vertex instead of the generativelanguage.googleapis.com (API-key) path:
 *   • One credential for everything (SA JSON) — simpler key rotation + IAM audit
 *   • No dependency on AI Studio's quirky project model / free-tier quotas
 *   • Keeps everything in a single GCP project with explicit billing attribution
 *
 * The @google/genai SDK handles OAuth internally via google-auth-library using
 * the SA credentials we pass in — no token plumbing needed at call sites.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from '../../../config/index.js';
import { logger } from '../../../logging/logger.js';
import { summarizeGeminiUsage } from './gemini-usage.js';
import type {
  ILlmProvider,
  LlmMessage,
  LlmToolDeclaration,
  LlmToolingResult,
  LlmTurn,
} from '../../interfaces/llm-provider.interface.js';

export class GeminiLlmProvider implements ILlmProvider {
  private client: GoogleGenAI | null = null;

  constructor() {
    if (!config.llm.vertexServiceAccountJson || !config.llm.vertexProject) {
      throw new Error(
        'Vertex credentials missing — set GEMINI_VERTEX_SA_JSON and GEMINI_VERTEX_PROJECT. ' +
          'The API-key path (GEMINI_API_KEY) was removed in favour of SA-based auth.',
      );
    }
  }

  private getClient(): GoogleGenAI {
    if (this.client) return this.client;

    const credentials = JSON.parse(config.llm.vertexServiceAccountJson!);

    this.client = new GoogleGenAI({
      vertexai: true,
      project: config.llm.vertexProject!,
      // Text Gemini models are GA in us-central1 everywhere; we keep the same
      // region as Live voice so there's only one regional dependency to reason
      // about for latency & data-residency.
      location: config.llm.vertexLocation ?? 'us-central1',
      googleAuthOptions: { credentials },
    });

    return this.client;
  }

  async generateStructuredJson(params: {
    messages: LlmMessage[];
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<Record<string, unknown>> {
    const client = this.getClient();

    // Gemini uses 'user' and 'model' roles (not 'assistant'). System prompt is
    // passed separately. The contents array MUST start with a 'user' message —
    // drop leading assistant/model turns (e.g. the greeting) or Vertex 400s.
    const mapped = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: m.content }],
      }));

    const firstUserIdx = mapped.findIndex((m) => m.role === 'user');
    const contents = firstUserIdx === -1 ? [] : mapped.slice(firstUserIdx);

    if (contents.length === 0) {
      throw new Error('Gemini requires at least one user message in the conversation');
    }

    // Retry transient upstream errors: Vertex occasionally 503/429s under
    // burst load. Cap at 3 attempts so the user-facing latency budget stays
    // reasonable (~2s worst case vs single-shot's ~500ms).
    const result = await this.withRetry(() =>
      client.models.generateContent({
        model: config.llm.model,
        contents,
        config: {
          temperature: params.temperature ?? 0.7,
          // gemini-2.5-* silently burns output tokens on an internal "thinking"
          // phase before emitting the response. For structured-JSON chat we
          // don't want reasoning overhead — disable it so the entire budget
          // goes to the actual answer. (thinkingBudget=0 disables thinking on
          // 2.5-flash; 2.5-pro has a minimum budget it enforces itself.)
          thinkingConfig: { thinkingBudget: 0 },
          // Bumped from 500 → 2048: 500 was fine for pre-2.5 Gemini, but the
          // JSON responses for the assistant can exceed that once tool-call
          // arguments or listing summaries are included. 2048 is still well
          // under Vertex's per-call ceiling.
          maxOutputTokens: params.maxTokens ?? 2048,
          responseMimeType: 'application/json',
          ...(params.systemPrompt ? { systemInstruction: params.systemPrompt } : {}),
        },
      }),
    );

    this.logUsage('json', result);

    // The SDK exposes `.text` as a convenience accessor that concatenates all
    // text parts in the first candidate. When the model emits no text (e.g.
    // safety-blocked), this is undefined — treat as empty string so the caller
    // sees a clear JSON-parse error rather than a cryptic TypeError.
    const response: string = result.text ?? '';
    const cleaned = this.extractJson(response);

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      logger.error('Failed to parse Gemini JSON response', { response });
      throw err;
    }
  }

  /**
   * Tool-calling primitive used by the agent loop. Maps our provider-neutral
   * `LlmTurn[]` to Gemini's contents/functionCall/functionResponse parts and
   * returns either the model's tool-call list OR its final text. The caller
   * (agent loop) is responsible for executing tools, feeding responses back
   * via another `generateWithTools` call, and capping the cycle.
   */
  async generateWithTools(params: {
    turns: LlmTurn[];
    systemPrompt?: string;
    tools: LlmToolDeclaration[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<LlmToolingResult> {
    const client = this.getClient();

    // Map our neutral turn shape to Gemini's content parts. Gemini expects:
    //   user text     → { role: 'user',     parts: [{text}] }
    //   model text    → { role: 'model',    parts: [{text}] }
    //   model toolcall→ { role: 'model',    parts: [{functionCall: {name,args}}] }
    //   tool response → { role: 'function', parts: [{functionResponse: {name,response}}] }
    // Our internal `id` for pairing call→response is dropped here — Gemini
    // pairs by NAME within a single turn; the agent loop preserves order so
    // re-pairing on the way back works.
    const contents = params.turns
      .map((turn) => {
        if (turn.role === 'user') {
          return { role: 'user' as const, parts: [{ text: turn.content }] };
        }
        if (turn.role === 'tool') {
          return {
            role: 'function' as const,
            parts: turn.responses.map((r) => ({
              functionResponse: { name: r.name, response: r.response },
            })),
          };
        }
        // assistant — either text or tool calls
        if ('toolCalls' in turn) {
          return {
            role: 'model' as const,
            parts: turn.toolCalls.map((c) => ({
              functionCall: { name: c.name, args: c.args },
            })),
          };
        }
        return { role: 'model' as const, parts: [{ text: turn.content }] };
      })
      // Gemini 400s if contents start with a model/function turn. Drop any
      // leading non-user turns the same way generateStructuredJson does.
      .filter(Boolean);

    const firstUserIdx = contents.findIndex((c) => c.role === 'user');
    const trimmed = firstUserIdx === -1 ? [] : contents.slice(firstUserIdx);

    if (trimmed.length === 0) {
      throw new Error('Gemini requires at least one user message in the conversation');
    }

    const result = await this.withRetry(() =>
      client.models.generateContent({
        model: config.llm.model,
        contents: trimmed,
        config: {
          temperature: params.temperature ?? 0.7,
          // Same rationale as generateStructuredJson — the assistant's text
          // replies are short and shouldn't burn the budget on internal
          // reasoning. 2.5-pro enforces a minimum thinkingBudget so this is
          // a no-op there, but on flash it matters.
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: params.maxTokens ?? 2048,
          tools: [{ functionDeclarations: params.tools as never[] }],
          ...(params.systemPrompt ? { systemInstruction: params.systemPrompt } : {}),
        },
      }),
    );

    this.logUsage('tools', result);

    // Walk the first candidate's parts. A single response can mix text and
    // function calls (rare in practice, but the SDK allows it). We treat any
    // function-call presence as "the model wants to call tools" and ignore
    // any sibling text — the agent loop will get the text on a later turn
    // after tool results come back.
    const parts = (result as { candidates?: Array<{ content?: { parts?: unknown[] } }> })
      .candidates?.[0]?.content?.parts ?? [];

    const toolCalls: LlmToolingResult['toolCalls'] = [];
    let text = '';
    let callIdx = 0;

    for (const part of parts as Array<Record<string, unknown>>) {
      if (part.functionCall) {
        const fc = part.functionCall as { name?: string; args?: Record<string, unknown> };
        if (fc.name) {
          toolCalls.push({
            id: `call_${Date.now()}_${callIdx++}`,
            name: fc.name,
            args: fc.args ?? {},
          });
        }
      } else if (typeof part.text === 'string') {
        text += part.text;
      }
    }

    if (toolCalls.length > 0) {
      return { toolCalls };
    }
    return { toolCalls: [], text: text.trim() };
  }

  /**
   * Emit per-call token usage so the assistant's input-token spend (COST-002)
   * is observable in logs. `cachedPct` shows whether Gemini's implicit prompt
   * cache is discounting the large repeated system-prompt/tool-schema prefix;
   * 0% means every iteration is billed as fresh input. No-op when the response
   * carries no usage metadata (e.g. safety-blocked).
   */
  private logUsage(mode: 'json' | 'tools', result: unknown): void {
    const usage = summarizeGeminiUsage(result);
    if (usage) logger.info('gemini token usage', { mode, model: config.llm.model, ...usage });
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message ?? '';
        // Only retry on transient upstream errors; never on 4xx validation etc.
        const transient = /\b(503|429|500|502|504|ECONNRESET|ETIMEDOUT|fetch failed)\b/i.test(msg);
        if (!transient || attempt === maxAttempts) throw err;
        const backoff = 300 * attempt + Math.floor(Math.random() * 200);
        logger.warn('Gemini transient failure, retrying', { attempt, backoff, error: msg });
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastErr;
  }

  private extractJson(text: string): string {
    const trimmed = text.trim();
    // Strip markdown code fences like ```json ... ``` or ``` ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) return fenceMatch[1].trim();
    // Fall back to first { ... last } substring
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) return trimmed.slice(first, last + 1);
    return trimmed;
  }
}

export const geminiLlmProvider = new GeminiLlmProvider();
