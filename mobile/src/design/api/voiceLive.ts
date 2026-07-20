// design/api/voiceLive.ts — LIVE voice for the Ista AI assistant (mobile).
//
// This is the mobile port of the web hook src/hooks/useGeminiLiveVoice.ts. It
// opens a WebSocket to the SAME server endpoint (/ws/voice), which proxies to
// Gemini Live (Vertex AI). The wire format mirrors server/.../voice-live.service.ts
// EXACTLY — any protocol change must be made in all three places (server, web
// hook, this file).
//
// Wire format (recap):
//   → client: { type: 'audio', data: <base64 16kHz 16-bit PCM mono> }
//   → client: { type: 'text',  text }       // typed turn during a voice session
//   → client: { type: 'end' }               // graceful close
//   ← server: { type: 'ready' }
//   ← server: { type: 'audio', data: <base64 24kHz 16-bit PCM mono> }
//   ← server: { type: 'user_transcript' | 'assistant_transcript' | 'text', text }
//   ← server: { type: 'turn_complete' | 'interrupted' }
//   ← server: { type: 'tool_start' | 'tool_done' | 'tool_error', ... }
//   ← server: { type: 'ui_action', action, params }
//   ← server: { type: 'error', message }
//
// WHY an injected audio adapter: React Native has no Web Audio API (AudioContext,
// getUserMedia, ScriptProcessor). The mic→PCM capture and 24kHz PCM playback must
// come from native modules. We keep that behind `VoiceAudioIO` so THIS file stays
// dependency-free, compiles + unit-tests without any native lib installed, and the
// native bits live in voiceAudioIO.ts (loaded defensively, like api/voice.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { auth } from "../../lib/firebase";
import { api } from "../../lib/api";
import { config } from "../../lib/config";

export type LiveVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "permission_denied"
  | "error";

/**
 * Native audio I/O contract. An implementation captures mic audio as base64
 * 16kHz mono Int16 PCM frames and plays back base64 24kHz mono Int16 PCM chunks
 * gaplessly. See voiceAudioIO.ts for the concrete (native-module) implementation.
 */
export interface VoiceAudioIO {
  /** Begin mic capture. `onFrame` receives base64 16kHz mono Int16 PCM chunks.
   *  Reject with a `PermissionError` (name === 'PermissionError') when the user
   *  denies mic access, so the hook can surface a distinct retry CTA. */
  startCapture(onFrame: (base64Pcm: string) => void): Promise<void>;
  /** Stop mic capture (keeps playback alive). */
  stopCapture(): void;
  /** Queue a base64 24kHz PCM chunk for gapless playback. */
  enqueuePlayback(base64Pcm: string): void;
  /** Stop + flush everything currently/soon playing (barge-in / `interrupted`). */
  cancelPlayback(): void;
  /** Release all audio resources. */
  dispose(): void;
}

export interface LiveVoiceCallbacks {
  onUserTranscript?: (chunk: string) => void;
  onAssistantTranscript?: (chunk: string) => void;
  onTurnComplete?: () => void;
  onToolStart?: (e: { name: string; argsSummary: string }) => void;
  onToolDone?: (e: { name: string; durationMs: number; summary: string }) => void;
  onToolError?: (e: { name: string; message: string }) => void;
  onUiAction?: (e: { action: string; params?: Record<string, unknown> }) => void;
}

export interface LiveVoiceOptions {
  mode?: "sathi" | "onboarding";
  entry?: "host" | "service" | "transport" | "any";
}

/**
 * Build the /ws/voice URL from the mobile API base. http→ws, https→wss, strip
 * any trailing slash, append the connect ticket + mode + entry. Pure + exported
 * so it can be unit-tested without a device.
 *
 * SEC-008: the query string carries a single-use short-lived ticket (minted
 * via POST /api/auth/ws-ticket), never the Firebase bearer token — URLs leak
 * into access logs and proxies.
 */
export function voiceWsUrl(
  apiBaseUrl: string,
  ticket: string,
  mode: "sathi" | "onboarding" = "sathi",
  entry: string = "any",
): string {
  const wsBase = apiBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
  return `${wsBase}/ws/voice?ticket=${encodeURIComponent(ticket)}&mode=${mode}&entry=${entry}`;
}

/**
 * Live voice hook. Pass a `VoiceAudioIO` (the native adapter); the hook owns the
 * WS lifecycle, protocol, and state machine. Returns { state, lastError, start,
 * stop, sendText }. `start()` connects + begins capture; `stop()` tears down.
 */
export function useVoiceLive(
  audio: VoiceAudioIO | null,
  callbacks?: LiveVoiceCallbacks,
  options?: LiveVoiceOptions,
) {
  const [state, setState] = useState<LiveVoiceState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  // Mirror latest callbacks/options in refs so ws.onmessage doesn't need
  // re-binding when the parent re-renders with new closures.
  const cbRef = useRef(callbacks);
  useEffect(() => { cbRef.current = callbacks; }, [callbacks]);
  const optRef = useRef(options);
  useEffect(() => { optRef.current = options; }, [options]);

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<LiveVoiceState>("idle");
  const setBoth = (s: LiveVoiceState) => { stateRef.current = s; setState(s); };

  const stop = useCallback(() => {
    try { wsRef.current?.send(JSON.stringify({ type: "end" })); } catch { /* closed */ }
    try { wsRef.current?.close(); } catch { /* closed */ }
    wsRef.current = null;
    try { audio?.stopCapture(); } catch { /* noop */ }
    try { audio?.cancelPlayback(); } catch { /* noop */ }
    setBoth("idle");
  }, [audio]);

  const start = useCallback(async () => {
    if (!audio) { setLastError("voice audio unavailable on this build"); setBoth("error"); return; }
    setLastError(null);
    setBoth("connecting");
    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      // SEC-008: mint a single-use connect ticket over authenticated HTTPS
      // (the api client injects the bearer token as a header) instead of
      // putting the token itself in the WS URL.
      const { data: ticketData } = await api.post<{ ticket?: string }>("/api/auth/ws-ticket");
      const ticket = ticketData?.ticket;
      if (!ticket) throw new Error("Not signed in");

      const mode = optRef.current?.mode === "onboarding" ? "onboarding" : "sathi";
      const entry = optRef.current?.entry ?? "any";
      const url = voiceWsUrl(config.apiBaseUrl, ticket, mode, entry);

      console.log("[voiceLive] connecting to", url.replace(/ticket=[^&]+/, "ticket=***"));
      const ws = new WebSocket(url);
      wsRef.current = ws;

      // Attach handlers synchronously — the open event can fire before the
      // async mic-permission prompt resolves; binding later loses it and the
      // UI hangs on "connecting" (same trap documented in the web hook).
      ws.onopen = () => { console.log("[voiceLive] ws OPEN → listening"); setBoth("listening"); };
      ws.onerror = (e: any) => { console.log("[voiceLive] ws ERROR", e?.message ?? e); setLastError((p) => p ?? "connection error"); setBoth("error"); };
      ws.onclose = (evt: any) => {
        console.log("[voiceLive] ws CLOSE code=", evt?.code, "reason=", evt?.reason);
        const reason = typeof evt?.reason === "string" ? evt.reason : "";
        if (evt?.code === 1011 || reason) {
          const mapped =
            reason === "voice_unavailable" ? "Voice isn't enabled on this environment yet."
            : reason === "unauthenticated" ? "Your session expired — please sign in again."
            : reason || "connection error";
          // Only override to error if we weren't already idle-by-user-stop.
          if (stateRef.current !== "idle") { setLastError(mapped); setBoth("error"); }
          return;
        }
        if (stateRef.current !== "error" && stateRef.current !== "permission_denied") setBoth("idle");
      };
      ws.onmessage = (evt: any) => {
        let msg: any;
        try { msg = JSON.parse(evt.data); } catch { return; }
        const cb = cbRef.current;
        // PRIVACY: log message TYPE only in release; text/transcript content is dev-only (SEC-013).
        if (msg.type !== "audio") {
          if (__DEV__) console.log("[voiceLive] ⟵ server msg:", msg.type, msg.text ?? msg.message ?? "");
        }
        switch (msg.type) {
          case "audio":
            if (typeof msg.data === "string") { audio.enqueuePlayback(msg.data); setBoth("speaking"); }
            break;
          case "turn_complete":
            setBoth("listening");
            try { cb?.onTurnComplete?.(); } catch { /* consumer */ }
            break;
          case "interrupted":
            audio.cancelPlayback();
            setBoth("listening");
            break;
          case "error":
            setLastError(msg.message || "upstream error"); setBoth("error");
            break;
          case "user_transcript":
            if (typeof msg.text === "string") try { cb?.onUserTranscript?.(msg.text); } catch { /* noop */ }
            break;
          case "assistant_transcript":
          case "text":
            if (typeof msg.text === "string") try { cb?.onAssistantTranscript?.(msg.text); } catch { /* noop */ }
            break;
          case "tool_start":
            if (typeof msg.name === "string") try { cb?.onToolStart?.({ name: msg.name, argsSummary: msg.argsSummary || "" }); } catch { /* noop */ }
            break;
          case "tool_done":
            if (typeof msg.name === "string") try { cb?.onToolDone?.({ name: msg.name, durationMs: msg.durationMs || 0, summary: msg.summary || "" }); } catch { /* noop */ }
            break;
          case "tool_error":
            if (typeof msg.name === "string") try { cb?.onToolError?.({ name: msg.name, message: msg.message || "" }); } catch { /* noop */ }
            break;
          case "ui_action":
            if (typeof msg.action === "string") try { cb?.onUiAction?.({ action: msg.action, params: msg.params }); } catch { /* noop */ }
            break;
          default:
            break; // ready / unknown — no-op
        }
      };

      // Begin mic capture → stream PCM frames up. Only send while the socket is
      // open; frames captured during connect are dropped (matches web).
      let frames = 0;
      await audio.startCapture((b64) => {
        const sock = wsRef.current;
        const open = sock && sock.readyState === WebSocket.OPEN;
        frames++;
        if (frames === 1) console.log("[voiceLive] first mic frame captured, ws open?", !!open);
        else if (frames % 100 === 0) console.log("[voiceLive] mic frames sent:", frames);
        if (open) {
          try { sock!.send(JSON.stringify({ type: "audio", data: b64 })); } catch { /* dropped */ }
        }
      });
      console.log("[voiceLive] startCapture returned (mic running)");
    } catch (err: any) {
      if (err?.name === "PermissionError") {
        setLastError("microphone permission denied"); setBoth("permission_denied");
      } else {
        setLastError(err?.message || "failed to start voice"); setBoth("error");
      }
      stop();
    }
  }, [audio, stop]);

  // Type a turn mid-voice-session (e.g. user taps to type instead of speak).
  const sendText = useCallback((text: string): boolean => {
    const t = text.trim();
    const ws = wsRef.current;
    if (!t || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify({ type: "text", text: t })); return true; } catch { return false; }
  }, []);

  useEffect(() => () => { stop(); audio?.dispose(); }, [stop, audio]);

  return { state, lastError, start, stop, sendText };
}
