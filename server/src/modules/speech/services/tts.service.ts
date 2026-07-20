/**
 * Google Cloud Text-to-Speech — SA-authenticated.
 *
 * We reuse the Vertex service-account credentials (GEMINI_VERTEX_SA_JSON) for
 * TTS auth so there's exactly ONE Google credential to manage across the app.
 * TTS itself is not a Vertex service, but it lives in the same GCP project
 * and any SA in that project can call it as long as:
 *   • Cloud Text-to-Speech API is enabled in the project
 *   • The SA has roles/serviceusage.serviceUsageConsumer (already granted for Vertex)
 *
 * google-auth-library handles OAuth token caching (tokens are reused for ~1h
 * and refreshed transparently), so per-request overhead is just a map lookup.
 */
import { GoogleAuth } from 'google-auth-library';
import { config } from '../../../common/config/index.js';
import { logger } from '../../../common/logging/logger.js';
import { AppError } from '../../../common/errors/app-error.js';

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// BCP-47 locale → preferred Google Cloud TTS Neural2/WaveNet voice.
// Neural2 is available for the major Indian languages and English-IN;
// for the rest we fall back to WaveNet (still far more natural than the
// browser's speechSynthesis).
const VOICE_MAP: Record<string, { name: string; languageCode: string }> = {
  'en-IN': { name: 'en-IN-Neural2-A', languageCode: 'en-IN' },
  'hi-IN': { name: 'hi-IN-Neural2-A', languageCode: 'hi-IN' },
  'ta-IN': { name: 'ta-IN-Wavenet-A', languageCode: 'ta-IN' },
  'te-IN': { name: 'te-IN-Standard-A', languageCode: 'te-IN' },
  'kn-IN': { name: 'kn-IN-Wavenet-A', languageCode: 'kn-IN' },
  'ml-IN': { name: 'ml-IN-Wavenet-A', languageCode: 'ml-IN' },
  'mr-IN': { name: 'mr-IN-Wavenet-A', languageCode: 'mr-IN' },
  'bn-IN': { name: 'bn-IN-Wavenet-A', languageCode: 'bn-IN' },
  'gu-IN': { name: 'gu-IN-Wavenet-A', languageCode: 'gu-IN' },
};

export interface SynthesizeParams {
  text: string;
  lang?: string;
  voiceName?: string;
  speakingRate?: number;
  pitch?: number;
}

export interface SynthesizeResult {
  audioContent: string; // base64
  mimeType: 'audio/mp3';
  voice: string;
  languageCode: string;
}

export class TtsService {
  private auth: GoogleAuth | null = null;

  get enabled() {
    // TTS now piggy-backs on the Vertex SA, so the gate is the same as
    // Live voice: SA JSON + project must be present. We keep the config
    // flag (ttsProvider === 'google') so the feature can still be turned
    // off globally without changing code.
    return (
      config.speech.ttsProvider === 'google' &&
      !!config.llm.vertexServiceAccountJson &&
      !!config.llm.vertexProject
    );
  }

  private getAuth(): GoogleAuth {
    if (this.auth) return this.auth;
    const credentials = JSON.parse(config.llm.vertexServiceAccountJson!);
    this.auth = new GoogleAuth({
      credentials,
      scopes: [TTS_SCOPE],
      // Setting projectId here makes any future usage-based billing lookups
      // resolve cleanly (TTS itself doesn't need an explicit quota project
      // header when the SA is in the project being billed).
      projectId: config.llm.vertexProject!,
    });
    return this.auth;
  }

  resolveVoice(lang?: string): { name: string; languageCode: string } {
    const normalized = (lang || 'en-IN').replace('_', '-');
    if (VOICE_MAP[normalized]) return VOICE_MAP[normalized];
    const prefix = normalized.split('-')[0];
    const match = Object.values(VOICE_MAP).find((v) => v.languageCode.startsWith(prefix + '-'));
    return match ?? VOICE_MAP['en-IN'];
  }

  async synthesize(params: SynthesizeParams): Promise<SynthesizeResult> {
    if (!this.enabled) {
      throw new AppError(503, 'TTS provider is not configured', 'TTS_NOT_CONFIGURED');
    }

    const voice = params.voiceName
      ? { name: params.voiceName, languageCode: params.lang ?? 'en-IN' }
      : this.resolveVoice(params.lang);

    const body = {
      input: { text: params.text.slice(0, 4500) },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: params.speakingRate ?? 1.0,
        pitch: params.pitch ?? 0,
      },
    };

    const client = await this.getAuth().getClient();
    const accessToken = (await client.getAccessToken()).token;
    if (!accessToken) throw new AppError(502, 'Failed to obtain TTS access token', 'TTS_AUTH_FAILED');

    const resp = await fetch(GOOGLE_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error('Google TTS request failed', { status: resp.status, body: text });
      throw new AppError(502, `TTS synthesis failed (${resp.status})`, 'TTS_SYNTHESIS_FAILED');
    }

    const data = (await resp.json()) as { audioContent: string };
    return {
      audioContent: data.audioContent,
      mimeType: 'audio/mp3',
      voice: voice.name,
      languageCode: voice.languageCode,
    };
  }
}

export const ttsService = new TtsService();
