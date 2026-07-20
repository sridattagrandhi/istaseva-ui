// design/api/voice.ts — voice I/O for the Ista AI assistant.
//  • TTS (speak replies) via expo-speech — works in Expo Go + dev builds.
//  • STT (dictate input) via @react-native-voice/voice — native module, dev
//    build only (iOS/Android), needs mic + speech-recognition permissions
//    (declared in app.json).
// Both are loaded defensively (require, not import) so a missing module /
// permission never crashes the app or breaks typecheck before `npm install`.
import { useCallback, useEffect, useState } from "react";

let Speech: any = null;
try { Speech = require("expo-speech"); } catch (e) { Speech = null; console.warn("[voice] expo-speech require failed:", e); }
let Voice: any = null;
try { Voice = require("@react-native-voice/voice").default ?? require("@react-native-voice/voice"); } catch (e) { Voice = null; console.warn("[voice] @react-native-voice require failed:", e); }

export const ttsAvailable = !!Speech;
export const sttAvailable = !!Voice;
console.log("[voice] availability:", { ttsAvailable, sttAvailable });

/** Speak text aloud (interrupts any current speech). No-op if TTS unavailable. */
export function speak(text: string, lang = "en-IN") {
  if (!Speech || !text) { console.log("[voice] speak skipped", { hasSpeech: !!Speech, hasText: !!text }); return; }
  try {
    Speech.stop();
    Speech.speak(text, {
      language: lang,
      rate: 1.0,
      pitch: 1.0,
      onStart: () => console.log("[voice] TTS started"),
      onDone: () => console.log("[voice] TTS done"),
      onError: (err: any) => console.warn("[voice] TTS error:", err),
    });
  } catch (e) { console.warn("[voice] speak threw:", e); }
}

export function stopSpeaking() {
  try { Speech?.stop(); } catch {}
}

/**
 * Mic dictation hook. `onResult` fires with the recognized text when the user
 * stops speaking. `available` is false when the native STT module isn't present
 * (e.g. Expo Go) — callers should hide the mic button in that case.
 */
export function useDictation(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!Voice) return;
    // PRIVACY: never log transcript content outside dev builds (SEC-013).
    Voice.onSpeechResults = (e: any) => { if (__DEV__) console.log("[voice] STT results:", e?.value); const t = e?.value?.[0]; if (t) onResult(t); };
    Voice.onSpeechPartialResults = (e: any) => { if (__DEV__) console.log("[voice] STT partial:", e?.value); };
    Voice.onSpeechStart = () => console.log("[voice] STT started");
    Voice.onSpeechEnd = () => { console.log("[voice] STT ended"); setListening(false); };
    Voice.onSpeechError = (e: any) => { console.warn("[voice] STT error:", JSON.stringify(e?.error ?? e)); setListening(false); };
    return () => {
      try { Voice.destroy().then(() => Voice.removeAllListeners?.()); } catch {}
    };
  }, [onResult]);

  const start = useCallback(async () => {
    if (!Voice) { console.warn("[voice] STT start: Voice module missing"); return; }
    try {
      const avail = await Voice.isAvailable?.();
      console.log("[voice] STT isAvailable:", avail);
      setListening(true);
      await Voice.start("en-IN");
      console.log("[voice] STT start() resolved");
    } catch (e) { console.warn("[voice] STT start threw:", e); setListening(false); }
  }, []);

  const stop = useCallback(async () => {
    if (!Voice) return;
    try { await Voice.stop(); } catch {}
    setListening(false);
  }, []);

  return { listening, start, stop, available: !!Voice };
}
