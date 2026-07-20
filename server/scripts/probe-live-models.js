/**
 * Probe which Vertex Live models this project can actually open. Useful
 * when /ws/voice keeps 1008'ing and you don't know which preview-era
 * model rotation is current. Run from `server/`:
 *   node scripts/probe-live-models.js
 *
 * Reads GEMINI_VERTEX_* from the same .env as the migrate runner.
 * Doesn't change anything — just opens, observes, closes.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const project = process.env.GEMINI_VERTEX_PROJECT;
const location = process.env.GEMINI_VERTEX_LOCATION || 'us-central1';
const saJson = process.env.GEMINI_VERTEX_SA_JSON;

if (!project || !saJson) {
  console.error('Missing GEMINI_VERTEX_PROJECT or GEMINI_VERTEX_SA_JSON in .env');
  process.exit(1);
}

const credentials = JSON.parse(saJson);

// Build a fresh client per region we want to probe — the SDK pins the
// location at construction time.
function clientFor(region) {
  return new GoogleGenAI({
    vertexai: true,
    project,
    location: region,
    googleAuthOptions: { credentials },
  });
}

// Region × model grid. If a single region/model combo accepts the
// session for >=2s, that's the answer to put in .env.
const regions = [location, 'us-east1', 'us-east4', 'us-east5', 'europe-west1', 'asia-southeast1'];
const models = [
  // Primary candidate — the published Model Garden ID per Vertex console.
  'gemini-live-2.5-flash-native-audio',
  // Older / alternate candidates kept for comparison.
  'gemini-2.0-flash-live-001',
  'gemini-live-2.5-flash-preview',
  'gemini-2.5-flash-native-audio-preview-09-2025',
];

async function probe(model, region) {
  const client = clientFor(region);
  return new Promise((resolve) => {
    let resolved = false;
    let opened = false;
    let sessionRef = null;
    const finish = (status, detail) => {
      if (resolved) return;
      resolved = true;
      try { sessionRef?.close(); } catch { /* noop */ }
      resolve({ model, status, detail });
    };

    // Vertex accepts the handshake (onopen fires) and THEN rejects model
    // config with a 1008 close ~100ms later for unavailable models.
    // Require the session to stay open >=2s before declaring success.
    const successTimer = setTimeout(() => {
      if (opened) finish('OK', 'session stayed open 2s');
    }, 2000);
    successTimer.unref?.();

    // Hard cap so a hung connect doesn't stall the run forever.
    const hardCap = setTimeout(() => finish('timeout', '6s elapsed'), 6000);
    hardCap.unref?.();

    client.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: { parts: [{ text: 'probe' }] },
        },
        callbacks: {
          onopen: () => { opened = true; },
          // The SDK calls onmessage as a function (no-op); without this
          // it throws on the first server message and the probe crashes.
          // We don't care about the content, only that messages arrive
          // (which means the session is healthy).
          onmessage: () => {},
          onerror: (err) => finish('ERROR', err?.message || 'unknown'),
          onclose: (evt) => {
            const reason = evt?.reason || `code ${evt?.code}`;
            // Close before the 2s timer = real rejection.
            finish('CLOSED', reason.slice(0, 200));
          },
        },
      })
      .then((session) => { sessionRef = session; })
      .catch((err) => finish('CONNECT_THREW', err?.message || 'unknown'));
  });
}

console.log(`Probing Live models × regions for project=${project}\n`);
for (const region of regions) {
  console.log(`-- region: ${region} --`);
  for (const model of models) {
    process.stdout.write(`  ${model.padEnd(55)} ... `);
    // eslint-disable-next-line no-await-in-loop
    const result = await probe(model, region);
    if (result.status === 'OK') {
      console.log(`✓ WORKS`);
    } else {
      console.log(`✗ ${result.status} — ${result.detail}`);
    }
  }
  console.log('');
}
process.exit(0);
