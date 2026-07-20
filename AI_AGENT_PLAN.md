# AI_AGENT_PLAN.md — Sathi: From Intent Classifier to Tool-Calling Agent

## 0. Executive summary

Today Sathi is a single-shot JSON producer: one LLM call returns one of eight `action` types and the frontend executes it (`server/src/modules/chat/services/user-assistant.service.ts`, action enum at `src/domains/chat/user-assistant.service.ts:4-12`). This plan replaces that with a server-side **tool-calling loop** running on Vertex Gemini `functionDeclarations`, expands tools to cover the full booking lifecycle, makes onboarding conversational by deleting the 11-step state machine in `src/hooks/useOnboardingFlow.ts`, hardens voice UX, adds grounding checks, persistent memory, confirmation gates, observability, evals, and speculative execution with realtime tool-call status.

Six phases, smallest blast radius first. Phase 1 ships read-only tool-calling on the existing Sathi widget without changing the booking happy path. Phase 6 adds the eval harness that gates further prompt edits.

## 1. Where the existing code lives (load-bearing references)

| Concern | Path |
|---|---|
| Frontend assistant widget | `src/components/assistant/AssistantWidget.tsx` |
| Frontend assistant client | `src/domains/chat/user-assistant.service.ts` |
| Server assistant service + system prompt | `server/src/modules/chat/services/user-assistant.service.ts` |
| Booking preparation (already tool-shaped) | `server/src/modules/chat/services/assistant-booking.service.ts` |
| LLM provider (Vertex Gemini) | `server/src/common/providers/implementations/llm/gemini-llm.provider.ts` |
| LLM provider interface | `server/src/common/providers/interfaces/llm-provider.interface.ts` |
| Onboarding state machine | `src/hooks/useOnboardingFlow.ts` (550 lines, 11 hard-coded steps) |
| Conversation engine | `src/hooks/useConversationEngine.ts` |
| Server onboarding chat | `server/src/modules/chat/services/onboarding-chat.service.ts`, controller + routes alongside |
| Live voice client | `src/hooks/useGeminiLiveVoice.ts` |
| Live voice server proxy | `server/src/modules/chat/services/voice-live.service.ts` |
| Inline pay card | `src/components/assistant/BookingConfirmCard.tsx` |
| Razorpay launcher | `src/lib/razorpay-checkout.ts` |
| Realtime provider (websocket) | `src/providers/realtime/websocket-realtime.provider.ts` (registered in `src/config/providers.ts`) |
| API client | `src/lib/api-client.ts` |
| i18n locales | `src/locales/{en,hi,te,ta,kn,ml,mr}.json` |
| Greeting hard-codings to retire | `AssistantWidget.tsx:40-48`, `useOnboardingFlow.ts:69+` |

## 2. Architectural decisions (all already agreed)

1. Server-side **agent loop** (max N tool turns) with Vertex `functionDeclarations`. The frontend posts a turn and gets back a final reply plus a stream of tool-call events.
2. **Multi-language** moves from per-string Records in TSX to `src/locales/*.json`. `displayLang` flows into the system prompt with a per-language style note ("Hinglish: code-switch freely; native script for Tamil/Telugu/...").
3. **Conversational onboarding** replaces the `OnboardingStep` enum with the same agent loop, targeting an `OnboardingData` schema; agent extracts multiple fields per turn and asks one batched question for what's missing.
4. **Voice UX rules**: never speaks first in widget; client VAD cancels TTS + in-flight LLM; mic open while widget open; silent after Sathi speaks until user responds.
5. **Grounding check**: post-generation server pass scans replies for listing IDs/names/prices, verifies against tool result cache; regenerates if hallucinated.
6. **Persistent memory**: compact JSON in Postgres (`user_assistant_memory` table) injected into system prompt; updated by `rememberPreference` tool.
7. **Confirmation gates**: every state-changing tool returns a "preview" payload; the UI must surface explicit confirm UI before the actual side-effect tool fires.
8. **Human handoff**: three triggers (user asks, agent fails same task twice, hostile sentiment); `escalateToHuman` tool spawns a `/messages` thread with transcript attached.
9. **Observability**: every tool call logged to DynamoDB with latency, args, result hash, request ID; 50-conversation eval set per language.
10. **Voice latency**: stream tokens token-by-token to TTS; Redis-cache listing lookups; pre-warm Live session on page load.
11. **Failure modes**: explicit copy + behavior for Vertex 503 mid-sentence, Razorpay decline mid-prepare, mic permission denied, slot-lock expiry, listing unavailable.
12. **Speculative execution + realtime chips**: speculative `searchListings` against `AbortController`; tool-call status chips streamed via the existing websocket realtime provider; chips hidden if call resolves <300ms.

## 3. Phased rollout

### Phase 1 — Tool-calling loop on Sathi (read-only tools)

**Goal**: replace the action-enum with a real tool-calling loop, but only register read-only tools at first. Booking still flows through the existing `prepare_booking` action path until Phase 2.

**Scope**:
- Extend `ILlmProvider` with a new method that supports tool calls (function declarations + tool result messages).
- Implement on `GeminiLlmProvider` using `@google/genai` `tools: [{ functionDeclarations: [...] }]` and the `functionCall` / `functionResponse` content parts.
- Build a server-side tool registry and a bounded agent loop (`maxToolTurns = 6`).
- Register tools: `searchListings`, `getListingDetails`, `checkAvailability`, `getUserBookings`.
- Keep returning the existing `{message, action, suggestions}` shape to the client so the UI doesn't change yet — the agent's "final reply" maps to `message`/`suggestions`, and `prepare_booking` (still represented as the legacy action enum) gets emitted only when the agent has gathered enough info.

**Files to touch**:
- `server/src/common/providers/interfaces/llm-provider.interface.ts` — add `generateWithTools(...)` method, `Tool` and `ToolCall` types.
- `server/src/common/providers/implementations/llm/gemini-llm.provider.ts` — implement `generateWithTools`, share auth + retry with `generateStructuredJson`.
- `server/src/modules/chat/services/user-assistant.service.ts` — replace `respond()` body with the loop; rewrite system prompt to describe tools instead of action enum.
- `server/src/modules/chat/services/assistant-booking.service.ts` — leave alone; will be wrapped as a tool in Phase 2.
- `server/src/modules/chat/controllers/user-assistant.controller.ts` — pass through additional optional fields (`requestId`).

**New files**:
- `server/src/modules/chat/agent/tools/index.ts` — registry export.
- `server/src/modules/chat/agent/tools/search-listings.tool.ts`
- `server/src/modules/chat/agent/tools/get-listing-details.tool.ts`
- `server/src/modules/chat/agent/tools/check-availability.tool.ts`
- `server/src/modules/chat/agent/tools/get-user-bookings.tool.ts`
- `server/src/modules/chat/agent/agent-loop.ts` — owns the loop, max-turns guard, tool dispatch, error handling.
- `server/src/modules/chat/agent/types.ts` — `ToolDefinition`, `ToolCall`, `ToolResult`, `AgentTurnContext`.

**API contract changes**:
- `POST /api/assistant` request: unchanged (`messages`, `displayLang`, `context`).
- Response: new optional `toolCalls: Array<{name, args, durationMs, result?}>` field for telemetry; clients ignore it for now.

**Env vars**: none new (reuses `GEMINI_VERTEX_*`).

**Rollback plan**: Feature-flag the loop behind `ASSISTANT_TOOL_LOOP=1`. When unset, fall back to current `generateStructuredJson` path. The branch split lives entirely inside `UserAssistantService.respond`.

**Acceptance criteria**:
- "what's a good homestay in Coorg under 4k?" triggers `searchListings({type: 'stay', location: 'Coorg', maxPrice: 4000})`, agent receives results and references real names in reply.
- "what are my bookings?" triggers `getUserBookings` and lists names+dates.
- Loop never exceeds 6 tool turns (returns a graceful "let me try a different angle" message if exceeded).
- Existing `prepare_booking` flow still works end-to-end.

---

### Phase 2 — State-changing tools, confirmation gates, conversational onboarding

**Goal**: complete the tool surface and rewrite onboarding as an agent.

**Scope**:
- Add `prepareBooking` tool (wraps `assistantBookingService.prepare`).
- Add `messageHost`, `cancelBooking` tools — both **two-step**: tool returns a "preview" object, UI renders a Confirm card, user confirms, *then* the side-effect tool variant fires (`prepareBooking_confirmed`, `cancelBooking_confirmed`). Agent prompt teaches it never to call the `_confirmed` variant without a UI confirm event in the conversation.
- Add `escalateToHuman` tool — opens a `/messages` thread, attaches last 20 turns + tool call log, returns `{threadId, status}`.
- Add `rememberPreference` tool (Phase 4 wires the storage; in Phase 2 it's a no-op stub that just acks).
- Build the new onboarding agent endpoint `POST /api/onboarding-agent` with its own tool set: `extractFields`, `setLocation`, `previewListing`, `submitListing`. Agent's job is to fill the `OnboardingData` shape conversationally.
- Delete `OnboardingStep`-driven control flow from `src/hooks/useOnboardingFlow.ts`; keep `OnboardingData` type and the existing UI components (location picker, photo upload), wire them as agent-callable UI.
- Move all hard-coded strings out of `AssistantWidget.tsx:40` and `useOnboardingFlow.ts:69+` into `src/locales/*.json`.

**Files to touch**:
- `src/components/assistant/AssistantWidget.tsx` — remove `GREETINGS` constant; render greeting from `t("assistant.greeting")`. Render new tool-call status chips component (Phase 5 fully wires; Phase 2 just adds the placeholder).
- `src/hooks/useOnboardingFlow.ts` — strip the step machine; expose `state` (current `OnboardingData`), `messages`, `send(text)` that posts to `/api/onboarding-agent`.
- `src/hooks/useConversationEngine.ts` — collapse into the new hook or delete if redundant (decide during implementation).
- `src/locales/{en,hi,te,ta,kn,ml,mr}.json` — add `assistant.greeting`, `onboarding.greeting`, `assistant.signedOutMsg`, etc.
- `server/src/modules/chat/services/user-assistant.service.ts` — system prompt rewrite for two-step confirmations.
- `server/src/modules/chat/services/onboarding-chat.service.ts` — replace with agent-loop variant or add a new sibling service.
- `server/src/app/register-routes.ts` — mount `/api/onboarding-agent`.

**New files**:
- `server/src/modules/chat/agent/tools/prepare-booking.tool.ts`
- `server/src/modules/chat/agent/tools/message-host.tool.ts`
- `server/src/modules/chat/agent/tools/cancel-booking.tool.ts`
- `server/src/modules/chat/agent/tools/escalate-to-human.tool.ts`
- `server/src/modules/chat/agent/tools/remember-preference.tool.ts` (stub)
- `server/src/modules/chat/agent/tools/onboarding/extract-fields.tool.ts`
- `server/src/modules/chat/agent/tools/onboarding/preview-listing.tool.ts`
- `server/src/modules/chat/agent/tools/onboarding/submit-listing.tool.ts`
- `server/src/modules/chat/services/onboarding-agent.service.ts`
- `server/src/modules/chat/controllers/onboarding-agent.controller.ts`
- `server/src/modules/chat/routes/onboarding-agent.routes.ts`
- `src/components/assistant/CancelBookingCard.tsx`, `MessageHostCard.tsx` — confirmation gates.

**API contract changes**:
- `POST /api/onboarding-agent` — `{messages, displayLang, currentData?: Partial<OnboardingData>}` → `{message, suggestions, dataPatch?: Partial<OnboardingData>, toolCalls, finished?: boolean}`.
- Response from `/api/assistant` extends with `pendingConfirmation?: {kind: 'cancel'|'message'|'book', payload: {...}}` for state-changing actions.

**Env vars**: none.

**Rollback**: Onboarding agent behind `ONBOARDING_AGENT=1`; old `useOnboardingFlow` lives in a `legacy/` sibling for one release.

**Acceptance criteria**:
- A first-time host completes onboarding in under 8 turns vs the current 11-step minimum.
- Cancel/message tool calls never fire side effects without a UI confirmation event.
- All language-specific strings are in `src/locales/`.

---

### Phase 3 — Voice rules + barge-in + mic-always-on

**Goal**: make voice feel like a phone call rather than a walkie-talkie.

**Scope**:
- Implement client-side VAD using `@ricky0123/vad-web` (or AudioWorklet-based silence detector) inside `useGeminiLiveVoice.ts`.
- On VAD speech-start while `state === "speaking"`: stop local audio playback, send `{type: 'interrupt'}` upstream, abort any in-flight text-mode `AssistantService.respond` request via `AbortController`.
- On widget open: do **not** call `speak(greeting)` (remove `AssistantWidget.tsx:81`). Onboarding hook still gets one opener.
- On widget open: auto-start the Live session if `liveEnabled`. Remove "Start" button toggle in favour of explicit "End call" only.
- Preload Live websocket on `App.tsx` mount to warm the `/ws/voice` connection.
- After Sathi finishes a turn (server `turn_complete`), client sets `state = 'listening'` immediately and does not auto-speak again.
- Surface mic-permission-denied with a copy + retry button (new locale strings).

**Files to touch**:
- `src/hooks/useGeminiLiveVoice.ts` — add VAD, interrupt handling, mic-permission state.
- `src/hooks/useVoiceAssistant.ts` — deprecate or merge.
- `src/components/assistant/AssistantWidget.tsx` — drop `speak(greeting)`, drop manual mic toggle, replace Start/Stop with End-call button.
- `server/src/modules/chat/services/voice-live.service.ts` — accept `{type: 'interrupt'}` from client and forward (`upstream.sendRealtimeInput({...})` with the appropriate cancel signal).
- `src/App.tsx` — pre-warm Live session.
- `src/locales/*.json` — mic-permission strings.

**New files**:
- `src/lib/audio/vad.ts` — VAD wrapper with a clean `onSpeechStart`/`onSpeechEnd` API.

**API contract**: new client→server WS message `{type: 'interrupt'}`.

**Env vars**: none.

**Rollback**: VAD behind `localStorage.sathi_vad = '1'` for canary; widget-doesn't-speak-first ships unconditionally (it's strictly better).

**Acceptance criteria**:
- User can interrupt Sathi mid-sentence; Sathi stops audio within 200ms.
- Widget opens silently; no "Hi I'm Sathi" TTS playback.
- Mic permission denial shows a clear retry CTA.
- Pre-warm reduces first-utterance latency by >300ms in local measurements.

---

### Phase 4 — Persistent memory + grounding checks

**Goal**: Sathi remembers preferences across sessions and never invents facts.

**Scope**:

**Memory**:
- New table `user_assistant_memory(user_id PK, memory JSONB, updated_at)`. Memory shape: `{preferences: {budget?, locations?: string[], dietaryNeeds?, ...}, history: {recentSearches: [...], lastBookingId?}}`. Hard cap 4KB JSON.
- Server reads memory at the start of every agent turn and embeds a compact summary in the system prompt (after the existing `userContext` block in `user-assistant.service.ts`).
- `rememberPreference({key, value, scope: 'session'|'persistent'})` tool (stubbed in Phase 2) becomes real here. Writes go through `userAssistantMemoryService` with optimistic concurrency on `updated_at`.
- Migration in `server/migrations/`.

**Grounding**:
- After the agent returns its final reply, run `groundingCheck(reply, toolResultCache)`:
  - Extract listing IDs (`UUID` regex), prices (`₹\d+`), and listing names (fuzzy match against names returned by `searchListings`/`getListingDetails`).
  - For each extracted entity, verify it appears in the tool-result cache for *this* turn.
  - If a hallucination is detected, regenerate ONCE with an additional system note: "Your previous reply referenced X, which is not in the data. Reply again using only listings from the tool results."
- Hard limit one regen per turn; if the regen also fails, return the regen anyway and log a `grounding_failed` event.

**Files to touch**:
- `server/src/modules/chat/services/user-assistant.service.ts` — wire memory into system prompt, run grounding check.
- `server/src/modules/chat/services/onboarding-agent.service.ts` — same.

**New files**:
- `server/src/modules/chat/services/user-assistant-memory.service.ts`
- `server/src/modules/chat/repositories/user-assistant-memory.repository.ts`
- `server/src/modules/chat/agent/grounding-check.ts`
- `server/migrations/<ts>_user_assistant_memory.sql`

**API contract**: none external.

**Env vars**: `ASSISTANT_MEMORY_MAX_BYTES=4096` (default).

**Rollback**: feature flag `ASSISTANT_MEMORY=1`, `ASSISTANT_GROUNDING=1`.

**Acceptance criteria**:
- After "I'm vegetarian and travel solo", a later session shows the agent referencing those facts.
- Manual hallucination test (force the model with a contrived prompt) triggers a regenerate; logs show the `grounding_failed` event when it doesn't.
- Memory writes never exceed 4KB; oldest history entries are evicted.

---

### Phase 5 — Speculative execution + realtime tool-call chips + token streaming

**Goal**: cut perceived latency; make the agent's work visible.

**Scope**:

**Speculative execution**:
- When the user types/speaks something with a clear search signal (location keyword + listing-type keyword) the server kicks off `searchListings` *before* the LLM finishes parsing the turn, attached to an `AbortController`.
- If the LLM's first tool call matches the speculative call's args (within tolerance), reuse the result. If args differ, abort the speculative call.
- Heuristic implemented as a small regex/keyword pre-classifier, NOT another LLM call (would add latency).

**Token streaming**:
- Replace `client.models.generateContent` with `client.models.generateContentStream` in `gemini-llm.provider.ts` for the final-reply phase of the loop.
- Stream tokens to the client over a Server-Sent Events endpoint (`POST /api/assistant/stream`) or via the existing websocket realtime provider channel `assistant:<requestId>:tokens`.
- The client renders tokens incrementally; for voice mode, tokens feed the TTS queue token-by-token (Live native-audio is server-side, but a future Anthropic-via-eleven path would use this).

**Tool-call chips**:
- Each tool call emits `{event: 'tool_start', name, requestId}` and `{event: 'tool_done', name, durationMs, summary}` on a websocket channel `assistant:<requestId>:tools`.
- Frontend `AssistantWidget` subscribes via `getRealtimeProvider()` (`src/config/providers.ts`).
- New `<ToolCallChip>` component renders inline in the message stream:
  - `🔍 Searching stays in Coorg…` while pending
  - `✓ Found 12 stays` (collapsed) once done
- Chips with `durationMs < 300` are dropped (prevents flicker).
- Internal/utility tool calls (`rememberPreference`, post-hoc grounding regen) are filtered out — only user-meaningful steps surface.

**Skeleton listing cards**:
- When `searchListings` starts, the agent's reply may include a `[search-pending]` token; UI renders skeleton listing cards in the message bubble. When the tool resolves and the agent emits its final reply, cards hydrate.

**Files to touch**:
- `server/src/common/providers/implementations/llm/gemini-llm.provider.ts` — add `generateWithToolsStream`.
- `server/src/modules/chat/services/user-assistant.service.ts` — emit tool events to realtime channel.
- `server/src/modules/chat/agent/agent-loop.ts` — speculative pre-classifier, AbortController.
- `src/components/assistant/AssistantWidget.tsx` — subscribe to tool events, render chips.
- `src/providers/realtime/websocket-realtime.provider.ts` — ensure subscription API supports per-request channels.

**New files**:
- `src/components/assistant/ToolCallChip.tsx`
- `src/components/assistant/ListingCardSkeleton.tsx`
- `server/src/modules/chat/agent/speculative.ts`

**API contract changes**:
- `POST /api/assistant` now accepts `requestId` (client generates UUID) so streamed events can be correlated.
- New WS channels: `assistant:{requestId}:tools`, `assistant:{requestId}:tokens`.

**Env vars**: `ASSISTANT_SPECULATIVE=1`, `ASSISTANT_STREAMING=1`.

**Rollback**: each behind its own flag.

**Acceptance criteria**:
- Median time-to-first-token < 600ms (vs current ~1.5s for full JSON response).
- Speculative search hits the cache >40% of the time on top-10 query patterns.
- Tool chips appear within 100ms of tool start.

---

### Phase 6 — Evals, observability hardening, failure-mode polish

**Goal**: lock in quality so future prompt edits don't regress.

**Scope**:

**Eval harness**:
- 50 conversation fixtures across 7 languages (≈7 per language + cross-lingual). Each fixture: list of user turns + grading rubric (`mustCallTool`, `mustReferenceListingId`, `mustNotHallucinate`, `mustAskBeforeBooking`).
- Runner under `server/src/modules/chat/agent/evals/` — replays each fixture against a fresh agent loop, scores via deterministic checks + an LLM-as-judge call (gpt-4 or Gemini-pro) for tone.
- CI job `npm run eval:assistant` blocks merges when score drops >5% from baseline.
- Baseline scores stored in `server/src/modules/chat/agent/evals/baseline.json`.

**Observability**:
- Every tool call → DynamoDB table `assistant_audit` (already in stack per `CLAUDE.md`): `{requestId, userId, ts, toolName, args, resultHash, latencyMs, errored, hallucinationDetected}`.
- Every conversation turn logged with `{requestId, finalReply, totalLatencyMs, toolCallCount, regenerated}`.
- Winston structured logs at INFO for happy path, WARN for retries, ERROR for tool exceptions.

**Failure-mode copy** (locale strings + agent prompt examples):
- Vertex 503 mid-sentence → "Bad signal at our end — try again in a sec."
- Razorpay decline mid-prepare → existing system note path keeps working; locale strings reviewed.
- Mic permission denied → "I can't hear you — flip the mic permission on and tap Retry."
- Slot-lock expired → "That hold's gone — pick a date again and I'll relock."
- Listing unavailable → "Looks like that one just got booked — want me to try another?"

**Files to touch**:
- `server/src/modules/chat/agent/agent-loop.ts` — DynamoDB log emit per tool.
- `server/src/common/aws/clients.ts` — already has Dynamo client.
- `server/src/modules/chat/services/user-assistant.service.ts` — wrap final reply in audit log.
- `src/locales/*.json` — failure-mode copy.

**New files**:
- `server/src/modules/chat/agent/evals/fixtures/{en,hi,te,ta,kn,ml,mr}/*.json` (50 total).
- `server/src/modules/chat/agent/evals/run-evals.ts`
- `server/src/modules/chat/agent/evals/judge.ts`
- `server/src/modules/chat/agent/evals/baseline.json`
- `server/src/modules/chat/repositories/assistant-audit.repository.ts`

**API contract**: none.

**Env vars**: `ASSISTANT_AUDIT_TABLE=assistant_audit`.

**Acceptance criteria**:
- Eval suite runs end-to-end against staging Vertex in <5 min.
- Baseline established; CI fails on >5% regression.
- DynamoDB table receives one row per tool call within 1s of completion.

## 4. Cross-cutting concerns

### 4.1 Tool definition schema (`server/src/modules/chat/agent/types.ts`)

```ts
export interface ToolDefinition<TArgs, TResult> {
  name: string;                       // snake_case to match Gemini convention
  description: string;                // shown to the model
  parametersJsonSchema: object;       // JSON Schema, fed to functionDeclarations
  argsZodSchema: ZodSchema<TArgs>;    // server-side validation
  sideEffect: 'read' | 'write';       // gates auto-execution
  preview?: (args: TArgs, ctx: AgentTurnContext) => Promise<TResult>;
  execute: (args: TArgs, ctx: AgentTurnContext) => Promise<TResult>;
  summarize: (args: TArgs, result: TResult) => string; // for chips + grounding
}

export interface AgentTurnContext {
  userId: string;
  displayLang: string;
  requestId: string;
  abortSignal: AbortSignal;
  toolResultCache: Map<string, unknown>; // for grounding check
  emit: (event: AgentEvent) => void;     // realtime channel
}
```

### 4.2 Conversation memory shape

Postgres row:
```sql
CREATE TABLE user_assistant_memory (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  memory JSONB NOT NULL DEFAULT '{}',
  bytes INT GENERATED ALWAYS AS (octet_length(memory::text)) STORED,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (bytes <= 4096)
);
```

JSON shape:
```ts
interface AssistantMemory {
  preferences: {
    budget?: { currency: 'INR'; max?: number };
    locations?: string[];        // e.g. ['Coorg', 'Bangalore']
    dietaryNeeds?: string[];
    travelStyle?: string;
    languages?: string[];
  };
  history: {
    recentSearches: Array<{ q: string; ts: string }>;  // capped at 20
    lastBookingId?: string;
  };
  flags: {
    hostileSentimentEvents: number;
    consecutiveFailures: number;  // for handoff trigger
  };
}
```

### 4.3 Websocket event schema for tool chips

Channel: `assistant:{requestId}` (single channel per turn, reduces subscription churn).

Events:
```ts
type AgentEvent =
  | { type: 'tool_start'; name: string; argsSummary: string; ts: number }
  | { type: 'tool_done'; name: string; durationMs: number; summary: string; ts: number }
  | { type: 'tool_error'; name: string; message: string; ts: number }
  | { type: 'token'; text: string; ts: number }                       // streaming
  | { type: 'final'; replyId: string; ts: number };                   // marker
```

### 4.4 Eval harness layout

```
server/src/modules/chat/agent/evals/
  fixtures/
    en/booking-coorg-stay.json
    hi/cancel-with-confirmation.json
    te/onboarding-photographer.json
    ...
  run-evals.ts            # CLI: npm run eval:assistant
  judge.ts                # LLM-as-judge with rubric
  baseline.json           # current scores per fixture
  report.html.tpl         # human-readable diff
```

Fixture shape:
```json
{
  "id": "coorg-stay-under-4k-en",
  "lang": "en",
  "turns": [
    { "user": "homestay in coorg under 4k for next weekend?" }
  ],
  "rubric": {
    "mustCallTool": ["searchListings"],
    "mustNotInvent": ["listingId", "price"],
    "mustReferenceFromContext": true,
    "maxToolTurns": 4
  }
}
```

## 5. Resolved decisions (was: open questions)

All eight resolved 2026-05-08:

1. **State location**: Postgres for memory, Redis for in-flight turn state + tool result cache, DynamoDB for audit log. ✅
2. **SDK for tool-calling**: Stay on `@google/genai` (Gemini) for v1. ✅
3. **Voice languages**: Ship ALL languages from v1. **Auto-detect language per turn** — agent detects the language of the user's most recent message and replies in that language. The header language dropdown is for UI chrome only; it is NOT a signal for the agent. The agent must mid-conversation switch if the user switches (e.g. user opens in English, mid-chat switches to Tamil → agent continues in Tamil). System prompt includes an explicit detection + mirroring instruction. ✅
4. **Streaming protocol**: Reuse the existing websocket realtime provider; SSE not needed. ✅
5. **Confirmation UI**: Separate sibling cards in Phase 2 (don't break current `BookingConfirmCard` flow); generalize later. ✅
6. **Grounding fuzzy-match**: Case-insensitive whole-word match scoped to this turn's tool results. ✅
7. **Speculative execution**: Audit log treats speculative calls as "intent". ✅
8. **Memory write conflicts**: Optimistic locking on `updated_at`; merge on conflict. ✅

## 5b. Original risks (kept for reference)

1. **Conversation state location**: Postgres (durable, easy joins) vs Redis (cheap, ephemeral) vs DynamoDB (already used for audit). Recommendation: Postgres for memory (small, queryable), Redis for in-flight turn state and tool result cache, DynamoDB for audit log. Confirm with infra owner.
2. **SDK choice for tool-calling**: stay on `@google/genai` (consistent with Live voice, single auth path) vs migrate the text path to `@anthropic-ai/sdk` for richer tool-use semantics + prompt caching. Recommendation: stay on Gemini for v1; revisit only if eval scores plateau.
3. **Voice languages for v1**: Live native-audio auto-detects but quality varies. Recommendation: ship voice for `en, hi, hinglish` first; gate `te/ta/kn/ml/mr` behind a flag until per-language eval passes.
4. **Tool-call streaming protocol**: SSE vs websocket. The websocket realtime provider already exists; reusing it avoids a new transport. Confirm it supports per-request ephemeral channels.
5. **Confirmation UI for `messageHost`/`cancelBooking`**: do we reuse `BookingConfirmCard.tsx`'s pattern (separate sibling cards) or generalize into a `<ConfirmationCard>` primitive? Recommendation: separate cards in Phase 2, generalize once we see all three side-by-side.
6. **Grounding check fuzzy-match threshold**: false positives on common words like "Taj" (substring match against listing names). Need to tune; start with case-insensitive whole-word match scoped to listings the agent received this turn.
7. **Speculative execution privacy**: speculative `searchListings` runs with the same auth context, but logs may show searches the user didn't actually intend. Confirm audit-log policy treats speculative tool calls as "intent" not "user action".
8. **Memory write conflict on concurrent voice + text turns**: rare but possible. Use optimistic locking on `updated_at`; on conflict, re-read and merge.

## 6. Explicitly NOT in v1

- Async background agent jobs (Bull queue tasks like "watch for price drop on this listing"). Future work.
- Proactive notifications ("hey, the homestay you liked just lowered prices"). Requires push infra + opt-in flow.
- OpenSearch-backed semantic listing search. Current Postgres `searchListings` is fine; revisit when listing count > 50k.
- Multi-listing batch booking (one cart with hotel + transport). Each booking still goes through its own `prepareBooking` call.
- Long-term episodic memory beyond the 4KB JSON. No vector DB in v1.
- Self-improving prompt loops (auto-update system prompt from eval failures).
- Cross-user knowledge ("most users booked X this week"). Privacy review required.
- Fine-tuning a custom Gemini model. Stay with off-the-shelf + prompting.

## 7. Suggested execution order summary

1. **Week 1–2**: Phase 1 (tool loop, read-only tools).
2. **Week 3–4**: Phase 2 (state-changing tools, onboarding agent, locale move).
3. **Week 5**: Phase 3 (voice + barge-in).
4. **Week 6**: Phase 4 (memory + grounding).
5. **Week 7**: Phase 5 (speculative + streaming + chips).
6. **Week 8**: Phase 6 (evals + observability) — can partially overlap with earlier phases for eval fixtures.

Each phase is gated on its acceptance criteria + a green eval run (where the eval harness exists).
