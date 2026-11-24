/**
 * Island layer for the world map, from the official public islands.txt (id,x,y,island_type,available_slots,res+,res-).
 * Fetched lazily (only when someone opens the map), at most once a day per world, kept in memory as a small binary blob:
 *   "GCI2" | uint16 x0 | uint16 y0 | uint16 x1 | uint16 y1 | uint32 n | columns of n bytes: dyLo, dyHi, dxLo, dxHi, type
 * (sorted by y then x; dy from the previous island, dx from the previous island on the same row, else from 0),
 * clipped to the inhabited area (towns' bounding box + a margin): gr125 is ~42k islands ≈ 210 KB raw, ~60 KB gzipped.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileUrl } from '../data/official.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import { log } from '../log.js';

export interface IslandBlob { at: number; raw: Buffer; gz: Buffer; etag: string; count: number }
const TTL = 24 * 3600_000;
const MARGIN = 25;

export function parseIslands(text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const line of text.split('\n')) {
    const c = line.split(',');
    if (c.length < 4) continue;
    const x = Number(c[1]), y = Number(c[2]), t = Number(c[3]);
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(t)) out.push([x, y, t]);
  }
  return out;
}

export function encodeIslands(list: [number, number, number][], box: [number, number, number, number]): Buffer {
  const [x0, y0, x1, y1] = box;
  const inside = list.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const n = inside.length;
  const b = Buffer.alloc(16 + n * 5);
  b.write('GCI2', 0, 'ascii');
  b.writeUInt16LE(x0, 4); b.writeUInt16LE(y0, 6); b.writeUInt16LE(x1, 8); b.writeUInt16LE(y1, 10); b.writeUInt32LE(n, 12);
  // Columnar deltas (rows sorted by y, then x): gzip shrinks this ~2.5× better than plain x,y,type records.
  let py = 0, px = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, t] = inside[i];
    const dy = y - py; if (dy) px = 0;
    const dx = x - px;
    b[16 + i] = dy & 255; b[16 + n + i] = dy >> 8; b[16 + 2 * n + i] = dx & 255; b[16 + 3 * n + i] = dx >> 8; b[16 + 4 * n + i] = t & 255;
    py = y; px = x;
  }
  return b;
}

export function townBox(snap: WorldSnapshot): [number, number, number, number] {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (const t of snap.towns.values()) { x0 = Math.min(x0, t.islandX); y0 = Math.min(y0, t.islandY); x1 = Math.max(x1, t.islandX); y1 = Math.max(y1, t.islandY); }
  if (x1 < 0) return [400, 400, 600, 600];
  return [Math.max(0, x0 - MARGIN), Math.max(0, y0 - MARGIN), Math.min(1000, x1 + MARGIN), Math.min(1000, y1 + MARGIN)];
}

export class IslandCache {
  private m = new Map<string, IslandBlob>();
  private inflight = new Map<string, Promise<IslandBlob | null>>();
  private failedAt = new Map<string, number>();
  constructor(private fetchImpl: typeof fetch = fetch, private now = Date.now) {}

  async get(snap: WorldSnapshot): Promise<IslandBlob | null> {
    const have = this.m.get(snap.world);
    if (have && this.now() - have.at < TTL) return have;
    if (this.now() - (this.failedAt.get(snap.world) ?? -Infinity) < 10 * 60_000) return have ?? null; // don't hammer after a failure
    let p = this.inflight.get(snap.world);
    if (!p) {
      p = this.load(snap).finally(() => this.inflight.delete(snap.world));
      this.inflight.set(snap.world, p);
    }
    return (await p) ?? have ?? null;
  }

  private async load(snap: WorldSnapshot): Promise<IslandBlob | null> {
    try {
      const res = await this.fetchImpl(fileUrl(snap.world, 'islands'), { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
      const raw = encodeIslands(parseIslands(text), townBox(snap));
      const blob: IslandBlob = { at: this.now(), raw, gz: gzipSync(raw, { level: 9 }), etag: `"i${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`, count: raw.readUInt32LE(12) };
      this.m.set(snap.world, blob);
      if (this.m.size > 8) this.m.delete(this.m.keys().next().value!);
      log.info(`web: islands for ${snap.world}: ${blob.count} in the inhabited area, ${raw.length} B raw / ${blob.gz.length} B gzip`);
      return blob;
    } catch (e) {
      this.failedAt.set(snap.world, this.now());
      log.warn(`web: islands for ${snap.world} unavailable: ${(e as Error).message}`);
      return null;
    }
  }
}
