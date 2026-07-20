/**
 * Opt-in "enhance my description with AI" for the MANUAL onboarding forms
 * (web + mobile). The AI chat path gets the same behavior conversationally
 * (the agent offers to polish a thin description); this is the form-side
 * mirror behind a button next to the description field.
 *
 * Returns 2–3 natural sentences built from the provider's draft + the
 * details they've already filled. Never invents facts. Fails SOFT — any
 * LLM error (or the dev mock provider, which returns an unrelated object)
 * yields the original draft unchanged, so the button can never break the
 * form or wipe the user's text.
 */
import { getLlmProvider } from '../../../common/providers/registry.js';
import { logger } from '../../../common/logging/logger.js';

const SYSTEM_PROMPT = `You write short, warm, factual listing descriptions for an India-only services/stays/transport marketplace (IstaSeva).
Given a provider's draft and the details they've filled, write 2-3 natural sentences (about 40-60 words) a customer would read.
Rules: keep EVERY concrete fact the provider gave; do NOT invent prices, guarantees, awards, years, or anything not present; no emojis; no ALL CAPS; no hype words like "best" or "world-class". If the draft is already good, lightly polish it.
Respond ONLY with JSON: {"description": string}.`;

export async function enhanceListingDescription(input: {
  description?: string;
  profile?: Record<string, unknown>;
}): Promise<string> {
  const draft = (input.description ?? '').trim();
  const profile = input.profile ?? {};

  const services = Array.isArray(profile.servicesCatalog)
    ? (profile.servicesCatalog as Array<Record<string, unknown>>).map((s) => s?.name).filter(Boolean)
    : undefined;

  const context = {
    draft,
    category: profile.category,
    name: profile.name,
    location: profile.location,
    experience: profile.experience,
    services,
    languages: profile.languages,
    amenities: profile.amenities,
    vehicleName: profile.vehicleName,
  };

  try {
    const llm = await getLlmProvider();
    const raw = await llm.generateStructuredJson({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(context) }],
      temperature: 0.6,
      maxTokens: 300,
    });
    const out = typeof raw?.description === 'string' ? raw.description.trim() : '';
    return out || draft;
  } catch (error) {
    logger.warn('enhanceListingDescription failed, returning original draft', { err: String(error) });
    return draft;
  }
}
