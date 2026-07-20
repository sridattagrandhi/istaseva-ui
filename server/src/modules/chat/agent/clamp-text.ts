/**
 * Clamp free-text (listing/review prose) to `max` characters with a trailing
 * ellipsis. Tool results are replayed to the model on every agent-loop
 * iteration, so an uncapped multi-KB description is re-billed as input tokens
 * up to `assistantMaxToolTurns` times per user message (COST-002). This mirrors
 * the inline pattern already used in search_listings (200) and
 * get_listing_reviews (280); structured/bookable fields are never clamped —
 * only human prose.
 */
export function clampText(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  // Trim trailing whitespace before the ellipsis so we don't emit "word …".
  return value.slice(0, max).trimEnd() + '…';
}
