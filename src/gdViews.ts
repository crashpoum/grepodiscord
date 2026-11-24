/**
 * Embed builders for the GrepoData-backed features (rankings, wars, changes, conquest history, towns, intel).
 * Pure functions: data in, APIEmbed out, so they are unit-tested and shared by the bot and the CLI.
 */
import type { APIEmbed } from 'discord.js';
import type {
  GdBrowseIntel, GdChange, GdConquest, GdHourDiff, GdIntelUnit, GdRadarTown, GdRankRow, GdScoreboard, GdScoreEntry, GdTownHit, GdTownInfo, GdTownIntel, GdWar,
} from './data/grepodata.js';
import { allianceUrl, md, playerUrl } from './embeds.js';
import { fmt, t, type Lang } from './i18n.js';
import { discordTs, localToEpoch, worldTz } from './time.js';
import { oceanOf } from './geo.js';

const MAX_DESC = 3900;
export const GD_COLORS = { top: 0xf1c40f, wars: 0xc0392b, changes: 0x2980b9, conquest: 0xa93226, town: 0x16a085, intel: 0x6c3483 } as const;
const footer = (lang: Lang, world: string) => ({ text: `${world} · ${t(lang, 'gd.source')}` });
const desc = (lines: string[], lang: Lang) => (lines.length ? lines.join('\n') : t(lang, 'gd.none')).slice(0, MAX_DESC);
const aName = (lang: Lang, name: string | undefined | null, id?: number | null) => (id && name ? md(name) : name ? md(name) : `_${t(lang, 'common.none')}_`);
const medal = (k: number) => (['🥇', '🥈', '🥉'][k] ?? `${k + 1}.`);

export type TopKind = 'player' | 'alliance';

/** Daily scoreboard (today/yesterday): top attackers, defenders, conquerors, losers. */
export function scoreboardEmbed(lang: Lang, world: string, kind: TopKind, sb: GdScoreboard, yesterday: boolean, limit = 10): APIEmbed {
  const col = (rows: GdScoreEntry[] | undefined, unit: 'bp' | 'towns') =>
    (rows ?? []).slice(0, limit).map((r, k) => `${medal(k)} ${md(r.n)} · **${fmt(r.s, lang)}**${unit === 'towns' ? '' : ''}`).join('\n') || '-';
  const updated = localToEpoch(`${sb.date} ${sb.time}`, worldTz(world));
  return {
    title: t(lang, yesterday ? 'top.yesterday.title' : 'top.today.title', { kind: t(lang, kind === 'player' ? 'gd.players' : 'gd.alliances'), world, date: sb.date }),
    color: GD_COLORS.top,
    fields: [
      { name: t(lang, 'top.att'), value: col(sb.att, 'bp').slice(0, 1024), inline: true },
      { name: t(lang, 'top.def'), value: col(sb.def, 'bp').slice(0, 1024), inline: true },
      { name: '\u200b', value: '\u200b', inline: false },
      { name: t(lang, 'top.con'), value: col(sb.con, 'towns').slice(0, 1024), inline: true },
      { name: t(lang, 'top.los'), value: col(sb.los, 'towns').slice(0, 1024), inline: true },
    ],
    description: yesterday ? undefined : t(lang, 'top.updated', { time: discordTs(updated, 'R') }),
    footer: footer(lang, world),
  };
}

/** Battle points gained in one hour (players). */
export function hourEmbed(lang: Lang, world: string, date: string, hour: number, d: { att: GdHourDiff[]; def: GdHourDiff[] }, limit = 10): APIEmbed {
  const col = (rows: GdHourDiff[] | undefined) => (rows ?? []).slice(0, limit).map((r, k) => `${medal(k)} ${md(r.name)}${r.alliance_name ? ` [${md(r.alliance_name)}]` : ''} · **${fmt(r.value, lang)}**`).join('\n') || '-';
  const start = localToEpoch(`${date} ${String(hour).padStart(2, '0')}:00:00`, worldTz(world));
  return {
    title: t(lang, 'top.hour.title', { world }),
    description: t(lang, 'top.hour.window', { from: discordTs(start, 'f'), to: discordTs(start === null ? null : start + 3600, 't') }),
    color: GD_COLORS.top,
    fields: [{ name: t(lang, 'top.att'), value: col(d.att).slice(0, 1024), inline: true }, { name: t(lang, 'top.def'), value: col(d.def).slice(0, 1024), inline: true }],
    footer: footer(lang, world),
  };
}

export const RANK_SORTS = ['Points', 'Att', 'Def', 'AttDef', 'Towns', 'Members'] as const;
export type RankSort = (typeof RANK_SORTS)[number];

export function rankingEmbed(lang: Lang, world: string, kind: TopKind, sort: RankSort, r: { count: number; results: GdRankRow[] }, from = 0): APIEmbed {
  const lines = r.results.map((x, k) => {
    const main = sort === 'Att' ? x.att : sort === 'Def' ? x.def : sort === 'AttDef' ? (x.att ?? 0) + (x.def ?? 0) : sort === 'Towns' ? x.towns : sort === 'Members' ? x.members : x.points;
    const link = kind === 'player' ? playerUrl(world, x.id) : allianceUrl(world, x.id);
    const extra = kind === 'player' ? (x.alliance_name ? ` [${md(x.alliance_name)}]` : '') : ` · ${x.members ?? '?'} ${t(lang, 'gd.membersShort')}`;
    return `**${from + k + 1}.** [${md(x.name)}](${link})${extra} · **${fmt(Number(main ?? 0), lang)}**${sort !== 'Points' ? ` · ${fmt(x.points, lang)} ${t(lang, 'gd.ptsShort')}` : ''}`;
  });
  return {
    title: t(lang, 'top.ranking.title', { kind: t(lang, kind === 'player' ? 'gd.players' : 'gd.alliances'), sort: t(lang, `sort.${sort}` as 'sort.Points'), world }),
    description: desc(lines, lang), color: GD_COLORS.top, footer: { text: `${world} · ${t(lang, 'gd.total', { count: fmt(r.count, lang) })} · ${t(lang, 'gd.source')}` },
  };
}

export function warsEmbed(lang: Lang, world: string, alliance: { id: number; name: string }, wars: GdWar[], limit = 20): APIEmbed {
  const sorted = [...wars].sort((a, b) => b.towns_gained_from + b.towns_lost_to - (a.towns_gained_from + a.towns_lost_to)).slice(0, limit);
  const lines = sorted.map((w) => t(lang, 'wars.line', {
    alliance: w.alliance_id ? `[${md(w.alliance_name || `#${w.alliance_id}`)}](${allianceUrl(world, w.alliance_id)})` : `_${t(lang, 'wars.noAlliance')}_`,
    gained: w.towns_gained_from, lost: w.towns_lost_to, net: (w.towns_gained_from - w.towns_lost_to > 0 ? '+' : '') + (w.towns_gained_from - w.towns_lost_to),
  }));
  const tg = wars.reduce((s, w) => s + w.towns_gained_from, 0);
  const tl = wars.reduce((s, w) => s + w.towns_lost_to, 0);
  return {
    title: t(lang, 'wars.title', { alliance: alliance.name, world }), url: allianceUrl(world, alliance.id),
    description: `${t(lang, 'wars.total', { gained: tg, lost: tl })}\n\n${desc(lines, lang)}`.slice(0, MAX_DESC), color: GD_COLORS.wars, footer: footer(lang, world),
  };
}

export type ChangeScope = 'alliance' | 'player' | 'world';
export function changeTime(c: GdChange, world: string): number | null {
  return localToEpoch(typeof c.date === 'string' ? c.date : c.date?.date, worldTz(world));
}
export function changesEmbed(lang: Lang, world: string, scope: ChangeScope, subject: string, r: { count: number; items: GdChange[] }, from = 0): APIEmbed {
  const lines = r.items.map((c) => t(lang, 'changes.line', {
    date: discordTs(changeTime(c, world), 'd'), player: md(c.player_name),
    from: aName(lang, c.old_alliance_name, c.old_alliance_grep_id), to: aName(lang, c.new_alliance_name, c.new_alliance_grep_id),
  }));
  return {
    title: t(lang, `changes.title.${scope}`, { name: subject, world }), description: desc(lines, lang), color: GD_COLORS.changes,
    footer: { text: `${world} · ${t(lang, 'gd.page', { from: r.items.length ? from + 1 : 0, to: r.items.length ? from + r.items.length : 0, count: fmt(r.count, lang) })} · ${t(lang, 'gd.source')}` },
  };
}

export function conquestHistoryEmbed(lang: Lang, world: string, scope: 'player' | 'alliance' | 'town', subject: string, r: { count: number; conq: GdConquest[] }, from = 0): APIEmbed {
  const tz = worldTz(world);
  const who = (p: string, a: string) => (p ? `${md(p)}${a ? ` [${md(a)}]` : ''}` : `_${t(lang, 'conq.ghost')}_`);
  const lines = r.conq.map((c) => {
    const tag = c.type === 'internal' ? '🔁' : c.type === 'friendly' ? '🤝' : '⚔️';
    return t(lang, 'conq.line', {
      tag, date: discordTs(localToEpoch(c.time, tz), 'd'), town: md(c.town_name || `#${c.town_id}`), points: fmt(c.points ?? 0, lang),
      new: who(c.n_p_name, c.n_a_name), old: who(c.o_p_name, c.o_a_name),
    });
  });
  return {
    title: t(lang, `conq.title.${scope}`, { name: subject, world }), description: desc(lines, lang), color: GD_COLORS.conquest,
    footer: { text: `${world} · ${t(lang, 'gd.page', { from: r.conq.length ? from + 1 : 0, to: r.conq.length ? from + r.conq.length : 0, count: fmt(r.count, lang) })} · ${t(lang, 'conq.legend')}` },
  };
}

export function townSearchEmbed(lang: Lang, world: string, query: string, hits: GdTownHit[]): APIEmbed {
  const lines = hits.map((h) => t(lang, 'town.search.line', {
    town: md(h.name), points: fmt(h.points, lang), player: h.player_name ? md(h.player_name) : t(lang, 'feed.conquest.ghost'),
    alliance: aName(lang, h.alliance_name, h.alliance_id), x: h.island_x, y: h.island_y, ocean: oceanOf(h.island_x, h.island_y), id: h.id,
  }));
  return { title: t(lang, 'town.search.title', { q: query, world }), description: desc(lines, lang), color: GD_COLORS.town, footer: footer(lang, world) };
}

export function townInfoEmbed(lang: Lang, world: string, x: GdTownInfo): APIEmbed {
  return {
    title: x.name, color: GD_COLORS.town,
    fields: [
      { name: t(lang, 'common.points'), value: fmt(x.points, lang), inline: true },
      { name: t(lang, 'gd.player'), value: x.player_id ? `[${md(x.player_name)}](${playerUrl(world, x.player_id)})` : t(lang, 'feed.conquest.ghost'), inline: true },
      { name: t(lang, 'common.alliance'), value: x.alliance_id ? `[${md(x.alliance_name)}](${allianceUrl(world, x.alliance_id)})` : `_${t(lang, 'common.none')}_`, inline: true },
      { name: t(lang, 'gd.coords'), value: `(${x.ix}|${x.iy}) · ${t(lang, 'common.ocean')} ${x.ocean ?? oceanOf(x.ix, x.iy)}`, inline: true },
      { name: 'ID', value: String(x.grep_id), inline: true },
    ],
    footer: footer(lang, world),
  };
}

export interface RadarRow { town: GdRadarTown; dist: number }
/** Sort GrepoData radar towns by island-grid distance from (cx, cy) and cut at `radius`. */
export function radarRows(towns: GdRadarTown[], cx: number, cy: number, radius: number, opts: { excludeId?: number; ghostsOnly?: boolean } = {}): RadarRow[] {
  return towns
    .filter((x) => x.id !== opts.excludeId && (!opts.ghostsOnly || x.tp === 'ghost_town' || !x.player_id))
    .map((town) => ({ town, dist: Math.hypot(town.x - cx, town.y - cy) }))
    .filter((r) => r.dist <= radius)
    .sort((a, b) => a.dist - b.dist || b.town.points - a.town.points);
}
export function townRadarEmbed(lang: Lang, world: string, center: { name: string; x: number; y: number }, radius: number, rows: RadarRow[], limit = 25): APIEmbed {
  const lines = rows.slice(0, limit).map((r) => t(lang, 'town.radar.line', {
    town: md(r.town.name), points: fmt(r.town.points, lang), dist: r.dist.toFixed(1),
    player: r.town.player_id ? md(r.town.player_name) : t(lang, 'feed.conquest.ghost'), alliance: aName(lang, r.town.alliance_name, r.town.alliance_id), x: r.town.x, y: r.town.y,
  }));
  return {
    title: t(lang, 'town.radar.title', { town: center.name, x: center.x, y: center.y, radius, world }),
    description: desc(lines, lang), color: GD_COLORS.town, footer: { text: `${world} · ${t(lang, 'gd.total', { count: rows.length })} · ${t(lang, 'gd.source')}` },
  };
}

// ---------------------------------------------------------------- intel
const unitStr = (u: GdIntelUnit[] | undefined, max = 12) =>
  (u ?? []).filter((x) => x && x.count !== '' && x.count !== '0').slice(0, max).map((x) => `${x.name.replace(/_/g, ' ')} ${x.count}${x.killed && x.killed !== '0' && x.killed !== 0 ? ` (−${x.killed})` : ''}`).join(', ');

export function townIntelEmbed(lang: Lang, world: string, townId: number, d: GdTownIntel, limit = 6): APIEmbed {
  const tz = worldTz(world);
  const recs = (d.intel ?? []).filter((r) => !r.deleted).slice(0, limit);
  const fields = recs.map((r) => {
    const extra = [r.wall ? `${t(lang, 'intel.wall')} ${r.wall}` : '', r.silver && r.silver !== '0' ? `${t(lang, 'intel.silver')} ${r.silver}` : '', r.god ? `${t(lang, 'intel.god')} ${r.god}` : '', r.hero ? `${t(lang, 'intel.hero')} ${r.hero}` : '']
      .filter(Boolean).join(' · ');
    return {
      name: `${discordTs(localToEpoch(r.date, tz), 'd')} · ${r.type ?? ''}`.slice(0, 256),
      value: [unitStr(r.units) || t(lang, 'intel.noUnits'), extra].filter(Boolean).join('\n').slice(0, 1024),
    };
  });
  const notes = (d.notes ?? []).slice(0, 3).map((n) => `📝 ${md(String(n.message ?? '')).slice(0, 200)}${n.poster_name ? ` — ${md(n.poster_name)}` : ''}`);
  return {
    title: t(lang, 'intel.town.title', { town: d.name || `#${townId}` }),
    url: `https://grepodata.com/intel/town/${world}/${townId}`,
    description: [
      `${t(lang, 'gd.player')}: ${d.player_id ? `[${md(d.player_name)}](${playerUrl(world, d.player_id)})` : t(lang, 'feed.conquest.ghost')} · (${d.ix}|${d.iy})`,
      recs.length ? t(lang, 'intel.count', { shown: recs.length, total: (d.intel ?? []).length }) : t(lang, 'intel.none', { name: d.name || `#${townId}` }),
      ...notes,
    ].join('\n').slice(0, MAX_DESC),
    fields, color: GD_COLORS.intel, footer: { text: `${world} · ${t(lang, 'intel.footer')}` },
  };
}

type BrowseTown = { town_id: number; town_name?: string; name?: string; date?: string; units?: GdIntelUnit[]; priority?: boolean; count?: number; deleted?: boolean };
const playersOf = (x: unknown): { id: number; name: string; towns: BrowseTown[] }[] => {
  const p = (x as { players?: unknown })?.players;
  if (!p || typeof p !== 'object') return [];
  return Object.values(p as Record<string, { id: number; name: string; towns: BrowseTown[] | Record<string, BrowseTown> }>)
    .map((v) => ({ id: v.id, name: v.name, towns: Array.isArray(v.towns) ? v.towns : Object.values(v.towns ?? {}) }));
};

/** Player/alliance intel overview: how many towns are indexed, plus the best offensive/defensive/myth/fire/bir/trir intel per town. */
export function browseIntelEmbed(lang: Lang, world: string, scope: 'player' | 'alliance', subject: { id: number; name: string }, d: GdBrowseIntel, perCat = 5): APIEmbed {
  const tz = worldTz(world);
  const all = playersOf(d.cities);
  const townCount = all.reduce((s, p) => s + p.towns.length, 0);
  const reportCount = all.reduce((s, p) => s + p.towns.reduce((ss, x) => ss + (x.count ?? 0), 0), 0);
  const cats = ['off', 'def', 'myth', 'fire', 'bir', 'trir'] as const;
  const fields = cats.map((c) => {
    const rows = playersOf((d as unknown as Record<string, unknown>)[c]).flatMap((p) => p.towns.filter((x) => x.priority !== false && !x.deleted).map((x) => ({ p, x })));
    const lines = rows.slice(0, perCat).map(({ p, x }) => `${scope === 'alliance' ? `${md(p.name)} · ` : ''}**${md(x.town_name ?? x.name ?? `#${x.town_id}`)}** ${discordTs(localToEpoch(x.date, tz), 'd')}: ${unitStr(x.units, 6)}`);
    return { name: `${t(lang, `intel.cat.${c}`)} (${rows.length})`, value: (lines.join('\n') || '-').slice(0, 1024) };
  }).filter((f) => !f.name.endsWith('(0)'));
  return {
    title: t(lang, scope === 'player' ? 'intel.player.title' : 'intel.alliance.title', { name: subject.name }),
    url: `https://grepodata.com/intel/${scope}/${world}/${subject.id}`,
    description: [t(lang, 'intel.summary', { towns: townCount, reports: reportCount, players: all.length }), d.view_is_limited ? t(lang, 'intel.limited') : ''].filter(Boolean).join('\n'),
    fields, color: GD_COLORS.intel, footer: { text: `${world} · ${t(lang, 'intel.footer')}` },
  };
}
