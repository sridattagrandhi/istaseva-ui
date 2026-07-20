// design/api/voiceAudioIO.ts — native audio adapter for live voice (VoiceAudioIO).
//
// CAPTURE: react-native-live-audio-stream emits base64 16kHz Int16 PCM — exactly
//   the frame format /ws/voice expects, no transcoding on the way up.
// PLAYBACK: the server streams base64 24kHz Int16 PCM chunks. RN has no Web
//   Audio, so each chunk is WAV-wrapped (see pcmWav.ts) and played via expo-av,
//   chunks chained sequentially. This is the pragmatic v1 — functional, but
//   per-chunk Sound load adds latency and small gaps between chunks. If voice
//   quality is rough, the upgrade is a native PCM ring-buffer player (AudioTrack
//   / AVAudioEngine) — swap it in behind this same interface.
//
// ⚠️ NOT verifiable off-device. Requires `npx expo prebuild` + a dev-client
// build, a real device, mic permission, and a backend with the Vertex SA set so
// /ws/voice is enabled. Known on-device risks to watch:
//   - No acoustic echo cancellation on capture → the model may hear its own
//     playback and self-interrupt (server VAD drives barge-in). If replies cut
//     off, that's the cause — needs AEC or push-to-talk.
//   - iOS requires the PlayAndRecord audio session (set via setAudioModeAsync).
//
// All native modules load via defensive require (mirrors api/voice.ts) so a
// missing install never breaks typecheck — `liveVoiceAudioAvailable` reports
// false and the UI hides the live-voice button.
import type { VoiceAudioIO } from "./voiceLive";
import { pcmToWavBase64 } from "./pcmWav";

let LiveAudioStream: any = null;
try {
  LiveAudioStream = require("react-native-live-audio-stream").default
    ?? require("react-native-live-audio-stream");
} catch {
  LiveAudioStream = null;
}

let ExpoAV: any = null;
try { ExpoAV = require("expo-av"); } catch { ExpoAV = null; }
const Audio: any = ExpoAV?.Audio ?? null;

/** True when BOTH mic capture and playback modules are present. */
export const liveVoiceAudioAvailable = !!LiveAudioStream && !!Audio;

export class PermissionError extends Error {
  constructor(msg = "microphone permission denied") {
    super(msg);
    this.name = "PermissionError";
  }
}

/**
 * Concrete VoiceAudioIO backed by react-native-live-audio-stream (capture) and
 * expo-av (playback). Returns null when either native module is missing.
 */
export function createVoiceAudioIO(): VoiceAudioIO | null {
  if (!LiveAudioStream || !Audio) return null;

  let capturing = false;
  // Playback queue: base64 PCM chunks played one after another. `playing`
  // guards the pump so chunks don't overlap; `current` is the live Sound so
  // cancelPlayback (barge-in) can stop it immediately.
  let queue: string[] = [];
  let playing = false;
  let current: any = null;

  const pump = async () => {
    if (playing) return;
    const next = queue.shift();
    if (next == null) return;
    playing = true;
    try {
      const wav = pcmToWavBase64(next, 24000, 1, 16);
      const { sound } = await Audio.Sound.createAsync(
        { uri: "data:audio/wav;base64," + wav },
        { shouldPlay: true },
      );
      current = sound;
      sound.setOnPlaybackStatusUpdate((st: any) => {
        if (st?.didJustFinish) {
          sound.unloadAsync?.().catch(() => undefined);
          if (current === sound) current = null;
          playing = false;
          void pump();
        }
      });
    } catch {
      playing = false;
      void pump();
    }
  };

  return {
    async startCapture(onFrame: (b64: string) => void) {
      console.log("[voiceAudioIO] startCapture: liveAudioStream?", !!LiveAudioStream, "audio?", !!Audio);
      // Mic permission — expo-av owns the request on both platforms.
      if (Audio.requestPermissionsAsync) {
        const res = await Audio.requestPermissionsAsync();
        console.log("[voiceAudioIO] mic permission:", res?.status);
        if (res?.status && res.status !== "granted") throw new PermissionError();
      }
      // iOS: PlayAndRecord session so we can capture + play simultaneously and
      // still output through the speaker with the ring/silent switch on.
      try {
        await Audio.setAudioModeAsync?.({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
      } catch { /* non-fatal */ }

      // 16kHz mono 16-bit — must match the server's MIC_RATE.
      // audioSource 6 = VOICE_RECOGNITION on Android (tuned for speech).
      LiveAudioStream.init({
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        audioSource: 6,
        bufferSize: 4096,
      });
      LiveAudioStream.on("data", (b64: string) => {
        if (capturing && typeof b64 === "string" && b64.length) onFrame(b64);
      });
      capturing = true;
      try {
        LiveAudioStream.start();
        console.log("[voiceAudioIO] LiveAudioStream.start() OK");
      } catch (e: any) {
        console.log("[voiceAudioIO] LiveAudioStream.start() THREW:", e?.message ?? e);
        throw e;
      }
    },

    stopCapture() {
      capturing = false;
      try { LiveAudioStream.stop(); } catch { /* noop */ }
    },

    enqueuePlayback(b64: string) {
      if (typeof b64 === "string" && b64.length) {
        queue.push(b64);
        void pump();
      }
    },

    cancelPlayback() {
      queue = [];
      const s = current;
      current = null;
      playing = false;
      if (s) {
        s.stopAsync?.().catch(() => undefined);
        s.unloadAsync?.().catch(() => undefined);
      }
    },

    dispose() {
      this.stopCapture();
      this.cancelPlayback();
      try { LiveAudioStream.removeAllListeners?.("data"); } catch { /* noop */ }
    },
  };
}
