/**
 * Gemini Live voice hook — streams mic audio to /ws/voice on our server
 * (which proxies to Vertex AI Live API) and plays back the model's audio.
 *
 * Keep this as the single canonical voice pipeline; do NOT sprinkle mic /
 * AudioContext code elsewhere in the app. Hidden dragons in web audio:
 *   - AudioContext sampleRate is advisory — we set 16000 but Chrome may
 *     open it at 48000 and resample internally. Fine for prototype quality.
 *   - Script processor is deprecated but still the most compatible path.
 *     If voice quality is rough we can swap in AudioWorklet later.
 *   - Playback chunks must be queued into a single rolling start time;
 *     calling start(0) on each chunk creates audible gaps / overlaps.
 *
 * Wire format mirrors voice-live.service.ts exactly; any changes must be
 * made in both places.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { frontendConfig } from "@/config/frontend";
import { apiRequest } from "@/lib/api-client";

export type LiveVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "permission_denied"
  | "error";

const MIC_RATE = 16000;
const OUTPUT_RATE = 24000; // Gemini native-audio emits 24kHz


/** Optional callbacks consumers can register to receive transcripts as
 *  they stream in from the Live API. Each chunk is incremental — append
 *  to whatever message you're building rather than overwriting. */
export interface LiveVoiceCallbacks {
  /** Fired with chunks of what the user just said (their voice → text). */
  onUserTranscript?: (chunk: string) => void;
  /** Fired with chunks of Sathi's spoken reply (audio → text). */
  onAssistantTranscript?: (chunk: string) => void;
  /** Fired once when the model finishes a turn — useful as a "flush"
   *  signal to commit any in-progress assistant transcript message. */
  onTurnComplete?: () => void;
  /** Fired when the user's whole utterance came back unintelligible (bad
   *  audio / Vertex misfire) — prompt them to repeat instead of silently
   *  dropping it. */
  onNeedsRepeat?: () => void;
  /** Tool the voice agent is starting (search, navigate, etc.) — render
   *  a chip in the UI while it runs. */
  onToolStart?: (event: { name: string; argsSummary: string }) => void;
  /** Tool finished — collapse the chip with the result summary. */
  onToolDone?: (event: { name: string; durationMs: number; summary: string }) => void;
  /** Tool errored. */
  onToolError?: (event: { name: string; message: string }) => void;
  /** Voice agent is asking the UI to do something (navigate, etc.). */
  onUiAction?: (event: { action: string; params?: Record<string, unknown> }) => void;
  /** Onboarding-only: agent extracted profile fields. Merge into local state. */
  onProfileUpdate?: (patch: Record<string, unknown>) => void;
  /** Onboarding-only: agent wants the picker (date, photos, location, etc.) shown. */
  onPickerAction?: (action: string) => void;
  /** Onboarding-only: profile is complete and ready for confirmation/preview. */
  onSubmitReady?: (profile: Record<string, unknown>) => void;
}

export interface LiveVoiceOptions {
  /** 'sathi' (assistant) or 'onboarding'. Defaults to 'sathi'. */
  mode?: "sathi" | "onboarding";
  /** Onboarding-only: which portal the user walked in through. The voice
   *  agent uses this to frame its first turn and decide when to suggest
   *  switching portals. Defaults to 'any'. */
  entry?: "host" | "service" | "transport" | "any";
  /** Onboarding-only: seed profile sent to the server so the voice agent
   *  sees what's already filled (manual form, prior AI text turn) before
   *  its first reply. */
  initialProfile?: Record<string, unknown>;
}

export function useGeminiLiveVoice(callbacks?: LiveVoiceCallbacks, options?: LiveVoiceOptions) {
  const [state, setState] = useState<LiveVoiceState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  // Mirror the latest callback set in a ref so we don't have to re-bind
  // ws.onmessage every time the parent re-renders with new closures.
  const callbacksRef = useRef<LiveVoiceCallbacks | undefined>(callbacks);
  useEffect(() => { callbacksRef.current = callbacks; }, [callbacks]);

  // Same trick for options — start() is memoized once, but the latest mode
  // should still apply when start fires.
  const optionsRef = useRef<LiveVoiceOptions | undefined>(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackCursorRef = useRef<number>(0);
  // Phase 3 barge-in: track playing buffer sources so we can stop them
  // immediately on local VAD trigger. Without this, scheduled-but-not-yet-
  // playing chunks would still come out before upstream catches up.
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const playbackStartedAtRef = useRef<number>(0);
  // Latest state without re-binding the audio callback every render.
  const stateRef = useRef<LiveVoiceState>("idle");

  const stop = useCallback(() => {
    try { wsRef.current?.send(JSON.stringify({ type: "end" })); } catch { /* closed */ }
    try { wsRef.current?.close(); } catch { /* closed */ }
    wsRef.current = null;

    try { processorRef.current?.disconnect(); } catch { /* noop */ }
    processorRef.current = null;
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    sourceRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    try { void audioCtxRef.current?.close(); } catch { /* noop */ }
    audioCtxRef.current = null;

    playbackCursorRef.current = 0;
    activeSourcesRef.current.clear();
    stateRef.current = "idle";
    setState("idle");
  }, []);

  // Stop everything currently playing AND drop the playback cursor so any
  // chunks that arrive in the next few ms before upstream catches up
  // don't get queued. Called both on local VAD trigger and on the
  // upstream `interrupted` event.
  const cancelPlayback = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current.clear();
    playbackCursorRef.current = ctx.currentTime;
  }, []);

  const start = useCallback(async () => {
    setLastError(null);
    setState("connecting");

    try {
      // SEC-008: mint a single-use connect ticket over authenticated HTTPS
      // instead of putting the bearer token in the WS URL (query strings
      // leak into access logs and proxies).
      const ticketRes = await apiRequest<{ ticket?: string }>("/api/auth/ws-ticket", {
        method: "POST",
      });
      const ticket = ticketRes.success ? ticketRes.data?.ticket : undefined;
      if (!ticket) throw new Error("Not signed in");

      // Build /ws/voice URL from the realtime base (which is /ws).
      // The URL shape is intentionally identical to the customer-side
      // (mode=sathi) flow — same params, no profile blob. The host-side /
      // onboarding flow used to base64-stuff the entire `initialProfile`
      // into a `&profile=` query param, which (a) added a path the
      // working sathi flow never exercises and (b) blew past the
      // CloudFront / ALB query-string limits as soon as the host had
      // entered a few fields, surfacing as a generic "connection error".
      // We now seed the profile post-connect via the existing
      // `profile_sync` message-channel that the server already merges
      // into voiceCtx.profile (see voice-live.service.ts line ~672).
      const baseWs = frontendConfig.realtime.wsUrl;
      const mode = optionsRef.current?.mode === "onboarding" ? "onboarding" : "sathi";
      const entry = optionsRef.current?.entry ?? "any";
      const voiceUrl = `${baseWs.replace(/\/ws$/, "")}/ws/voice?ticket=${encodeURIComponent(ticket)}&mode=${mode}&entry=${entry}`;

      const ws = new WebSocket(voiceUrl);
      wsRef.current = ws;

      // CRITICAL: attach WS event handlers SYNCHRONOUSLY before any
      // awaits below. `new WebSocket()` starts connecting immediately,
      // and on a fast network the open event can fire BEFORE the
      // permission prompt + audio setup complete (~1-2s). Attaching
      // onopen later loses the event and leaves the UI stuck on
      // "connecting" forever even though the upstream is healthy.
      // Audio piping is wired up later (after getUserMedia) but the
      // state-transition handlers must be attached up front.
      ws.onopen = () => {
        setState("listening");
        stateRef.current = "listening";
        // Seed the server-side voice agent with whatever fields the host
        // has already filled. We do this here (instead of via the URL)
        // because the upgrade request must stay small — see the comment
        // above on URL shape. The server merges this into voiceCtx.profile
        // so subsequent extract_fields / submit_listing calls see fresh
        // state. Wrapped in a try because malformed initialProfile (e.g.
        // circular refs from React state) shouldn't crash the session.
        const initial = optionsRef.current?.initialProfile;
        if (mode === "onboarding" && initial && Object.keys(initial).length > 0) {
          try {
            ws.send(JSON.stringify({ type: "profile_sync", profile: initial }));
          } catch { /* dropped — onboarding still works, agent may re-ask */ }
        }
      };
      ws.onerror = () => {
        setLastError((prev) => prev ?? "connection error");
        setState("error");
        stateRef.current = "error";
      };
      ws.onclose = (evt) => {
        // Map server-side rejection reasons (set by the /ws/voice handshake
        // gate) into something the UI can show. Without this, a missing
        // server-side Vertex config or expired token reads as a generic
        // "connection error" with no fix-it hint.
        if (evt.code === 1011 || (evt.reason && !evt.wasClean)) {
          const reason = evt.reason || "connection error";
          const mapped =
            reason === "voice_unavailable"
              ? "Voice is not enabled on this environment yet."
              : reason === "unauthenticated"
                ? "Your session expired. Please sign in again."
                : reason;
          setLastError(mapped);
          setState("error");
          stateRef.current = "error";
          return;
        }
        setState((prev) => {
          const next = prev === "error" || prev === "permission_denied" ? prev : "idle";
          stateRef.current = next;
          return next;
        });
      };
      ws.onmessage = (evt) => {
        let msg: any;
        try { msg = JSON.parse(evt.data); } catch { return; }

        if (msg.type === "audio" && typeof msg.data === "string") {
          playPcmChunk(msg.data);
          setState("speaking");
          stateRef.current = "speaking";
        } else if (msg.type === "turn_complete") {
          setState("listening");
          stateRef.current = "listening";
          // Signal the consumer to commit the in-progress assistant
          // message so the next turn starts a fresh bubble.
          try { callbacksRef.current?.onTurnComplete?.(); } catch { /* consumer's problem */ }
        } else if (msg.type === "needs_repeat") {
          try { callbacksRef.current?.onNeedsRepeat?.(); } catch { /* noop */ }
        } else if (msg.type === "interrupted") {
          cancelPlayback();
          setState("listening");
          stateRef.current = "listening";
        } else if (msg.type === "error") {
          setLastError(msg.message || "upstream error");
          setState("error");
          stateRef.current = "error";
        } else if (msg.type === "user_transcript" && typeof msg.text === "string") {
          // Vertex emits incremental chunks; consumer appends.
          try { callbacksRef.current?.onUserTranscript?.(msg.text); } catch { /* noop */ }
        } else if ((msg.type === "assistant_transcript" || msg.type === "text") && typeof msg.text === "string") {
          try { callbacksRef.current?.onAssistantTranscript?.(msg.text); } catch { /* noop */ }
        } else if (msg.type === "tool_start" && typeof msg.name === "string") {
          try { callbacksRef.current?.onToolStart?.({ name: msg.name, argsSummary: msg.argsSummary || "" }); } catch { /* noop */ }
        } else if (msg.type === "tool_done" && typeof msg.name === "string") {
          try { callbacksRef.current?.onToolDone?.({ name: msg.name, durationMs: msg.durationMs || 0, summary: msg.summary || "" }); } catch { /* noop */ }
        } else if (msg.type === "tool_error" && typeof msg.name === "string") {
          try { callbacksRef.current?.onToolError?.({ name: msg.name, message: msg.message || "" }); } catch { /* noop */ }
        } else if (msg.type === "ui_action" && typeof msg.action === "string") {
          try { callbacksRef.current?.onUiAction?.({ action: msg.action, params: msg.params }); } catch { /* noop */ }
        } else if (msg.type === "profile_update" && msg.profile && typeof msg.profile === "object") {
          // Server sends the FULL merged profile under msg.profile (see
          // voice-live.service.ts handleVoiceToolCalls). We were checking
          // for msg.patch which never existed — that's why the captured-
          // fields strip stayed empty even though extract_fields ran fine
          // server-side. Treat the merged profile as the patch since
          // setProfile(prev => ({...prev, ...patch})) is idempotent.
          try { callbacksRef.current?.onProfileUpdate?.(msg.profile as Record<string, unknown>); } catch { /* noop */ }
        } else if (msg.type === "picker_action" && typeof msg.action === "string") {
          try { callbacksRef.current?.onPickerAction?.(msg.action); } catch { /* noop */ }
        } else if (msg.type === "submit_ready" && msg.profile && typeof msg.profile === "object") {
          try { callbacksRef.current?.onSubmitReady?.(msg.profile as Record<string, unknown>); } catch { /* noop */ }
        }
      };

      const AudioContextCtor: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextCtor({ sampleRate: MIC_RATE });
      audioCtxRef.current = ctx;
      try { await ctx.resume(); } catch { /* browser may resume on first playback */ }
      playbackCursorRef.current = ctx.currentTime;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (ev) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const f32 = ev.inputBuffer.getChannelData(0);

        // Barge-in is handled exclusively by Vertex's server-side VAD via
        // the `interrupted` event (see ws.onmessage). The previous local
        // RMS check fired false positives from the model's own playback
        // bleed past getUserMedia echoCancellation, cancelling AI replies
        // ~750ms in — the user heard "AI voice cuts off as soon as the
        // mic is listening." Server VAD adds 200-500ms barge-in latency
        // but doesn't kill normal replies.

        // Float32 [-1,1] → Int16 LE PCM
        const pcm = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let bin = "";
        // Chunk to avoid "too many arguments" on large buffers in older engines
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, i + 0x8000)) as any,
          );
        }
        ws.send(JSON.stringify({ type: "audio", data: btoa(bin) }));
      };

      source.connect(processor);
      // Connecting to destination is required for onaudioprocess to tick on
      // Safari even though we don't want to hear the mic back. The output
      // node is effectively silent because the processor doesn't write to it.
      processor.connect(ctx.destination);

      // Note: ws.onopen/onclose/onerror/onmessage are attached above,
      // before the awaits, to avoid a race where the WS opens during
      // getUserMedia and the open event is missed.

      function playPcmChunk(b64: string) {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (ctx.state === "suspended") {
          void ctx.resume().catch(() => undefined);
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // 24kHz 16-bit LE PCM mono, per Gemini native-audio spec
        const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const f32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 0x8000;
        const buf = ctx.createBuffer(1, f32.length, OUTPUT_RATE);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const startAt = Math.max(ctx.currentTime, playbackCursorRef.current);
        src.start(startAt);
        if (activeSourcesRef.current.size === 0) {
          playbackStartedAtRef.current = startAt;
        }
        playbackCursorRef.current = startAt + buf.duration;
        // Track this source so cancelPlayback can stop it if the user
        // barges in. Auto-prune from the set when natural playback ends.
        activeSourcesRef.current.add(src);
        src.onended = () => activeSourcesRef.current.delete(src);
      }
    } catch (err: any) {
      // Permission denial gets its own state so the UI can surface a
      // clear retry CTA instead of a generic "error". DOMException's
      // `name` is the canonical surface; don't rely on .message strings.
      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        setLastError("microphone permission denied");
        setState("permission_denied");
        stateRef.current = "permission_denied";
      } else {
        setLastError(err?.message || "failed to start");
        setState("error");
        stateRef.current = "error";
      }
      stop();
      throw err;
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  // Push a profile patch to the live server mid-session. Used by onboarding
  // when the user edits the manual form or comes back from an AI-text turn
  // — the server merges into voiceCtx.profile so the next voice turn sees
  // up-to-date fields and doesn't re-ask them.
  const syncProfile = useCallback((profile: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: "profile_sync", profile })); } catch { /* dropped */ }
  }, []);

  const sendText = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    const ws = wsRef.current;
    if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "text", text: trimmed }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { state, lastError, start, stop, syncProfile, sendText };
}

/**
 * Pre-flight check for mic permission without requesting it. Used by the
 * widget to decide whether auto-starting Live will trigger a permission
 * prompt (which we want to defer until the user expects it). Returns
 * 'granted' | 'denied' | 'prompt' | 'unknown' — 'unknown' means the
 * Permissions API isn't available (older Safari) and we have to find
 * out by trying.
 */
export async function getMicPermissionState(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const perms = (navigator as any).permissions;
    if (!perms?.query) return "unknown";
    const status = await perms.query({ name: "microphone" as PermissionName });
    return status.state as "granted" | "denied" | "prompt";
  } catch {
    return "unknown";
  }
}

/**
 * Live voice is now unconditional for real users. The legacy browser-STT
 * path (webkitSpeechRecognition) hardcodes `recognition.lang` from the app
 * display language and CANNOT auto-detect — so a user speaking Telugu while
 * the app is in English gets their speech mis-transcribed into garbled
 * English, and the assistant then (correctly) replies in English. Gemini
 * Live auto-detects language per utterance, so it's the only correct path.
 *
 * The old `sathi_voice_live = '0'` opt-out used to drop users back to that
 * broken legacy path. That's now a footgun: a stray '0' (or a support
 * article telling users to "disable live voice") silently breaks
 * multilingual input. So the gate is inverted — Live is on for everything
 * EXCEPT an explicit internal debug sentinel.
 *
 * Debug-only escape hatch: `localStorage.sathi_voice_live = 'debug-legacy'`
 * forces the legacy browser-STT path for troubleshooting. Any other value
 * (including '0', '1', absent, or garbage) keeps Live voice on.
 */
export const LEGACY_VOICE_SENTINEL = "debug-legacy";

export function isLiveVoiceEnabled(): boolean {
  try {
    const stored = localStorage.getItem("sathi_voice_live");
    // Self-heal: scrub any stale value left over from the old opt-out
    // (e.g. '0', '1'). Those used to force the broken legacy STT path;
    // now only the explicit debug sentinel does, so a leftover value is
    // both meaningless and a footgun. Remove it so it can't resurface.
    if (stored !== null && stored !== LEGACY_VOICE_SENTINEL) {
      try { localStorage.removeItem("sathi_voice_live"); } catch { /* ignore */ }
      return true;
    }
    return stored !== LEGACY_VOICE_SENTINEL;
  } catch {
    // localStorage access throws in some private-mode browsers — default
    // to Live on rather than silently downgrading every Safari user.
    return true;
  }
}
