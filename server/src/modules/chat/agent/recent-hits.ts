/**
 * Short-term per-user cache of listings the assistant just surfaced.
 *
 * Across turns, the agent loop only carries text messages back in — the
 * search_listings / get_listing_details results from the previous turn
 * are gone. That makes the model either re-search or, worse, hallucinate
 * a UUID when the user says "tell me more". This cache replays the
 * recent hits into the next turn's system context so the model can quote
 * a real id without re-searching.
 *
 * Keep it small and short-lived — this is a conversational scratchpad,
 * not durable memory (that's userAssistantMemoryService).
 */
import { redis } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';

const TTL_SECONDS = 30 * 60; // 30 min — covers a typical chat session
const MAX_HITS = 8;

export interface RecentHit {
  id: string;
  title: string;
  type?: string; // 'stay' | 'service' | 'transport'
  location?: string;
  price?: string;
}

function key(userId: string): string {
  return `assistant:recent-hits:${userId}`;
}

/** Append hits to the user's recent list (most-recent first, deduped, capped). */
export async function recordRecentHits(userId: string, hits: RecentHit[]): Promise<void> {
  if (!userId || hits.length === 0) return;
  try {
    const existing = await readRecentHits(userId);
    const merged: RecentHit[] = [];
    const seen = new Set<string>();
    for (const h of [...hits, ...existing]) {
      if (!h?.id || seen.has(h.id)) continue;
      seen.add(h.id);
      merged.push(h);
      if (merged.length >= MAX_HITS) break;
    }
    await redis.set(key(userId), JSON.stringify(merged), 'EX', TTL_SECONDS);
  } catch (err) {
    // Cache is best-effort — never break the tool call on a Redis hiccup.
    logger.warn('recent-hits: write failed', { error: (err as Error).message });
  }
}

export async function readRecentHits(userId: string): Promise<RecentHit[]> {
  if (!userId) return [];
  try {
    const raw = await redis.get(key(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((h) => h && typeof h.id === 'string') : [];
  } catch (err) {
    logger.warn('recent-hits: read failed', { error: (err as Error).message });
    return [];
  }
}
