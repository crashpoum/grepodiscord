/** Builds plain Discord embed objects (APIEmbed) so they can be sent by the bot or printed by the CLI. */
import type { APIEmbed } from 'discord.js';
import type { Conquest, Player } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { townOcean } from './data/snapshot.js';
import type { AllianceChange, BpDelta } from './diff.js';
import type { GdAllianceInfo, GdPlayerInfo } from './data/grepodata.js';
import type { GhostHit, InactiveHit } from './radar.js';
import { fmt, t, type Lang } from './i18n.js';

export const COLORS = { conquest: 0xc0392b, alliance: 0x2980b9, bp: 0xe67e22, player: 0x16a085, radar: 0x8e44ad, info: 0x7f8c8d } as const;
const MAX_DESC = 3900;

/** Escape Discord markdown in user-controlled names (player/town/alliance names). */
export const md = (s: string) => s.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1');

export const allianceName = (snap: WorldSnapshot, id: number | null, lang: Lang) =>
  id === null ? `_${t(lang, 'common.none')}_` : md(snap.alliances.get(id)?.name ?? `#${id}`);
export const playerName = (snap: WorldSnapshot, id: number | null, lang: Lang) =>
  id === null ? t(lang, 'feed.conquest.ghost') : md(snap.players.get(id)?.name ?? `#${id}`);

export function playerUrl(world: string, id: number) { return `https://grepodata.com/player?world=${world}&id=${id}`; }
export function allianceUrl(world: string, id: number) { return `https://grepodata.com/alliance?world=${world}&id=${id}`; }

export function conquestEmbed(lang: Lang, snap: WorldSnapshot, c: Conquest): APIEmbed {
  const town = snap.towns.get(c.townId);
  const name = town?.name ?? `#${c.townId}`;
  const internal = c.newAllianceId !== null && c.newAllianceId === c.oldAllianceId;
  return {
    title: t(lang, 'feed.conquest.title', { town: name }),
    description: t(lang, 'feed.conquest.desc', {
      newp: playerName(snap, c.newPlayerId, lang), newa: allianceName(snap, c.newAllianceId, lang),
      town: md(name), points: fmt(c.townPoints, lang), ocean: town ? townOcean(town) : '?',
      oldp: playerName(snap, c.oldPlayerId, lang), olda: allianceName(snap, c.oldAllianceId, lang),
    }) + (internal ? `\n_${t(lang, 'feed.conquest.internal')}_` : ''),
    color: COLORS.conquest,
    timestamp: new Date(c.time * 1000).toISOString(),
    footer: { text: `${snap.world}${town ? ` · (${town.islandX}|${town.islandY})` : ''}` },
  };
}

function chunkLines(lines: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > MAX_DESC) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) out.push(cur);
  return out;
}

export function allianceChangesEmbeds(lang: Lang, snap: WorldSnapshot, changes: AllianceChange[]): APIEmbed[] {
  const lines = changes.map((c) => t(lang, `feed.alliance.${c.kind}`, {
    player: md(c.playerName), from: allianceName(snap, c.fromAllianceId, lang), to: allianceName(snap, c.toAllianceId, lang),
  }));
  return chunkLines(lines).map((d) => ({ title: t(lang, 'feed.alliance.title'), description: d, color: COLORS.alliance, footer: { text: snap.world }, timestamp: new Date().toISOString() }));
}

export function bpEmbeds(lang: Lang, snap: WorldSnapshot, deltas: BpDelta[]): APIEmbed[] {
  const lines = deltas.map((d) => {
    const p = snap.players.get(d.id);
    return t(lang, 'feed.bp.line', {
      player: md(p?.name ?? `#${d.id}`), alliance: allianceName(snap, p?.allianceId ?? null, lang),
      delta: fmt(d.delta, lang), kind: d.kind === 'att' ? t(lang, 'common.abp') : t(lang, 'common.dbp'), total: fmt(d.total, lang),
    });
  });
  return chunkLines(lines).map((d) => ({ title: t(lang, 'feed.bp.title'), description: d, color: COLORS.bp, footer: { text: snap.world }, timestamp: new Date().toISOString() }));
}

export function playerEmbed(lang: Lang, world: string, p: Player, snap: WorldSnapshot | undefined, gd: GdPlayerInfo | null, abp: number, dbp: number): APIEmbed {
  const fields = [
    { name: t(lang, 'common.points'), value: fmt(gd?.points ?? p.points, lang), inline: true },
    { name: t(lang, 'common.rank'), value: `#${gd?.rank ?? p.rank}`, inline: true },
    { name: t(lang, 'common.towns'), value: fmt(gd?.towns ?? p.towns, lang), inline: true },
    { name: t(lang, 'common.abp'), value: fmt(gd?.att ?? abp, lang) + (gd?.att_rank ? ` (#${gd.att_rank})` : ''), inline: true },
    { name: t(lang, 'common.dbp'), value: fmt(gd?.def ?? dbp, lang) + (gd?.def_rank ? ` (#${gd.def_rank})` : ''), inline: true },
    { name: t(lang, 'common.alliance'), value: snap ? allianceName(snap, p.allianceId, lang) : String(p.allianceId ?? '-'), inline: true },
  ];
  if (gd?.hours_inactive !== undefined) fields.push({ name: t(lang, 'player.hoursInactive'), value: String(gd.hours_inactive), inline: true });
  return { title: p.name, url: playerUrl(world, p.id), color: COLORS.player, fields, footer: { text: `${world} · ${t(lang, 'common.source')}` } };
}

export function allianceEmbed(lang: Lang, world: string, a: { id: number; name: string; points: number; rank: number; towns: number; members: number }, gd: GdAllianceInfo | null, abp: number, dbp: number): APIEmbed {
  return {
    title: a.name, url: allianceUrl(world, a.id), color: COLORS.player,
    fields: [
      { name: t(lang, 'common.points'), value: fmt(gd?.points ?? a.points, lang), inline: true },
      { name: t(lang, 'common.rank'), value: `#${gd?.rank ?? a.rank}`, inline: true },
      { name: t(lang, 'common.members'), value: fmt(gd?.members ?? a.members, lang), inline: true },
      { name: t(lang, 'common.towns'), value: fmt(gd?.towns ?? a.towns, lang), inline: true },
      { name: t(lang, 'common.abp'), value: fmt(gd?.att ?? abp, lang), inline: true },
      { name: t(lang, 'common.dbp'), value: fmt(gd?.def ?? dbp, lang), inline: true },
    ],
    footer: { text: `${world} · ${t(lang, 'common.source')}` },
  };
}

const distStr = (lang: Lang, d?: number) => (d === undefined ? '' : ` · ${t(lang, 'common.distance')} ${d.toFixed(1)}`);

export function inactiveEmbed(lang: Lang, snap: WorldSnapshot, hits: InactiveHit[], note: string): APIEmbed {
  const lines = hits.map((h) => t(lang, 'radar.inactive.line', {
    player: md(h.player.name), alliance: allianceName(snap, h.player.allianceId, lang), points: fmt(h.player.points, lang),
    hours: h.hoursInactive + (h.source === 'grepodata' ? '*' : ''), town: md(h.town.name), ocean: townOcean(h.town), dist: distStr(lang, h.dist),
  }));
  return { title: t(lang, 'radar.inactive.title', { world: snap.world }), description: (lines.length ? lines.join('\n') : t(lang, 'radar.none')).slice(0, MAX_DESC), color: COLORS.radar, footer: { text: note.slice(0, 2000) } };
}

export function ghostEmbed(lang: Lang, snap: WorldSnapshot, hits: GhostHit[]): APIEmbed {
  const lines = hits.map((h) => t(lang, 'radar.ghost.line', {
    town: md(h.town.name), points: fmt(h.town.points, lang), ocean: h.ocean, x: h.town.islandX, y: h.town.islandY, dist: distStr(lang, h.dist),
  }));
  return { title: t(lang, 'radar.ghost.title', { world: snap.world }), description: (lines.length ? lines.join('\n') : t(lang, 'radar.none')).slice(0, MAX_DESC), color: COLORS.radar, footer: { text: snap.world } };
}

/** Plain-text rendering of an embed for the CLI dry-run. */
export function embedToText(e: APIEmbed): string {
  const out: string[] = [];
  out.push(`┌─ ${e.title ?? ''}${e.url ? `  <${e.url}>` : ''}`);
  if (e.description) for (const l of e.description.split('\n')) out.push(`│ ${l}`);
  for (const f of e.fields ?? []) out.push(`│ ${f.name}: ${f.value}`);
  if (e.image?.url) out.push(`│ [image: ${e.image.url}]`);
  if (e.footer?.text || e.timestamp) out.push(`└─ ${e.footer?.text ?? ''}${e.timestamp ? ` · ${e.timestamp}` : ''}`);
  return out.join('\n');
}
