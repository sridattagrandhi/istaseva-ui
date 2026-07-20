/**
 * Pure token-usage extraction for Gemini responses — kept in its own module so
 * it can be unit-tested without importing the provider (which self-instantiates
 * at import time and requires Vertex credentials).
 *
 * This is cost telemetry for COST-002 ("prompt/tool context is the controllable
 * variable cost — 97% input-token spend"). The user-assistant re-sends a large,
 * static system prompt + tool-schema block on every agent-loop iteration; these
 * numbers make that visible and reveal whether Gemini's implicit prompt cache is
 * actually discounting the repeated prefix (`cachedPct > 0`) or not.
 */

export interface GeminiUsageSummary {
  /** Total input tokens billed for this call (prompt + tools + context + history). */
  promptTokens: number;
  /** Portion of promptTokens served from Gemini's implicit cache (billed cheaper). */
  cachedTokens: number;
  /** cachedTokens as a percentage of promptTokens (0 = nothing cached, all fresh). */
  cachedPct: number;
  /** Output/generation tokens. */
  outputTokens: number;
  /** Internal "thinking" tokens (should be ~0 — thinkingBudget is disabled). */
  thoughtsTokens: number;
  /** Grand total reported by the API. */
  totalTokens: number;
}

interface RawUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Normalize a Gemini `generateContent` result's `usageMetadata` into a flat,
 * loggable summary. Returns null when the response carries no usage metadata
 * (e.g. a mock, or a safety-blocked response) so callers can skip logging
 * rather than emit a row of zeros.
 */
export function summarizeGeminiUsage(result: unknown): GeminiUsageSummary | null {
  const usage = (result as { usageMetadata?: RawUsageMetadata } | null | undefined)?.usageMetadata;
  if (!usage) return null;

  const promptTokens = usage.promptTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;

  return {
    promptTokens,
    cachedTokens,
    cachedPct: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    thoughtsTokens: usage.thoughtsTokenCount ?? 0,
    totalTokens: usage.totalTokenCount ?? 0,
  };
}
