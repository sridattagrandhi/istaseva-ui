import { describe, it, expect } from 'vitest';
import { clampText } from './clamp-text.js';

describe('clampText', () => {
  it('returns short strings unchanged (no ellipsis)', () => {
    expect(clampText('a cozy homestay', 600)).toBe('a cozy homestay');
  });

  it('returns a string exactly at the limit unchanged', () => {
    const s = 'x'.repeat(600);
    expect(clampText(s, 600)).toBe(s);
  });

  it('truncates over-limit strings and appends an ellipsis', () => {
    const s = 'y'.repeat(1000);
    const out = clampText(s, 600);
    expect(out).toBe('y'.repeat(600) + '…');
    expect(out.length).toBe(601); // 600 chars + 1 ellipsis
  });

  it('trims trailing whitespace before the ellipsis (no "word …")', () => {
    // Cut point lands right after a space -> the space should be trimmed.
    const s = 'the quick brown fox ' + 'z'.repeat(50);
    const out = clampText(s, 20); // slice(0,20) = "the quick brown fox "
    expect(out).toBe('the quick brown fox…');
  });

  it('guards against a non-positive max', () => {
    expect(clampText('anything', 0)).toBe('');
    expect(clampText('anything', -5)).toBe('');
  });
});
