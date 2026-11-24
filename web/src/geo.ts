/** Pure helpers for the map (unit-tested from the node test suite). */
export interface Hist { time: number; newP: number; oldP: number; newA: number; oldA: number }

/** Town position: island coordinate plus a small offset by slot so towns on one island don't overlap. */
export function townXY(ix: number, iy: number, slot: number): [number, number] {
  const a = slot * 2.399963; // golden angle spiral: up to 20 towns spread over the island
  const r = 0.46 * Math.sqrt((Math.max(0, slot) % 20 + 0.6) / 20.6);
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

// ---------------------------------------------------------------- sides → colours (legend uses the same table)
export type Side = 'own' | 'ally' | 'enemy' | 'other' | 'none' | 'ghost';
export const SIDE_COLOR: Record<Side, string> = { own: '#3d8bff', ally: '#22c7c7', enemy: '#ff3b3b', other: '#c9b48a', none: '#8f8f8f', ghost: '#4a4a4a' };
/** Side of a town owner. Ids compared as numbers (payload ids may arrive as strings from older caches). */
export function sideOf(playerId: number, allianceId: number, s: { ours: number[]; allies?: number[]; enemies: number[] }): Side {
  if (!Number(playerId)) return 'ghost';
  const a = Number(allianceId);
  if (!a) return 'none';
  if (s.ours.some((x) => Number(x) === a)) return 'own';
  if ((s.allies ?? []).some((x) => Number(x) === a)) return 'ally';
  if (s.enemies.some((x) => Number(x) === a)) return 'enemy';
  return 'other';
}

// ---------------------------------------------------------------- islands
export interface Islands { x0: number; y0: number; x1: number; y1: number; n: number; xs: Uint16Array; ys: Uint16Array; types: Uint8Array }
/** Decode the "GCI2" island blob from /api/islands (see src/web/islands.ts). */
export function decodeIslands(buf: ArrayBuffer): Islands | null {
  const v = new DataView(buf), u = new Uint8Array(buf);
  if (buf.byteLength < 16 || String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'GCI2') return null;
  const n = v.getUint32(12, true);
  if (buf.byteLength < 16 + n * 5) return null;
  const xs = new Uint16Array(n), ys = new Uint16Array(n), types = new Uint8Array(n);
  let y = 0, x = 0;
  for (let i = 0; i < n; i++) {
    const dy = u[16 + i] | (u[16 + n + i] << 8), dx = u[16 + 2 * n + i] | (u[16 + 3 * n + i] << 8);
    if (dy) { y += dy; x = 0; }
    x += dx;
    xs[i] = x; ys[i] = y; types[i] = u[16 + 4 * n + i];
  }
  return { x0: v.getUint16(4, true), y0: v.getUint16(6, true), x1: v.getUint16(8, true), y1: v.getUint16(10, true), n, xs, ys, types };
}
/** Island size class from the official island_type: 1–10 and 37–46 big (20 slots), 11–16 and 47–60 small town islands, 17–36 rocks. */
export function islandClass(type: number): 'big' | 'small' | 'rock' {
  if ((type >= 1 && type <= 10) || (type >= 37 && type <= 46)) return 'big';
  if (type >= 17 && type <= 36) return 'rock';
  return 'small';
}
/** Stylized island outline per type (deterministic, unit radius ~1): the same type always gets the same shape. */
export function islandShape(type: number): Float32Array {
  const n = 14;
  let seed = (type * 2654435761) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sx = 0.8 + rnd() * 0.45, sy = 0.8 + rnd() * 0.45, rot = rnd() * Math.PI;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.78 + rnd() * 0.32;
    const x = Math.cos(a) * r * sx, y = Math.sin(a) * r * sy;
    out[i * 2] = x * Math.cos(rot) - y * Math.sin(rot); out[i * 2 + 1] = x * Math.sin(rot) + y * Math.cos(rot);
  }
  return out;
}
export const ISLAND_R = { big: 0.62, small: 0.46, rock: 0.15 } as const;

/** Uniform-grid spatial index over points (hit testing, viewport culling). */
export class Grid {
  private cells = new Map<number, number[]>();
  constructor(private size: number) {}
  private key(cx: number, cy: number) { return cx * 4096 + cy; }
  add(i: number, x: number, y: number) { const k = this.key(Math.floor(x / this.size), Math.floor(y / this.size)); let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(i); }
  /** Calls f for every index in cells overlapping the rectangle. */
  each(x0: number, y0: number, x1: number, y1: number, f: (i: number) => void) {
    const a = Math.floor(x0 / this.size), b = Math.floor(x1 / this.size), c = Math.floor(y0 / this.size), d = Math.floor(y1 / this.size);
    for (let cx = a; cx <= b; cx++) for (let cy = c; cy <= d; cy++) { const cell = this.cells.get(this.key(cx, cy)); if (cell) for (const i of cell) f(i); }
  }
}
export const oceanOf = (x: number, y: number) => Math.floor(x / 100) * 10 + Math.floor(y / 100);
