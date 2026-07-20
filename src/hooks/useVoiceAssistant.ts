import { useState, useCallback, useRef, useEffect } from "react";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";

export type VoiceState = "idle" | "listening" | "processing" | "speaking";

export interface VoiceConfig {
  inputLang: string;
  outputLang: string;
  displayLang: string;
  autoListen: boolean;
}

const langToBcp47: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", te: "te-IN", ta: "ta-IN",
  kn: "kn-IN", ml: "ml-IN", mr: "mr-IN",
};

// Unicode block → TTS voice code. The server (tts.service.ts) maps these
// BCP-47 codes to real voices. Scripts are mutually exclusive per language
// EXCEPT Devanagari, which Hindi and Marathi share — we can't tell those
// apart by script alone, so Devanagari falls back to the session's known
// output language when it's Marathi, else defaults to Hindi.
const SCRIPT_RANGES: Array<{ lang: string; test: RegExp }> = [
  { lang: "te-IN", test: /[ఀ-౿]/ }, // Telugu
  { lang: "ta-IN", test: /[஀-௿]/ }, // Tamil
  { lang: "kn-IN", test: /[ಀ-೿]/ }, // Kannada
  { lang: "ml-IN", test: /[ഀ-ൿ]/ }, // Malayalam
  { lang: "bn-IN", test: /[ঀ-৿]/ }, // Bengali
  { lang: "gu-IN", test: /[઀-૿]/ }, // Gujarati
  { lang: "DEVA", test: /[ऀ-ॿ]/ },  // Devanagari (Hindi/Marathi)
];

/**
 * Pick the TTS voice language from the REPLY TEXT, not the app display
 * setting. The old code passed `config.outputLang` (driven by the user's
 * app language), so a correct Telugu text reply could still be read aloud
 * in an English voice. We detect the dominant Indian script in the reply
 * and speak in that language; Latin/unknown text falls back to the
 * session's `outputLang` (which is en-IN unless the user picked otherwise).
 */
export function detectTtsLang(text: string, fallback: string): string {
  let best = "";
  let bestCount = 0;
  for (const { lang, test } of SCRIPT_RANGES) {
    const matches = text.match(new RegExp(test, "g"));
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      best = lang;
    }
  }
  if (!best) return fallback || "en-IN";
  if (best === "DEVA") return fallback === "mr-IN" ? "mr-IN" : "hi-IN";
  return best;
}

export function useVoiceAssistant() {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [config, setConfig] = useState<VoiceConfig>({
    inputLang: "en-IN",
    outputLang: "en-IN",
    displayLang: "en",
    // The mic is *explicit* — it never auto-resumes after the AI replies.
    // Users were complaining that the button "switches off by itself" because
    // the previous behavior auto-restarted recognition 400 ms after each
    // utterance, which fought with their explicit toggle.
    autoListen: false,
  });

  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const serverTtsAvailableRef = useRef<boolean>(true);
  const isListeningRef = useRef(false);
  const autoListenAfterSpeakRef = useRef(false);
  const onTranscriptRef = useRef<((text: string) => void) | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSilenceRef = useRef<(() => void) | null>(null);

  const supportsSTT = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  const supportsTTS = typeof window !== "undefined" && "speechSynthesis" in window;

  // Allow setting callback without re-creating recognition
  const setOnTranscript = useCallback((fn: (text: string) => void) => {
    onTranscriptRef.current = fn;
  }, []);

  const setOnSilence = useCallback((fn: () => void) => {
    onSilenceRef.current = fn;
  }, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const startSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (isListeningRef.current && onSilenceRef.current) {
        onSilenceRef.current();
      }
    }, 8000); // 8s silence → nudge
  }, [clearSilenceTimer]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    clearSilenceTimer();
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    setVoiceState(prev => prev === "listening" ? "idle" : prev);
    setInterimTranscript("");
  }, [clearSilenceTimer]);

  const startListening = useCallback(() => {
    if (!supportsSTT) return;
    stopListening();

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = config.inputLang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListeningRef.current = true;
      setVoiceState("listening");
      startSilenceTimer();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) {
        setInterimTranscript(interim);
        clearSilenceTimer(); // Reset silence timer on any speech
        startSilenceTimer();
      }
      if (final) {
        const trimmed = final.trim();
        setTranscript(trimmed);
        setInterimTranscript("");
        clearSilenceTimer();
        stopListening();
        setVoiceState("processing");
        onTranscriptRef.current?.(trimmed);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== "no-speech" && event.error !== "aborted") {
        console.warn("Speech recognition error:", event.error);
      }
      // On no-speech, just go idle gracefully
      isListeningRef.current = false;
      clearSilenceTimer();
      setVoiceState("idle");
      setInterimTranscript("");
    };

    recognition.onend = () => {
      if (isListeningRef.current) {
        try { recognition.start(); } catch {}
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (e) {
      console.warn("Could not start speech recognition:", e);
    }
  }, [supportsSTT, config.inputLang, stopListening, startSilenceTimer, clearSilenceTimer]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      // Detach handlers BEFORE pausing so an interrupted server-TTS clip
      // doesn't trigger onerror and fall through to browser TTS — that was
      // the "voice switches mid-sentence" glitch when the user tapped the
      // mic.
      try {
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
      } catch { /* ignore */ }
      audioRef.current.src = "";
      audioRef.current = null;
    }
    autoListenAfterSpeakRef.current = false;
  }, []);

  // Browser-TTS fallback intentionally removed. The product wants only the
  // Gemini-quality server voice; the default-browser voice that used to kick
  // in here was jarring (different accent, wrong cadence) and frequently
  // interrupted mid-sentence on flaky networks. If the server voice fails,
  // the assistant goes silent and the user can still use the text input.
  const giveUpSpeaking = useCallback((onDone?: () => void) => {
    setVoiceState("idle");
    onDone?.();
  }, []);

  const speak = useCallback(async (text: string, onDone?: () => void) => {
    if (isMuted) {
      setVoiceState("idle");
      onDone?.();
      return;
    }

    // Clean text for TTS: strip emojis, tips, markdown, keep full multi-line
    const cleanText = text
      // eslint-disable-next-line no-misleading-character-class -- intentional emoji/variation-selector code-point ranges (u flag); not combining a base+modifier
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, "")
      .replace(/💡.*$/gm, "")
      .replace(/\*\*|__|`/g, "")
      .trim();

    if (!cleanText) {
      onDone?.();
      return;
    }

    // Mic must be off whenever the AI is talking — otherwise speech
    // recognition picks up the AI's own audio and feeds it back as user
    // input. The user complained the button felt unresponsive; the actual
    // bug was that recognition stayed active during playback.
    stopListening();
    stopAudio();
    if (supportsTTS) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    setVoiceState("speaking");

    // Try server-side Google Cloud TTS first (much more natural voice).
    // Fall back to browser speechSynthesis on failure or when unavailable.
    if (serverTtsAvailableRef.current) {
      try {
        // Speak in the reply's OWN language, detected from its script —
        // not the app display language. `config.outputLang` is only the
        // fallback for Latin/unknown text (and disambiguates Devanagari).
        const ttsLang = detectTtsLang(cleanText, config.outputLang);
        const result = await apiRequest<{ audioContent: string; mimeType: string }>("/api/tts", {
          method: "POST",
          headers: getJsonHeaders(),
          body: JSON.stringify({ text: cleanText, lang: ttsLang }),
        });

        if (result.success && result.data?.audioContent) {
          const audio = new Audio(`data:${result.data.mimeType};base64,${result.data.audioContent}`);
          audioRef.current = audio;
          audio.onended = () => {
            setVoiceState("idle");
            audioRef.current = null;
            if (config.autoListen && autoListenAfterSpeakRef.current) {
              autoListenAfterSpeakRef.current = false;
              setTimeout(() => startListening(), 400);
            }
            onDone?.();
          };
          audio.onerror = () => {
            setVoiceState("idle");
            audioRef.current = null;
            // No fallback — silently give up rather than swap to a different voice.
            onDone?.();
          };
          await audio.play();
          return;
        }

        // Server TTS unavailable (not configured / upstream 503 / network):
        // stop hitting the endpoint for this session and stay silent. The
        // user can still drive the conversation via the text input.
        serverTtsAvailableRef.current = false;
      } catch (err) {
        serverTtsAvailableRef.current = false;
        console.warn("[tts] server TTS failed; voice disabled for this session", err);
      }
    }

    giveUpSpeaking(onDone);
  }, [isMuted, supportsTTS, config.outputLang, stopAudio, stopListening, giveUpSpeaking]);

  const stopSpeaking = useCallback(() => {
    if (supportsTTS) window.speechSynthesis.cancel();
    stopAudio();
    setVoiceState("idle");
  }, [supportsTTS, stopAudio]);

  const toggleListening = useCallback(() => {
    if (voiceState === "listening") {
      stopListening();
    } else if (voiceState === "speaking") {
      stopSpeaking();
      setTimeout(() => startListening(), 100);
    } else {
      startListening();
    }
  }, [voiceState, startListening, stopListening, stopSpeaking]);

  const speakAndListen = useCallback((text: string) => {
    autoListenAfterSpeakRef.current = true;
    speak(text);
  }, [speak]);

  const setLanguages = useCallback((displayLang: string, spokenInputLang?: string, spokenOutputLang?: string) => {
    const input = langToBcp47[spokenInputLang || displayLang] || "en-IN";
    const output = langToBcp47[spokenOutputLang || displayLang] || "en-IN";
    setConfig(prev => ({ ...prev, displayLang, inputLang: input, outputLang: output }));
  }, []);

  useEffect(() => {
    return () => {
      stopListening();
      clearSilenceTimer();
      stopAudio();
      // Cancel any in-flight browser speechSynthesis utterances queued by
      // earlier sessions/tabs — even though we no longer queue our own.
      if (supportsTTS) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      }
    };
  }, [stopListening, supportsTTS, clearSilenceTimer, stopAudio]);

  return {
    voiceState, transcript, interimTranscript, isMuted, config,
    supportsSTT, supportsTTS,
    startListening, stopListening, toggleListening,
    speak, speakAndListen, stopSpeaking,
    setIsMuted, setLanguages, setOnTranscript, setOnSilence,
  };
}
