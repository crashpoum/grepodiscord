/** /radar soft, /quitrisk, daily history recording and the optional war-board sections (batch 2). */
import type { APIEmbed, ChatInputCommandInteraction } from 'discord.js';
import type { Town } from '../data/parse.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import { parseOceanList } from '../geo.js';
import { fmt, t, type Lang, type StringKey } from '../i18n.js';
import { resolveAlliance, resolvePlayer, resolveTown, type Ctx } from '../services.js';
import { conquestCounts, dailyRows, dayIn, quitScore, rankQuitters, shiftDay, softTargets, type QuitInputs, type QuitScore, type SoftReason, type SoftTarget } from '../targets.js';
import { worldTz } from '../time.js';
import { md, resolveSides, townsOfAlliances } from '../war.js';
import { UserError } from '../gdServices.js';
import { say } from './opsHandlers.js';

const now = () => Math.floor(Date.now() / 1000);
const COLOR = 0xe67e22;

/** Store today's per-player / per-alliance numbers (one row per world-local day; later refreshes overwrite). */
export function recordHistory(ctx: Ctx, snap: WorldSnapshot, at = now()) {
  const { players, alliances } = dailyRows(snap);
  ctx.store.recordDaily(snap.world, dayIn(worldTz(snap.world), at), players, alliances);
}

export function quitInputs(ctx: Ctx, snap: WorldSnapshot, at = now()): QuitInputs {
  const today = dayIn(worldTz(snap.world), at);
  return { snap, activity: ctx.store.getActivity(snap.world), old: ctx.store.dailyAt(snap.world, 'p', shiftDay(today, -7)), today, now: at, conquest7: conquestCounts(snap, at) };
}

export function guildSides(ctx: Ctx, guildId: string, snap: WorldSnapshot, at = now()) {
  const linked = ctx.store.linksForGuild(guildId).filter((l) => l.world === snap.world).map((l) => l.playerId);
  return resolveSides(snap, ctx.store.getWarSides(guildId, snap.world), linked, at);
}

const REASON_ICON: Record<SoftReason, string> = { ghost: '👻', idle: '💤', stagnant: '📉', lowDef: '🛡️', noDefGrowth: '🧱', isolated: '🏝️', noAlliance: '🚫', smallTown: '🏚️', justConquered: '🔄', shrinking: '🩸' };
export const reasonText = (r: SoftReason, lang: Lang) => `${REASON_ICON[r]} ${t(lang, `soft.r.${r}` as StringKey)}`;

export function softLine(s: SoftTarget, snap: WorldSnapshot, lang: Lang, withFrom = true): string {
  const owner = s.player ? `${md(s.player.name)} [${md(snap.alliances.get(s.player.allianceId ?? -1)?.name ?? '-')}]` : t(lang, 'feed.conquest.ghost');
  const from = withFrom && s.from ? ` · ${s.dist.toFixed(1)} ${t(lang, 'soft.from')} ${md(s.from.name)}` : ` · ${s.dist.toFixed(1)}`;
  const quit = s.quit !== null ? ` · ${t(lang, 'quit.short', { n: s.quit })}` : '';
  return `**${s.score}** · **${md(s.town.name)}** (${fmt(s.town.points, lang)}) (${s.town.islandX}|${s.town.islandY}) · ${owner}${from}${quit}\n  ${s.reasons.map((r) => reasonText(r, lang)).join(' · ')}`;
}

// ---------------------------------------------------------------- /radar soft
export async function radarSoft(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  const snap = await ctx.worlds.ensure(world);
  const at = now();
  const radius = i.options.getInteger('radius') ?? 15;
  const nearQ = i.options.getString('near_town');
  const around = i.options.getString('around');
  const link = i.guildId ? ctx.store.getLink(i.guildId, i.user.id) : null;
  const sides = i.guildId ? guildSides(ctx, i.guildId, snap, at) : { ours: [], enemies: [], autoOurs: true, autoEnemies: true };
  let refs: Town[] = [];
  let scope = '';
  if (nearQ) {
    const tw = resolveTown(snap, nearQ);
    if (!tw) throw new UserError('err.notFound', { q: nearQ, world });
    refs = [tw]; scope = t(lang, 'soft.scope.town', { town: md(tw.name) });
  } else if (around !== 'alliance' && link && link.world === world && snap.townsByPlayer.get(link.playerId)?.length) {
    refs = snap.townsByPlayer.get(link.playerId)!; scope = t(lang, 'soft.scope.me');
  } else if (sides.ours.length) {
    refs = townsOfAlliances(snap, sides.ours); scope = t(lang, 'soft.scope.alliance');
  }
  if (!refs.length) throw new UserError('soft.noRefs');
  const list = softTargets(quitInputs(ctx, snap, at), {
    refs, radius, excludeAllianceIds: sides.ours, excludePlayerIds: link ? [link.playerId] : [],
    oceans: parseOceanList(i.options.getString('ocean')), minPoints: i.options.getInteger('min_points') ?? undefined, maxPoints: i.options.getInteger('max_points') ?? undefined,
    includeGhosts: i.options.getBoolean('ghosts') ?? true, limit: 12,
  });
  const days = ctx.store.historyDays(world).length;
  const embed: APIEmbed = {
    title: t(lang, 'soft.title', { world }),
    description: [t(lang, 'soft.desc', { scope, radius }), '', ...(list.length ? list.map((s) => softLine(s, snap, lang, refs.length > 1)) : [t(lang, 'soft.none')])].join('\n'),
    color: COLOR,
    footer: { text: t(lang, 'soft.footer', { days }) },
  };
  return say(i, '', { embed });
}

// ---------------------------------------------------------------- /quitrisk
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
export function quitLine(q: QuitScore, snap: WorldSnapshot, lang: Lang): string {
  const p = snap.players.get(q.playerId)!;
  const bits: string[] = [];
  if (q.facts.idleHours !== undefined && (q.signals.idle ?? 0) >= 0.3) bits.push(`💤 ${t(lang, 'quit.idle', { h: q.facts.idleHours })}`);
  if (q.facts.pointsPct !== undefined) bits.push(`📈 ${pct(q.facts.pointsPct)} / ${q.facts.spanDays}d`);
  if (q.facts.lost7) bits.push(`🩸 −${q.facts.lost7}${q.facts.gained7 ? ` / +${q.facts.gained7}` : ''} ${t(lang, 'common.towns').toLowerCase()}`);
  if (p.allianceId === null) bits.push(`🚫 ${t(lang, 'soft.r.noAlliance')}`);
  return `**${q.score}%** · **${md(p.name)}** [${md(snap.alliances.get(p.allianceId ?? -1)?.name ?? '-')}] · ${fmt(p.points, lang)} ${t(lang, 'common.points').toLowerCase()}${bits.length ? ` · ${bits.join(' · ')}` : ''} · _${t(lang, 'quit.conf', { n: q.confidence })}_`;
}

export async function handleQuitRisk(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  const snap = await ctx.worlds.ensure(world);
  const at = now();
  const x = quitInputs(ctx, snap, at);
  const days = ctx.store.historyDays(world).length;
  const pq = i.options.getString('player');
  if (pq) {
    const p = resolvePlayer(snap, pq);
    if (!p) throw new UserError('err.notFound', { q: pq, world });
    const q = quitScore(p, x);
    const sig = (k: keyof QuitScore['signals'], fact: string) => (q.signals[k] === undefined ? `${t(lang, `quit.sig.${k}` as StringKey)}: _${t(lang, 'quit.unknown')}_` : `${t(lang, `quit.sig.${k}` as StringKey)}: **${Math.round(q.signals[k]! * 100)}%** · ${fact}`);
    const f = q.facts;
    const lines = [
      sig('idle', f.idleHours !== undefined ? t(lang, 'quit.idleFact', { h: f.idleHours, tracked: f.trackedHours ?? 0 }) : '-'),
      sig('points', f.pointsDelta !== undefined ? `${f.pointsDelta >= 0 ? '+' : ''}${fmt(f.pointsDelta, lang)} (${pct(f.pointsPct ?? 0)}) / ${f.spanDays}d` : '-'),
      sig('bp', f.bpDelta !== undefined ? `+${fmt(f.bpDelta, lang)} BP / ${f.spanDays}d` : '-'),
      sig('towns', t(lang, 'quit.townsFact', { lost: f.lost7, gained: f.gained7 })),
      sig('alliance', p.allianceId === null ? t(lang, 'soft.r.noAlliance') : md(snap.alliances.get(p.allianceId)?.name ?? '-')),
    ];
    const bar = '█'.repeat(Math.round(q.score / 10)) + '░'.repeat(10 - Math.round(q.score / 10));
    return say(i, '', { embed: {
      title: t(lang, 'quit.titleOne', { name: p.name, world }),
      description: [`${bar} **${q.score}%** · ${t(lang, 'quit.conf', { n: q.confidence })}`, '', ...lines].join('\n'),
      color: q.score >= 60 ? 0xed4245 : q.score >= 35 ? 0xfee75c : 0x57f287,
      footer: { text: t(lang, 'quit.footer', { days }) },
    } });
  }
  const aq = i.options.getString('alliance');
  const nearQ = i.options.getString('near_town');
  const radius = i.options.getInteger('radius') ?? 20;
  let allianceIds: number[] | undefined;
  let scope: string;
  let rows: QuitScore[];
  const minPoints = i.options.getInteger('min_points') ?? undefined;
  if (aq) {
    const a = resolveAlliance(snap, aq);
    if (!a) throw new UserError('err.notFound', { q: aq, world });
    allianceIds = [a.id]; scope = md(a.name);
    rows = rankQuitters(x, { allianceIds, minPoints, limit: 15 });
  } else if (nearQ) {
    const tw = resolveTown(snap, nearQ);
    if (!tw) throw new UserError('err.notFound', { q: nearQ, world });
    scope = t(lang, 'soft.scope.town', { town: md(tw.name) });
    const nearIds = new Set<number>();
    for (const tt of snap.towns.values()) if (tt.playerId !== null && Math.hypot(tt.islandX - tw.islandX, tt.islandY - tw.islandY) <= radius) nearIds.add(tt.playerId);
    rows = rankQuitters({ ...x, snap: { ...snap, players: new Map([...snap.players].filter(([id]) => nearIds.has(id))) } }, { minPoints, limit: 15 });
  } else {
    const sides = i.guildId ? guildSides(ctx, i.guildId, snap, at) : null;
    if (sides?.enemies.length) { allianceIds = sides.enemies; scope = t(lang, 'quit.scope.enemies'); rows = rankQuitters(x, { allianceIds, minPoints, limit: 15 }); }
    else { scope = t(lang, 'quit.scope.world'); rows = rankQuitters(x, { minPoints: minPoints ?? 1000, excludeAllianceIds: sides?.ours, limit: 15 }); }
  }
  return say(i, '', { embed: {
    title: t(lang, 'quit.title', { world }),
    description: [t(lang, 'quit.desc', { scope }), '', ...(rows.length ? rows.map((q) => quitLine(q, snap, lang)) : [t(lang, 'soft.none')])].join('\n'),
    color: COLOR,
    footer: { text: t(lang, 'quit.footer', { days }) },
  } });
}

// ---------------------------------------------------------------- war board extras
export const BOARD_KEYS = { quitters: 'board.quitters', soft: 'board.soft' } as const;

/** Optional board sections (enabled with /warroom options). Returns ready-to-render markdown blocks. */
export function boardExtras(ctx: Ctx, guildId: string, snap: WorldSnapshot, lang: Lang, at = now()): string[] {
  const out: string[] = [];
  const wantQ = ctx.store.getSetting(guildId, BOARD_KEYS.quitters) === '1';
  const wantS = ctx.store.getSetting(guildId, BOARD_KEYS.soft) === '1';
  if (!wantQ && !wantS) return out;
  const sides = guildSides(ctx, guildId, snap, at);
  const x = quitInputs(ctx, snap, at);
  if (wantQ) {
    const rows = sides.enemies.length ? rankQuitters(x, { allianceIds: sides.enemies, limit: 5 }).filter((q) => q.score >= 40) : [];
    out.push([`### ${t(lang, 'war.quitters')}`, ...(rows.length ? rows.map((q) => `• ${quitLine(q, snap, lang)}`) : [t(lang, 'war.noneQuit')])].join('\n'));
  }
  if (wantS) {
    const refs = townsOfAlliances(snap, sides.ours);
    const rows = refs.length ? softTargets(x, { refs, radius: 12, excludeAllianceIds: sides.ours, limit: 5 }) : [];
    out.push([`### ${t(lang, 'war.soft')}`, ...(rows.length ? rows.map((s) => `• ${softLine(s, snap, lang)}`) : [t(lang, 'soft.none')])].join('\n'));
  }
  return out;
}

