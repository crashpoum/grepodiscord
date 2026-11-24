/**
 * War room: pure model + Components V2 rendering for the auto-editing board.
 * Everything here is computed from the official public world files (no API calls), so a board refresh
 * costs nothing against the GrepoData budget.
 */
import type { Baseline } from './db.js';
import type { Conquest, Town } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { distance } from './geo.js';
import { fmt, t, type Lang } from './i18n.js';

const DAY = 86_400;

export interface WarSides { ours: number[]; enemies: number[]; autoOurs: boolean; autoEnemies: boolean }

/**
 * Our side = configured alliances, else the alliances of verified members.
 * Enemies = configured alliances, else the (up to 5) alliances that took the most towns from us in the last 7 days.
 */
export function resolveSides(snap: WorldSnapshot, explicit: { ours: number[]; enemies: number[] }, linkedPlayerIds: number[], now: number): WarSides {
  let ours = explicit.ours.filter((id) => snap.alliances.has(id));
  const autoOurs = ours.length === 0;
  if (autoOurs) {
    const set = new Set<number>();
    for (const pid of linkedPlayerIds) { const a = snap.players.get(pid)?.allianceId; if (a) set.add(a); }
    ours = [...set];
  }
  let enemies = explicit.enemies.filter((id) => snap.alliances.has(id) && !ours.includes(id));
  const autoEnemies = enemies.length === 0;
  if (autoEnemies && ours.length) {
    const count = new Map<number, number>();
    for (const c of snap.conquers) {
      if (c.time < now - 7 * DAY || c.oldAllianceId === null || !ours.includes(c.oldAllianceId)) continue;
      if (c.newAllianceId === null || ours.includes(c.newAllianceId)) continue;
      count.set(c.newAllianceId, (count.get(c.newAllianceId) ?? 0) + 1);
    }
    enemies = [...count].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id).filter((id) => snap.alliances.has(id));
  }
  return { ours, enemies, autoOurs, autoEnemies };
}

export type ConquestDir = 'for' | 'against' | 'internal';
export interface BoardConquest { c: Conquest; dir: ConquestDir }
export interface ScoreRow { allianceId: number; gained24: number; lost24: number; gained7: number; lost7: number }
export interface Mover { playerId: number; allianceId: number | null; side: 'ours' | 'enemy'; abp: number; dbp: number }
export interface Frontline { enemyTown: Town; ourTown: Town; dist: number }
export interface NearConquest { c: Conquest; ourTown: Town; dist: number }
export interface BoardModel {
  world: string; now: number; sides: WarSides;
  totals: Omit<ScoreRow, 'allianceId'>; score: ScoreRow[];
  recent: BoardConquest[]; movers: Mover[]; baselineAt: number | null;
  frontline: Frontline[]; nearConquests: NearConquest[];
}

/** Nearest-town helper with a coarse grid so 1000s × 1000s town pairs stay fast. */
export class TownGrid {
  private cells = new Map<string, Town[]>();
  constructor(towns: Iterable<Town>, private cell = 10) {
    for (const x of towns) { const k = this.key(x.islandX, x.islandY); const a = this.cells.get(k) ?? []; a.push(x); this.cells.set(k, a); }
  }
  private key(x: number, y: number) { return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`; }
  get size() { let n = 0; for (const a of this.cells.values()) n += a.length; return n; }
  /** Nearest town within `maxDist` (island units), or null. */
  nearest(x: number, y: number, maxDist: number): { town: Town; dist: number } | null {
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best: { town: Town; dist: number } | null = null;
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      for (const tw of this.cells.get(`${i}:${j}`) ?? []) {
        const d = distance(x, y, tw.islandX, tw.islandY);
        if (d <= maxDist && (!best || d < best.dist)) best = { town: tw, dist: d };
      }
    }
    return best;
  }
}

export function townsOfAlliances(snap: WorldSnapshot, ids: number[]): Town[] {
  const set = new Set(ids);
  const out: Town[] = [];
  for (const x of snap.towns.values()) {
    if (x.playerId === null) continue;
    const a = snap.players.get(x.playerId)?.allianceId;
    if (a && set.has(a)) out.push(x);
  }
  return out;
}

export function buildBoard(snap: WorldSnapshot, sides: WarSides, baselines: Map<number, Baseline>, now: number, opts: { nearRadius?: number } = {}): BoardModel {
  const ours = new Set(sides.ours);
  const enemies = new Set(sides.enemies);
  const isOurs = (a: number | null) => a !== null && ours.has(a);
  const score = new Map<number, ScoreRow>(sides.enemies.map((id) => [id, { allianceId: id, gained24: 0, lost24: 0, gained7: 0, lost7: 0 }]));
  const totals = { gained24: 0, lost24: 0, gained7: 0, lost7: 0 };
  const recent: BoardConquest[] = [];
  for (const c of snap.conquers) {
    if (c.time < now - 7 * DAY) continue;
    const gain = isOurs(c.newAllianceId) && !isOurs(c.oldAllianceId);
    const loss = isOurs(c.oldAllianceId) && !isOurs(c.newAllianceId);
    const internal = isOurs(c.newAllianceId) && isOurs(c.oldAllianceId);
    const in24 = c.time >= now - DAY;
    if (gain) { totals.gained7++; if (in24) totals.gained24++; }
    if (loss) { totals.lost7++; if (in24) totals.lost24++; }
    const enemyId = gain ? c.oldAllianceId : loss ? c.newAllianceId : null;
    const row = enemyId !== null ? score.get(enemyId) : undefined;
    if (row) { if (gain) { row.gained7++; if (in24) row.gained24++; } else { row.lost7++; if (in24) row.lost24++; } }
    if (in24 && (gain || loss || internal)) recent.push({ c, dir: gain ? 'for' : loss ? 'against' : 'internal' });
  }
  recent.sort((a, b) => b.c.time - a.c.time);

  // Top movers since the baseline (BP gained), best 4 per side.
  const movers: Mover[] = [];
  let baselineAt: number | null = null;
  for (const b of baselines.values()) { baselineAt = baselineAt === null ? b.ts : Math.min(baselineAt, b.ts); }
  if (baselines.size) {
    for (const p of snap.players.values()) {
      const side = isOurs(p.allianceId) ? 'ours' : p.allianceId !== null && enemies.has(p.allianceId) ? 'enemy' : null;
      if (!side) continue;
      const b = baselines.get(p.id);
      if (!b) continue;
      const abp = (snap.playerAbp.get(p.id) ?? 0) - b.abp;
      const dbp = (snap.playerDbp.get(p.id) ?? 0) - b.dbp;
      if (abp + dbp > 0) movers.push({ playerId: p.id, allianceId: p.allianceId, side, abp: Math.max(0, abp), dbp: Math.max(0, dbp) });
    }
  }
  const topMovers = (['ours', 'enemy'] as const).flatMap((s) => movers.filter((m) => m.side === s).sort((a, b) => b.abp + b.dbp - (a.abp + a.dbp)).slice(0, 4));

  // Frontline: our towns closest to an enemy town (unique our town), and enemy conquests near our towns.
  const ourTowns = townsOfAlliances(snap, sides.ours);
  const enemyTowns = townsOfAlliances(snap, sides.enemies);
  const frontline: Frontline[] = [];
  const nearR = opts.nearRadius ?? 15;
  if (ourTowns.length && enemyTowns.length) {
    const grid = new TownGrid(enemyTowns);
    for (const o of ourTowns) {
      const n = grid.nearest(o.islandX, o.islandY, nearR);
      if (n) frontline.push({ enemyTown: n.town, ourTown: o, dist: n.dist });
    }
    frontline.sort((a, b) => a.dist - b.dist);
  }
  const nearConquests: NearConquest[] = [];
  if (ourTowns.length) {
    const grid = new TownGrid(ourTowns);
    for (const c of snap.conquers) {
      if (c.time < now - DAY || c.newAllianceId === null || !enemies.has(c.newAllianceId) || isOurs(c.oldAllianceId)) continue;
      const x = snap.towns.get(c.townId);
      if (!x) continue;
      const n = grid.nearest(x.islandX, x.islandY, nearR);
      if (n) nearConquests.push({ c, ourTown: n.town, dist: n.dist });
    }
    nearConquests.sort((a, b) => b.c.time - a.c.time);
  }
  return {
    world: snap.world, now, sides, totals, score: [...score.values()].sort((a, b) => b.lost7 + b.gained7 - (a.lost7 + a.gained7)),
    recent, movers: topMovers, baselineAt, frontline: frontline.slice(0, 5), nearConquests: nearConquests.slice(0, 5),
  };
}

/** Rolling 24h baseline: returns the rows to store when the current one is missing or older than `maxAgeSec`. */
export function nextBaselines(snap: WorldSnapshot, current: Map<number, Baseline>, now: number, maxAgeSec = DAY): Baseline[] | null {
  let oldest = Infinity;
  for (const b of current.values()) oldest = Math.min(oldest, b.ts);
  if (current.size && now - oldest < maxAgeSec) return null;
  return [...snap.players.values()].map((p) => ({ id: p.id, points: p.points, abp: snap.playerAbp.get(p.id) ?? 0, dbp: snap.playerDbp.get(p.id) ?? 0, towns: p.towns, ts: now }));
}

// ---------------------------------------------------------------- rendering (Components V2 JSON)
const md = (s: string) => s.replace(/([*_`~|\\>])/g, '\\$1');
/** Discord limit: all Text Display content in one message ≤ 4000 characters. */
export const V2_TEXT_LIMIT = 4000;

export function renderBoard(m: BoardModel, snap: WorldSnapshot, lang: Lang, boardId: number) {
  const an = (id: number | null) => (id === null ? '-' : md(snap.alliances.get(id)?.name ?? `#${id}`));
  const pn = (id: number | null) => (id === null ? t(lang, 'feed.conquest.ghost') : md(snap.players.get(id)?.name ?? `#${id}`));
  const tn = (id: number) => md(snap.towns.get(id)?.name ?? `#${id}`);
  const ts = (sec: number, s = 'R') => `<t:${sec}:${s}>`;
  const sideNames = (ids: number[], auto: boolean) => (ids.length ? ids.map(an).join(', ') : '-') + (auto ? ` _(${t(lang, 'war.auto')})_` : '');

  const head = [
    `## ${t(lang, 'war.title', { world: m.world })}`,
    `${t(lang, 'war.ours')}: **${sideNames(m.sides.ours, m.sides.autoOurs)}**`,
    `${t(lang, 'war.enemies')}: **${sideNames(m.sides.enemies, m.sides.autoEnemies)}**`,
  ].join('\n');

  const sc = [`### ${t(lang, 'war.score')}`,
    t(lang, 'war.totals', { g24: m.totals.gained24, l24: m.totals.lost24, g7: m.totals.gained7, l7: m.totals.lost7 }),
    ...m.score.slice(0, 5).map((r) => `• vs **${an(r.allianceId)}**: ${t(lang, 'war.scoreLine', { g24: r.gained24, l24: r.lost24, g7: r.gained7, l7: r.lost7 })}`),
  ].join('\n');

  const icon = { for: '🟢', against: '🔴', internal: '⚪' } as const;
  const rec = [`### ${t(lang, 'war.recent')}`,
    ...(m.recent.length ? m.recent.slice(0, 8).map(({ c, dir }) => `${icon[dir]} ${ts(c.time)} **${tn(c.townId)}** (${fmt(c.townPoints, lang)}) · ${pn(c.newPlayerId)} [${an(c.newAllianceId)}] ← ${pn(c.oldPlayerId)} [${an(c.oldAllianceId)}]`) : [t(lang, 'war.none')]),
  ].join('\n');

  const mov = [`### ${t(lang, 'war.movers')}${m.baselineAt ? ` · ${t(lang, 'war.since', { t: ts(m.baselineAt) })}` : ''}`,
    ...(m.movers.length ? m.movers.map((x) => `${x.side === 'ours' ? '🟦' : '🟥'} **${pn(x.playerId)}** [${an(x.allianceId)}] ⚔️ +${fmt(x.abp, lang)} · 🛡️ +${fmt(x.dbp, lang)}`) : [t(lang, 'war.noMovers')]),
  ].join('\n');

  const thr = [`### ${t(lang, 'war.threats')}`,
    ...m.nearConquests.map((n) => `🚨 ${ts(n.c.time)} ${pn(n.c.newPlayerId)} [${an(n.c.newAllianceId)}] ${t(lang, 'war.tookNear', { town: tn(n.c.townId), ours: md(n.ourTown.name), dist: n.dist.toFixed(1) })}`),
    ...m.frontline.map((f) => `⚠️ ${t(lang, 'war.frontline', { enemy: md(f.enemyTown.name), owner: pn(f.enemyTown.playerId), ours: md(f.ourTown.name), mine: pn(f.ourTown.playerId), dist: f.dist.toFixed(1) })}`),
  ];
  if (thr.length === 1) thr.push(t(lang, 'war.noThreats'));

  const foot = `-# ${t(lang, 'war.footer', { t: ts(m.now), id: boardId })}`;
  const blocks = [head, sc, rec, mov, thr.join('\n'), foot];
  // Enforce the 4000-char total: trim the longest blocks line by line.
  const total = () => blocks.reduce((s, b) => s + b.length, 0);
  while (total() > V2_TEXT_LIMIT) {
    const i = blocks.reduce((bi, b, k) => (b.length > blocks[bi].length ? k : bi), 0);
    const lines = blocks[i].split('\n');
    if (lines.length <= 1) { blocks[i] = blocks[i].slice(0, Math.max(0, blocks[i].length - (total() - V2_TEXT_LIMIT))); break; }
    lines.pop();
    blocks[i] = lines.join('\n');
  }
  const text = (content: string) => ({ type: 10, content });
  const sep = { type: 14, divider: true, spacing: 1 };
  const comps: unknown[] = [];
  blocks.forEach((b, k) => { if (k > 0 && k < blocks.length - 1) comps.push(sep); comps.push(text(b)); });
  const accent = m.totals.lost24 > m.totals.gained24 ? 0xed4245 : m.totals.gained24 > 0 ? 0x57f287 : 0x5865f2;
  return [
    { type: 17, accent_color: accent, components: comps },
    { type: 1, components: [{ type: 2, style: 2, custom_id: `warroom:refresh:${boardId}`, label: t(lang, 'war.refresh'), emoji: { name: '🔄' } }] },
  ];
}
