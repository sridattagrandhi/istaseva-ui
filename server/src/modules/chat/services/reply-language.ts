// Deterministic reply-language enforcement.
//
// The prompt already TELLS the model to mirror the user's language, but the
// model intermittently defaults to English even when the user clearly wrote
// in a native Indian script. Instead of relying on the model's own detection,
// we detect the script of the user's latest message server-side and inject a
// hard, non-negotiable directive for THIS turn. This removes the detection
// burden from the model — it just has to obey.
//
// Scope: native (non-Latin) Indian scripts only. Latin text (English, romanized
// Hinglish, Spanish, …) is intentionally left to the prompt — we can't reliably
// tell English from romanized Telugu from Spanish by characters alone, and the
// prompt's English-default + unsupported-language rules already cover it.

const SCRIPTS: Array<{ name: string; script: string; re: RegExp }> = [
  { name: 'Telugu', script: 'తెలుగు', re: /[ఀ-౿]/g },
  { name: 'Tamil', script: 'தமிழ்', re: /[஀-௿]/g },
  { name: 'Kannada', script: 'ಕನ್ನಡ', re: /[ಀ-೿]/g },
  { name: 'Malayalam', script: 'മലയാളം', re: /[ഀ-ൿ]/g },
  { name: 'Bengali', script: 'বাংলা', re: /[ঀ-৿]/g },
  { name: 'Gujarati', script: 'ગુજરાતી', re: /[઀-૿]/g },
  { name: 'Punjabi', script: 'ਪੰਜਾਬੀ', re: /[਀-੿]/g },
  { name: 'Odia', script: 'ଓଡ଼ିଆ', re: /[଀-୿]/g },
  // Devanagari is shared by Hindi and Marathi — we can't split them by script,
  // so the directive names both and tells the model to match whichever.
  { name: 'Hindi or Marathi', script: 'Devanagari', re: /[ऀ-ॿ]/g },
];

/** The dominant native Indian script in `text`, or null if it's Latin/empty or
 *  has too few script characters to be a real signal (guards a stray glyph). */
export function detectMessageLanguage(text: string): { name: string; script: string } | null {
  let best: { name: string; script: string } | null = null;
  let bestCount = 0;
  for (const s of SCRIPTS) {
    const count = (text.match(s.re) || []).length;
    if (count > bestCount) {
      bestCount = count;
      best = { name: s.name, script: s.script };
    }
  }
  if (!best || bestCount < 2) return null;
  return best;
}

/** Hard per-turn directive forcing the reply into the user's detected script,
 *  or '' when the message is Latin/unknown (let the prompt decide). Append to
 *  the END of the system prompt so it's the most salient instruction. */
export function perTurnLanguageDirective(text: string): string {
  const d = detectMessageLanguage(text || '');
  if (!d) return '';
  const scriptNote = d.script === 'Devanagari'
    ? 'Devanagari script (match Hindi or Marathi to whichever the user used)'
    : `${d.script} native script`;
  return `\n\n# THIS TURN'S REPLY LANGUAGE — deterministic, overrides your own guess\n`
    + `The user's latest message is written in ${d.name}. Write your ENTIRE reply in ${d.name} using ${scriptNote} — never English, never transliteration. This is non-negotiable for this turn.`;
}
