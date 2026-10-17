import { describe, expect, it } from 'vitest';
import { codeMatches, createChatLimiter } from '../server/limits.js';

describe('demo protection', () => {
  it('checks the access code exactly', () => {
    expect(codeMatches('test-code-1', 'test-code-1')).toBe(true);
    expect(codeMatches(' test-code-1 ', 'test-code-1')).toBe(true);
    expect(codeMatches('test-code-0', 'test-code-1')).toBe(false);
    expect(codeMatches(undefined, 'test-code-1')).toBe(false);
  });

  it('limits requests per hour per key and per day overall', () => {
    let t = Date.UTC(2026, 9, 16, 9);
    const lim = createChatLimiter(2, 3, () => t);
    expect(lim.take('a').ok).toBe(true);
    expect(lim.take('a').ok).toBe(true);
    expect(lim.take('a').ok).toBe(false); // hourly limit for a
    expect(lim.take('b').ok).toBe(true);
    expect(lim.take('c').ok).toBe(false); // daily cap of 3 reached
    t += 24 * 3_600_000;
    expect(lim.take('a').ok).toBe(true); // new day, hour window passed
  });
});
