/**
 * Strategy markup on the world map: shared types, limits and validation (used by the server and bundled into the
 * client, so this file must stay free of Node imports). Shapes live in WORLD MAP coordinates (0..1000), so they stay
 * in place on pan/zoom; stroke width and text size are screen pixels so they stay readable at any zoom.
 */
export type MarkKind = 'pen' | 'line' | 'arrow' | 'circle' | 'rect' | 'text';
export type MarkTtl = '1h' | '6h' | '24h' | '7d';
export const MARK_KINDS: MarkKind[] = ['pen', 'line', 'arrow', 'circle', 'rect', 'text'];
export const MARK_COLORS = ['#ff3b3b', '#ffd23f', '#3d8bff', '#22c7c7', '#7dff6b', '#ffffff', '#c06bff'] as const;
export const MARK_WIDTHS = [2, 4, 7] as const;
export const MARK_TTL: Record<MarkTtl, number> = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 24 * 3600 };
export const MARK_LIMITS = { points: 400, perGuild: 300, perUser: 80, text: 140, writesPerMin: 40 } as const;

/** What a client sends to create a shape. pts = flat [x0,y0,x1,y1,...] in world coordinates. */
export interface MarkInput { kind: MarkKind; color: string; width: number; pts: number[]; text?: string; ttl: MarkTtl }
/** A stored shape as served to clients. `mine` = drawn by the viewer; userId is never sent. */
export interface Mark { id: number; kind: MarkKind; color: string; width: number; pts: number[]; text: string; author: string; mine: boolean; createdAt: number; expiresAt: number }
/** `canDraw` / `defaultTtl` come from the admin panel (who may draw, default expiry). */
export interface MarksView { rev: number; marks: Mark[]; canClearAll: boolean; limits: typeof MARK_LIMITS; canDraw?: boolean; defaultTtl?: MarkTtl }

/** Plain text only: no tags, no control characters, collapsed whitespace, capped length. Rendered with fillText/textContent anyway. */
export function sanitizeText(s: unknown, max: number = MARK_LIMITS.text): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Ramer–Douglas–Peucker on a flat point list (iterative, no recursion limits). */
export function simplify(pts: number[], eps: number): number[] {
  const n = pts.length >> 1;
  if (n <= 2) return pts.slice(0, n * 2);
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d2: number;
      if (!len2) d2 = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2)); const qx = px - t * dx, qy = py - t * dy; d2 = qx * qx + qy * qy; }
      if (d2 > best) { best = d2; bi = i; }
    }
    if (best > e2) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}
/** Simplify until the stroke fits the point cap (raising epsilon), so a long scribble is never rejected. */
export function fitPoints(pts: number[], eps: number, max: number = MARK_LIMITS.points): number[] {
  let out = simplify(pts, eps);
  for (let e = eps * 2; out.length / 2 > max; e *= 2) out = simplify(pts, e);
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;
/** Validate + normalise a client shape. Returns an error code or the clean input. */
export function validateMark(x: unknown): { ok: true; m: MarkInput } | { ok: false; err: 'kind' | 'color' | 'width' | 'points' | 'text' | 'ttl' } {
  const o = (x ?? {}) as Partial<MarkInput>;
  if (!MARK_KINDS.includes(o.kind as MarkKind)) return { ok: false, err: 'kind' };
  if (!(MARK_COLORS as readonly string[]).includes(String(o.color))) return { ok: false, err: 'color' };
  if (!(MARK_WIDTHS as readonly number[]).includes(Number(o.width))) return { ok: false, err: 'width' };
  if (!Object.prototype.hasOwnProperty.call(MARK_TTL, String(o.ttl))) return { ok: false, err: 'ttl' };
  if (!Array.isArray(o.pts) || o.pts.length % 2 || o.pts.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < -50 || v > 1050)) return { ok: false, err: 'points' };
  const n = o.pts.length / 2;
  const need = o.kind === 'pen' ? n >= 2 && n <= MARK_LIMITS.points : o.kind === 'text' ? n === 1 : n === 2;
  if (!need) return { ok: false, err: 'points' };
  const text = o.kind === 'text' ? sanitizeText(o.text) : '';
  if (o.kind === 'text' && !text) return { ok: false, err: 'text' };
  return { ok: true, m: { kind: o.kind as MarkKind, color: String(o.color), width: Number(o.width), pts: o.pts.map(round), text, ttl: o.ttl as MarkTtl } };
}
