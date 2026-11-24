/**
 * Weekly newspaper: pure fact extraction from public data (official conquers file + our daily history),
 * a Gemini prompt that must use ONLY those facts, and a template fallback when no key / AI fails.
 */
import type { APIEmbed } from 'discord.js';
import type { DailySet } from './db.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { fmt, t, type Lang } from './i18n.js';
import { daysBetween } from './targets.js';

const DAY = 86_400;
export interface NameCount { name: string; n: number }
export interface Delta { name: string; delta: number; total: number }
export interface WeekFacts {
  world: string; from: number; to: number; historyDays: number;
  conquests: { total: number; ghosts: number; internal: number };
  topConquerorsA: NameCount[]; topLosersA: NameCount[]; topConquerorsP: NameCount[];
  wars: { a: string; b: string; aTook: number; bTook: number }[];
  risersA: Delta[]; fallersA: Delta[]; risersP: Delta[];
  abpP: Delta[]; dbpP: Delta[];
  ours: null | { names: string[]; gained: number; lost: number; pointsDelta: number | null; bestAttacker: Delta | null; bestDefender: Delta | null; topConquerorP: NameCount | null };
  rankTop: { name: string; points: number; rank: number }[];
}

const top = <T>(arr: T[], key: (x: T) => number, n = 5) => [...arr].sort((a, b) => key(b) - key(a)).slice(0, n);

export function weekFacts(snap: WorldSnapshot, o: { now: number; ours: number[]; oldP: DailySet | null; oldA: DailySet | null; today: string }): WeekFacts {
  const from = o.now - 7 * DAY;
  const an = (id: number | null) => (id === null ? '—' : snap.alliances.get(id)?.name ?? `#${id}`);
  const pn = (id: number | null) => (id === null ? '—' : snap.players.get(id)?.name ?? `#${id}`);
  const gainA = new Map<number, number>(), lossA = new Map<number, number>(), gainP = new Map<number, number>();
  const pair = new Map<string, { a: number; b: number; ab: number; ba: number }>();
  let total = 0, ghosts = 0, internal = 0, ourGained = 0, ourLost = 0;
  const ourConq = new Map<number, number>();
  const inc = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const c of snap.conquers) {
    if (c.time < from || c.time > o.now) continue;
    total++;
    if (c.oldPlayerId === null) ghosts++;
    if (c.newAllianceId !== null && c.newAllianceId === c.oldAllianceId) { internal++; continue; }
    if (c.newAllianceId !== null) inc(gainA, c.newAllianceId);
    if (c.oldAllianceId !== null) inc(lossA, c.oldAllianceId);
    if (c.newPlayerId !== null) inc(gainP, c.newPlayerId);
    if (c.newAllianceId !== null && o.ours.includes(c.newAllianceId)) { ourGained++; if (c.newPlayerId) inc(ourConq, c.newPlayerId); }
    if (c.oldAllianceId !== null && o.ours.includes(c.oldAllianceId)) ourLost++;
    if (c.newAllianceId !== null && c.oldAllianceId !== null) {
      const [a, b] = c.newAllianceId < c.oldAllianceId ? [c.newAllianceId, c.oldAllianceId] : [c.oldAllianceId, c.newAllianceId];
      const k = `${a}:${b}`;
      const x = pair.get(k) ?? { a, b, ab: 0, ba: 0 };
      if (c.newAllianceId === a) x.ab++; else x.ba++;
      pair.set(k, x);
    }
  }
  const nc = (m: Map<number, number>, name: (id: number) => string) => top([...m], ([, n]) => n).map(([id, n]) => ({ name: name(id), n }));
  const histDays = o.oldP ? daysBetween(o.oldP.day, o.today) : 0;
  const deltasA = (field: 'points') => o.oldA && daysBetween(o.oldA.day, o.today) >= 1
    ? [...snap.alliances.values()].flatMap((a) => { const old = o.oldA!.rows.get(a.id); return old ? [{ name: a.name, delta: a[field] - old[field], total: a[field] }] : []; })
    : [];
  const deltasP = (cur: (id: number) => number, oldF: 'points' | 'abp' | 'dbp') => o.oldP && histDays >= 1
    ? [...snap.players.values()].flatMap((p) => { const old = o.oldP!.rows.get(p.id); return old ? [{ name: p.name, delta: cur(p.id) - old[oldF], total: cur(p.id), id: p.id, ally: p.allianceId }] : []; })
    : [];
  const aPts = deltasA('points');
  const pPts = deltasP((id) => snap.players.get(id)!.points, 'points');
  const pAbp = deltasP((id) => snap.playerAbp.get(id) ?? 0, 'abp');
  const pDbp = deltasP((id) => snap.playerDbp.get(id) ?? 0, 'dbp');
  const strip = (d: Delta & { id?: number; ally?: number | null }): Delta => ({ name: d.name, delta: d.delta, total: d.total });
  let ours: WeekFacts['ours'] = null;
  if (o.ours.length) {
    const mine = (d: { ally?: number | null }) => d.ally != null && o.ours.includes(d.ally);
    const ptsNow = o.ours.reduce((s, id) => s + (snap.alliances.get(id)?.points ?? 0), 0);
    const ptsOld = o.oldA ? o.ours.reduce((s, id) => s + (o.oldA!.rows.get(id)?.points ?? NaN), 0) : NaN;
    const bestA = top(pAbp.filter(mine), (d) => d.delta, 1)[0];
    const bestD = top(pDbp.filter(mine), (d) => d.delta, 1)[0];
    const tc = top([...ourConq], ([, n]) => n, 1)[0];
    ours = {
      names: o.ours.map(an), gained: ourGained, lost: ourLost, pointsDelta: Number.isFinite(ptsOld) ? ptsNow - ptsOld : null,
      bestAttacker: bestA && bestA.delta > 0 ? strip(bestA) : null, bestDefender: bestD && bestD.delta > 0 ? strip(bestD) : null,
      topConquerorP: tc ? { name: pn(tc[0]), n: tc[1] } : null,
    };
  }
  return {
    world: snap.world, from, to: o.now, historyDays: histDays,
    conquests: { total, ghosts, internal },
    topConquerorsA: nc(gainA, an), topLosersA: nc(lossA, an), topConquerorsP: nc(gainP, pn),
    wars: top([...pair.values()], (x) => x.ab + x.ba).filter((x) => x.ab + x.ba >= 2).map((x) => ({ a: an(x.a), b: an(x.b), aTook: x.ab, bTook: x.ba })),
    risersA: top(aPts, (d) => d.delta).filter((d) => d.delta > 0), fallersA: top(aPts, (d) => -d.delta).filter((d) => d.delta < 0),
    risersP: top(pPts, (d) => d.delta).filter((d) => d.delta > 0).map(strip),
    abpP: top(pAbp, (d) => d.delta).filter((d) => d.delta > 0).map(strip), dbpP: top(pDbp, (d) => d.delta).filter((d) => d.delta > 0).map(strip),
    ours,
    rankTop: top([...snap.alliances.values()], (a) => a.points, 5).map((a) => ({ name: a.name, points: a.points, rank: a.rank })),
  };
}

export function newspaperPrompt(lang: Lang, f: WeekFacts): { system: string; user: string } {
  return {
    system: [
      `You are the editor of "${f.world} Chronicle", a weekly newspaper for players of the browser game Grepolis.`,
      `Write in ${lang === 'el' ? 'Greek (modern, natural, no katharevousa)' : 'English'}.`,
      'Use ONLY the facts in the JSON. Never invent names, numbers, battles or diplomacy. If a section has no data, skip it.',
      'Format for Discord markdown: a bold headline on the first line, then 3–5 short sections with an emoji and a bold title each. Use short paragraphs or bullets.',
      'Tone: lively war correspondent, fair to all sides, no insults, no real-world politics. Maximum 3200 characters.',
      f.historyDays < 7 ? `Points/BP changes cover only the last ${f.historyDays} day(s) (the bot's history is still filling); say "this week" only for conquests.` : '',
    ].filter(Boolean).join('\n'),
    user: `Facts (JSON, period ${new Date(f.from * 1000).toISOString().slice(0, 10)} – ${new Date(f.to * 1000).toISOString().slice(0, 10)}):\n${JSON.stringify(f)}`,
  };
}

/** Template-only newspaper (no AI): same facts, fixed layout. */
export function templateArticle(f: WeekFacts, lang: Lang): string {
  const n = (x: number) => fmt(x, lang);
  const sgn = (x: number) => `${x >= 0 ? '+' : '−'}${n(Math.abs(x))}`;
  const list = (rows: string[]) => (rows.length ? rows.map((r, i) => `${i + 1}. ${r}`).join('\n') : t(lang, 'news.none'));
  const out = [`**${t(lang, 'news.headline', { world: f.world, n: f.conquests.total })}**`];
  out.push(`\n**🏛️ ${t(lang, 'news.conquests')}**\n${t(lang, 'news.conqLine', { total: n(f.conquests.total), ghosts: n(f.conquests.ghosts), internal: n(f.conquests.internal) })}`);
  out.push(`\n**⚔️ ${t(lang, 'news.topConq')}**\n${list(f.topConquerorsA.map((x) => `${x.name}: ${n(x.n)}`))}`);
  if (f.topLosersA.length) out.push(`\n**🔥 ${t(lang, 'news.topLost')}**\n${list(f.topLosersA.map((x) => `${x.name}: ${n(x.n)}`))}`);
  if (f.wars.length) out.push(`\n**🗡️ ${t(lang, 'news.wars')}**\n${f.wars.map((w) => `• ${w.a} ${n(w.aTook)} – ${n(w.bTook)} ${w.b}`).join('\n')}`);
  if (f.risersA.length || f.fallersA.length) {
    out.push(`\n**📈 ${t(lang, 'news.movers', { days: f.historyDays })}**\n${[...f.risersA.slice(0, 3).map((d) => `🟢 ${d.name} ${sgn(d.delta)}`), ...f.fallersA.slice(0, 3).map((d) => `🔴 ${d.name} ${sgn(d.delta)}`)].join('\n')}`);
  }
  if (f.abpP.length) out.push(`\n**💥 ${t(lang, 'news.abp')}**\n${list(f.abpP.slice(0, 3).map((d) => `${d.name}: +${n(d.delta)}`))}`);
  if (f.dbpP.length) out.push(`\n**🛡️ ${t(lang, 'news.dbp')}**\n${list(f.dbpP.slice(0, 3).map((d) => `${d.name}: +${n(d.delta)}`))}`);
  if (f.ours) {
    const o = f.ours;
    const lines = [t(lang, 'news.oursLine', { names: o.names.join(', '), g: n(o.gained), l: n(o.lost) })];
    if (o.pointsDelta !== null) lines.push(t(lang, 'news.oursPts', { d: sgn(o.pointsDelta) }));
    if (o.topConquerorP) lines.push(t(lang, 'news.oursConq', { name: o.topConquerorP.name, n: n(o.topConquerorP.n) }));
    if (o.bestAttacker) lines.push(t(lang, 'news.oursAtt', { name: o.bestAttacker.name, n: n(o.bestAttacker.delta) }));
    if (o.bestDefender) lines.push(t(lang, 'news.oursDef', { name: o.bestDefender.name, n: n(o.bestDefender.delta) }));
    out.push(`\n**🏰 ${t(lang, 'news.ours')}**\n${lines.join('\n')}`);
  }
  if (f.historyDays < 7) out.push(`\n-# ${t(lang, 'news.partial', { days: f.historyDays })}`);
  return out.join('\n');
}

export function newspaperEmbed(f: WeekFacts, body: string, lang: Lang, byAi: boolean): APIEmbed {
  return {
    title: `📰 ${t(lang, 'news.title', { world: f.world })}`,
    description: body.slice(0, 4000),
    color: 0xc27c0e,
    footer: { text: t(lang, byAi ? 'news.footerAi' : 'news.footerTpl') },
    timestamp: new Date(f.to * 1000).toISOString(),
  };
}

/** Weekday (0 = Sunday), date and hour in a timezone. */
export function localWeekday(tz: string, ms: number): { weekday: number; day: string; hour: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(ms));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}

/** Due once on the configured weekday, at or after the hour, and not yet sent that day. */
export function newspaperDue(p: { weekday: number; hour: number; lastSentDay: string | null }, tz: string, ms: number): string | null {
  const l = localWeekday(tz, ms);
  return l.weekday === p.weekday && l.hour >= p.hour && p.lastSentDay !== l.day ? l.day : null;
}
