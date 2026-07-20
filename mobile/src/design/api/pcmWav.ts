// design/api/pcmWav.ts — pure, dependency-free PCM↔WAV + base64 helpers.
//
// React Native has no `atob`/`btoa`/`Buffer`, so to turn the server's streamed
// base64 24kHz Int16 PCM chunks into something expo-av can play, we base64-
// decode → wrap in a 44-byte WAV header → base64-encode a `data:audio/wav` URI.
// These are written WITHOUT any imports so they're unit-testable in plain Node
// (see pcmWav.test.mjs-style checks) — the playback path's correctness rides on
// this codec, so it must be provable off-device.

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < CHARS.length; i++) t[CHARS.charCodeAt(i)] = i;
  return t;
})();

/** Decode a standard base64 string to bytes. Tolerates padding + whitespace. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const n = clean.length;
  const outLen = (n * 3) >> 2; // 4 chars → 3 bytes (partial final group handled by guards)
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)];
    const c1 = LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = i + 2 < n ? LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < n ? LOOKUP[clean.charCodeAt(i + 3)] : 0;
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (triple >> 16) & 0xff;
    if (o < outLen) out[o++] = (triple >> 8) & 0xff;
    if (o < outLen) out[o++] = triple & 0xff;
  }
  return out;
}

/** Encode bytes to a standard (padded) base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += CHARS[(triple >> 18) & 63];
    out += CHARS[(triple >> 12) & 63];
    out += i + 1 < n ? CHARS[(triple >> 6) & 63] : "=";
    out += i + 2 < n ? CHARS[triple & 63] : "=";
  }
  return out;
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

/**
 * Wrap raw base64 PCM in a WAV container and return base64 of the whole file,
 * ready for `data:audio/wav;base64,<...>`. Defaults match Gemini native-audio
 * output: 24kHz, mono, 16-bit little-endian PCM.
 */
export function pcmToWavBase64(
  pcmBase64: string,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): string {
  const pcm = base64ToBytes(pcmBase64);
  const dataLen = pcm.length;
  const blockAlign = channels * (bitsPerSample >> 3);
  const byteRate = sampleRate * blockAlign;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  writeAscii(buf, 0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  writeAscii(buf, 8, "WAVE");
  writeAscii(buf, 12, "fmt ");
  dv.setUint32(16, 16, true);      // fmt chunk size
  dv.setUint16(20, 1, true);       // audio format = PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeAscii(buf, 36, "data");
  dv.setUint32(40, dataLen, true);
  buf.set(pcm, 44);
  return bytesToBase64(buf);
}
