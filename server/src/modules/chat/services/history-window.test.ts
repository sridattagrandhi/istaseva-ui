// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_MESSAGES, windowMessages } from './history-window.js';

const msg = (role: 'user' | 'assistant', i: number) => ({ role, content: `m${i}` });

describe('windowMessages', () => {
  it('returns short conversations untouched (same reference)', () => {
    const msgs = [msg('user', 1), msg('assistant', 2)];
    expect(windowMessages(msgs)).toBe(msgs);
  });

  it('caps long conversations to the tail window', () => {
    const msgs = Array.from({ length: 120 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', i));
    const out = windowMessages(msgs);
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    // The newest message always survives.
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1]);
  });

  it('never starts the window on an assistant message', () => {
    // Alternate so the raw tail boundary lands on an assistant turn.
    const msgs = Array.from({ length: 101 }, (_, i) => msg(i % 2 === 0 ? 'assistant' : 'user', i));
    const out = windowMessages(msgs);
    expect(out[0].role).toBe('user');
  });

  it('keeps an all-assistant tail rather than dropping everything', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => msg('assistant', i));
    const out = windowMessages(msgs);
    expect(out.length).toBe(MAX_HISTORY_MESSAGES);
  });
});
