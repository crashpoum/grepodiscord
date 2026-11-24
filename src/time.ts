/**
 * GrepoData returns wall-clock times in the WORLD's timezone ("2026-11-24 16:29:56" on gr = Europe/Athens),
 * verified against the official conquers.txt unix timestamps. Convert them to epoch seconds so Discord
 * can render `<t:…>` in each reader's own timezone.
 */
export const MARKET_TZ: Record<string, string> = {
  ar: 'America/Argentina/Buenos_Aires', br: 'America/Belem', cz: 'Europe/Prague', de: 'Europe/Berlin', en: 'Europe/London',
  es: 'Europe/Madrid', fr: 'Europe/Paris', gr: 'Europe/Athens', hu: 'Europe/Budapest', it: 'Europe/Rome', nl: 'Europe/Amsterdam',
  pl: 'Europe/Warsaw', pt: 'Europe/Lisbon', ro: 'Europe/Bucharest', ru: 'Europe/Moscow', sk: 'Europe/Bratislava', tr: 'Europe/Istanbul',
  us: 'America/New_York', zz: 'Europe/Amsterdam',
};

export function worldTz(world: string): string {
  return MARKET_TZ[world.replace(/\d+$/, '')] ?? 'UTC';
}

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** "YYYY-MM-DD HH:MM[:SS]" (or "DD-MM-YY HH:MM[:SS]") wall time in `tz` → epoch seconds, or null. */
export function localToEpoch(s: string | null | undefined, tz: string): number | null {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  let y: number, mo: number, d: number, h: number, mi: number, sec: number;
  if (m) { [y, mo, d, h, mi, sec] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)]; }
  else {
    m = /^(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
    if (!m) return null;
    [d, mo, y, h, mi, sec] = [+m[1], +m[2], 2000 + +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, sec);
  // Two passes handle DST transitions.
  let guess = asUtc - tzOffsetMs(tz, asUtc);
  guess = asUtc - tzOffsetMs(tz, guess);
  return Math.floor(guess / 1000);
}

/** Today's date (YYYY-MM-DD) and hour in a timezone. */
export function localDateHour(tz: string, now = Date.now()): { date: string; hour: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(now));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}

export const discordTs = (sec: number | null, style: 'f' | 'R' | 'D' | 'd' | 't' = 'f') => (sec == null ? '?' : `<t:${sec}:${style}>`);
