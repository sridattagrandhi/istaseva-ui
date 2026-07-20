/**
 * Persistent per-user memory for the assistant agent.
 *
 * Read on every turn, summarised into the system prompt; written by the
 * `remember_preference` tool. The shape is intentionally small — see
 * AssistantMemory below — because the entire blob ships into the prompt
 * every turn, and prompt tokens are paid for forever.
 *
 * Eviction policy:
 *   - history.recentSearches[] is capped at 20 entries; oldest dropped first.
 *   - If a write would exceed the 4KB DB cap, we evict from
 *     history.recentSearches first, then from history fields generally,
 *     and finally throw if preferences alone exceed the cap (very rare).
 *
 * Concurrency:
 *   - Optimistic locking via updated_at. `set()` reads, mutates, and
 *     CAS-writes. On conflict (concurrent voice + text turn racing) we
 *     re-read and re-apply the patch — preferences merge cleanly,
 *     history appends are commutative.
 */
import { logger } from '../../../common/logging/logger.js';
import {
  userAssistantMemoryRepository,
  type UserAssistantMemoryRow,
} from '../repositories/user-assistant-memory.repository.js';

export interface AssistantMemory {
  preferences: Record<string, string | number | boolean | string[]>;
  history: {
    recentSearches: Array<{ q: string; ts: string }>;
    lastBookingId?: string;
  };
  flags: {
    hostileSentimentEvents: number;
    consecutiveFailures: number;
  };
}

const EMPTY_MEMORY: AssistantMemory = {
  preferences: {},
  history: { recentSearches: [] },
  flags: { hostileSentimentEvents: 0, consecutiveFailures: 0 },
};

const MAX_BYTES = 4096;
const MAX_RECENT_SEARCHES = 20;

function sizeOf(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/**
 * Best-effort merger — fills missing keys with defaults so old rows
 * written before a shape change don't crash readers. Each new top-level
 * key needs a default added here.
 */
function normalise(raw: Record<string, unknown> | undefined | null): AssistantMemory {
  const r = (raw ?? {}) as Partial<AssistantMemory>;
  return {
    preferences: { ...(r.preferences ?? {}) },
    history: {
      recentSearches: Array.isArray(r.history?.recentSearches) ? r.history!.recentSearches.slice(0, MAX_RECENT_SEARCHES) : [],
      lastBookingId: r.history?.lastBookingId,
    },
    flags: {
      hostileSentimentEvents: Number(r.flags?.hostileSentimentEvents ?? 0),
      consecutiveFailures: Number(r.flags?.consecutiveFailures ?? 0),
    },
  };
}

/**
 * Drop oldest recent searches until the blob fits, then drop history.lastBookingId,
 * then return as-is (preferences are sacred — we'd rather throw than evict them
 * silently).
 */
function evictUntilFits(mem: AssistantMemory): AssistantMemory {
  const out: AssistantMemory = {
    preferences: { ...mem.preferences },
    history: {
      recentSearches: [...mem.history.recentSearches],
      lastBookingId: mem.history.lastBookingId,
    },
    flags: { ...mem.flags },
  };

  while (sizeOf(out) > MAX_BYTES && out.history.recentSearches.length > 0) {
    out.history.recentSearches.shift();
  }
  if (sizeOf(out) > MAX_BYTES) {
    delete out.history.lastBookingId;
  }
  return out;
}

export class UserAssistantMemoryService {
  /** Read or default. Always returns a valid AssistantMemory. */
  async get(userId: string): Promise<{ memory: AssistantMemory; updatedAt: Date | null }> {
    try {
      const result = await userAssistantMemoryRepository.getByUserId(userId);
      const row = result.rows[0] as UserAssistantMemoryRow | undefined;
      if (!row) return { memory: { ...EMPTY_MEMORY, preferences: {}, history: { recentSearches: [] } }, updatedAt: null };
      return { memory: normalise(row.memory), updatedAt: row.updated_at };
    } catch (err) {
      // If the table doesn't exist yet (migration not run) we degrade
      // to "no memory" rather than tanking the whole assistant turn.
      logger.warn('memory: read failed, defaulting to empty', { userId, error: (err as Error).message });
      return { memory: { ...EMPTY_MEMORY, preferences: {}, history: { recentSearches: [] } }, updatedAt: null };
    }
  }

  /**
   * Apply a patch and write. Patch semantics:
   *   - preferences[key] = value (overwrite)
   *   - history.recentSearches: appended (capped at MAX_RECENT_SEARCHES)
   *   - flags: numeric increment, not overwrite
   * Caller passes whichever subset they're updating.
   *
   * Concurrency: read-modify-write runs inside a single Postgres
   * transaction holding a row-level lock (SELECT FOR UPDATE). Two
   * concurrent callers for the same userId queue cleanly; no CAS,
   * no retries, no timestamp-precision games.
   */
  async patch(
    userId: string,
    patch: {
      preferences?: Record<string, string | number | boolean | string[]>;
      pushSearch?: { q: string; ts?: string };
      lastBookingId?: string;
      incrementFlag?: 'hostileSentimentEvents' | 'consecutiveFailures';
      resetFlag?: 'hostileSentimentEvents' | 'consecutiveFailures';
    },
  ): Promise<AssistantMemory> {
    const row = await userAssistantMemoryRepository.updateInTransaction(userId, (current) => {
      const next = normalise(current as Partial<AssistantMemory>);

      if (patch.preferences) {
        Object.assign(next.preferences, patch.preferences);
      }
      if (patch.pushSearch) {
        next.history.recentSearches.push({
          q: patch.pushSearch.q,
          ts: patch.pushSearch.ts ?? new Date().toISOString(),
        });
        if (next.history.recentSearches.length > MAX_RECENT_SEARCHES) {
          next.history.recentSearches = next.history.recentSearches.slice(-MAX_RECENT_SEARCHES);
        }
      }
      if (patch.lastBookingId !== undefined) {
        next.history.lastBookingId = patch.lastBookingId;
      }
      if (patch.incrementFlag) {
        next.flags[patch.incrementFlag] = (next.flags[patch.incrementFlag] ?? 0) + 1;
      }
      if (patch.resetFlag) {
        next.flags[patch.resetFlag] = 0;
      }

      const fitted = evictUntilFits(next);
      if (sizeOf(fitted) > MAX_BYTES) {
        // Preferences alone exceed cap — refuse rather than silently
        // dropping them. The throw rolls back the transaction.
        throw new Error(`Memory exceeds ${MAX_BYTES} bytes after eviction`);
      }
      return fitted as unknown as Record<string, unknown>;
    });

    return normalise(row.memory);
  }

  /**
   * Compact one-line summary suitable for inlining in the system prompt.
   * Skipped (returns empty string) when nothing useful is set so we
   * don't burn tokens on an empty stub.
   */
  summarise(memory: AssistantMemory): string {
    const parts: string[] = [];

    const prefEntries = Object.entries(memory.preferences);
    if (prefEntries.length > 0) {
      const flat = prefEntries
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`)
        .join(', ');
      parts.push(`Known preferences: ${flat}`);
    }

    if (memory.history.recentSearches.length > 0) {
      const recent = memory.history.recentSearches.slice(-5).map((s) => s.q).join(' | ');
      parts.push(`Recent searches: ${recent}`);
    }

    if (memory.history.lastBookingId) {
      parts.push(`Last booking id: ${memory.history.lastBookingId}`);
    }

    return parts.length === 0 ? '' : parts.join('\n');
  }
}

export const userAssistantMemoryService = new UserAssistantMemoryService();
