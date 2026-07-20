import { z } from 'zod';

export const llmSchema = z.object({
  provider: z.enum(['mock', 'openai', 'anthropic', 'gemini', 'bedrock']).default('mock'),
  model: z.string().min(1).default('gemini-2.5-flash'),
  openaiApiKey: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  // Vertex AI — used for BOTH text Gemini and Live voice. Also reused by
  // Cloud TTS (tts.service.ts). All three optional so non-Gemini envs run
  // without them; the superRefine in config/index.ts enforces presence
  // when LLM_PROVIDER=gemini or TTS_PROVIDER=google.
  vertexProject: z.string().optional(),
  vertexLocation: z.string().optional(),
  vertexServiceAccountJson: z.string().optional(),
  // Phase 1 of the assistant agent overhaul. When true, /api/assistant runs
  // a server-side tool-calling loop instead of the single-shot
  // generateStructuredJson path. Default TRUE — the tool loop is the current
  // architecture (all real tools and inline cards assume it) and a deploy
  // that forgot ASSISTANT_TOOL_LOOP=1 silently
  // regressed to the legacy single-shot assistant. Opt OUT with
  // ASSISTANT_TOOL_LOOP=0 if an environment needs the legacy path.
  assistantToolLoopEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((v) => v === '1' || v === 'true'),
  // Cap on how many model→tool→model cycles a single user turn can run.
  // Picked at 6 because typical happy paths (search → details → availability
  // → final reply) need 3–4; 6 leaves slack for retries without letting a
  // confused model burn budget indefinitely.
  assistantMaxToolTurns: z.coerce.number().int().min(1).max(20).default(6),
  // Phase 2b: same idea as ASSISTANT_TOOL_LOOP but for the onboarding
  // chat at /api/onboarding-agent. When false, /api/onboarding-chat keeps
  // the legacy single-shot JSON path.
  onboardingAgentEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  // Phase 4: persistent memory + grounding. Both default off so the
  // tool-loop path keeps working even before the memory migration runs.
  // Toggle independently — memory is useful without grounding, grounding
  // alone (no memory) is also fine.
  assistantMemoryEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  assistantGroundingEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  // Phase 5: speculative tool execution + realtime tool-call chips.
  // Independent flags — chips are user-visible (low risk), speculative
  // is a perf optimisation that can race in surprising ways under load.
  assistantSpeculativeEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  assistantChipsEnabled: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  // Phase 6: user id of the support account the assistant's
  // escalate_to_human tool DMs (via the normal /api/chat thread machinery).
  // Unset → escalation stays a telemetry-only stub. Set via
  // ASSISTANT_SUPPORT_USER_ID once a staffed support account exists.
  assistantSupportUserId: z.string().uuid().optional(),
});
