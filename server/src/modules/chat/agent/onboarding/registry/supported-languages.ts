/**
 * The languages a provider can serve customers in — the SINGLE allow-list
 * the AI onboarding path enforces. Must stay in sync with the manual-form
 * chip sets: web `src/components/onboarding/OnboardingForm.tsx`
 * (LANGUAGE_OPTIONS) and mobile `ListingOnboarding.tsx` (LANGS). If you add
 * or remove a language, update all three.
 */
export const SUPPORTED_LANGUAGES = [
  'English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali',
] as const;

const CANONICAL_BY_LOWER = new Map(
  SUPPORTED_LANGUAGES.map((l) => [l.toLowerCase(), l as string]),
);

/**
 * Filter arbitrary language strings down to the supported set — mapping each
 * to its canonical casing and de-duping. Unsupported entries are dropped
 * (so "German" never persists), which is why the agent prompt tells the
 * model to name the rejected ones back to the user.
 */
export function filterToSupportedLanguages(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const canonical = CANONICAL_BY_LOWER.get(raw.trim().toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
