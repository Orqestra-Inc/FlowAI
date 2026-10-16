import crypto from 'node:crypto';

/** Constant-time comparison of a submitted access code. */
export function codeMatches(submitted: unknown, expected: string): boolean {
  if (typeof submitted !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(submitted.trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * In-memory quota guard for a public demo: a rolling per-key hourly limit and a global daily cap,
 * so a leaked URL can't drain the model key. Resets on restart, which is fine for a demo.
 */
export function createChatLimiter(perHour: number, perDay: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  let day = '';
  let dayCount = 0;
  return {
    take(key: string): { ok: true } | { ok: false; reason: string } {
      const t = now();
      const today = new Date(t).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        dayCount = 0;
      }
      if (dayCount >= perDay) return { ok: false, reason: 'The demo has reached its request limit for today. Try again tomorrow.' };
      const recent = (hits.get(key) ?? []).filter((x) => t - x < 3_600_000);
      if (recent.length >= perHour) return { ok: false, reason: 'Too many requests in the last hour. Wait a little and try again.' };
      recent.push(t);
      hits.set(key, recent);
      dayCount += 1;
      return { ok: true };
    },
  };
}
