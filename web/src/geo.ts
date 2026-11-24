/** Pure helpers for the map (unit-tested from the node test suite). */
export interface Hist { time: number; newP: number; oldP: number; newA: number; oldA: number }

/** Town position: island coordinate plus a small offset by slot so towns on one island don't overlap. */
export function townXY(ix: number, iy: number, slot: number): [number, number] {
  const a = slot * 2.399963; // golden angle
  const r = 0.12 + 0.05 * (slot % 4);
  return [ix + 0.5 + Math.cos(a) * r, iy + 0.5 + Math.sin(a) * r];
}

/**
 * Owner at time t: replay backwards from today's owner. The old owner of the first conquest after t owned it at t
 * (alliance as recorded in that conquest); with no later conquest the current owner stands.
 */
export function ownerAtTime(current: { p: number; a: number }, hist: Hist[] | undefined, t: number, now = Infinity): { p: number; a: number } {
  if (!hist?.length || t >= now) return current;
  let lo = 0, hi = hist.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hist[mid].time <= t) lo = mid + 1; else hi = mid; }
  if (lo >= hist.length) return current;
  return { p: hist[lo].oldP, a: hist[lo].oldA };
}

/** Stable, well-spread colour per alliance id. */
export function allianceColor(id: number): string {
  const h = Math.round(((id * 0.618033988749895) % 1) * 360);
  return `hsl(${h} 70% 58%)`;
}
