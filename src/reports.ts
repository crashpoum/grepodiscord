/**
 * Battle/spy report parsing with Gemini (free tier). Members paste the report text or attach a screenshot;
 * the model returns structured JSON (schema below), which we normalize defensively, link to towns from the
 * official world files and store per Discord server (= per alliance) so it can be searched by town.
 */
import type { APIEmbed } from 'discord.js';
import type { WorldSnapshot } from './data/snapshot.js';
import type { Town } from './data/parse.js';
import { UNIT_EN } from './planner.js';
import { localToEpoch } from './time.js';
import { fmt, t, type Lang } from './i18n.js';

export const REPORT_KINDS = ['attack', 'defense', 'spy', 'support', 'conquest', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface UnitLine { unit: string; name: string; count: number; lost: number }
export interface Side { player: string | null; alliance: string | null; town: string | null }
export interface ParsedReport {
  isReport: boolean; kind: ReportKind; time: string | null;
  attacker: Side; defender: Side;
  attackerUnits: UnitLine[]; defenderUnits: UnitLine[];
  buildings: { name: string; level: number }[];
  resources: { wood: number | null; stone: number | null; silver: number | null } | null;
  wallBefore: number | null; wallAfter: number | null; morale: number | null; luck: number | null; nightBonus: boolean | null;
  god: string | null; summary: string | null;
}

const S = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
const SIDE = S('OBJECT', { properties: { player: S('STRING', { nullable: true }), alliance: S('STRING', { nullable: true }), town: S('STRING', { nullable: true }) } });
const UNITS = S('ARRAY', { items: S('OBJECT', { properties: { unit: S('STRING'), name: S('STRING'), count: S('INTEGER'), lost: S('INTEGER') }, required: ['unit', 'count'] }) });
/** Gemini responseSchema (OpenAPI subset). */
export const REPORT_SCHEMA = S('OBJECT', {
  properties: {
    is_report: S('BOOLEAN'),
    kind: S('STRING', { enum: [...REPORT_KINDS] }),
    time: S('STRING', { nullable: true, description: 'Report date/time exactly as shown' }),
    attacker: SIDE, defender: SIDE,
    attacker_units: UNITS, defender_units: UNITS,
    buildings: S('ARRAY', { items: S('OBJECT', { properties: { name: S('STRING'), level: S('INTEGER') }, required: ['name', 'level'] }) }),
    resources: S('OBJECT', { nullable: true, properties: { wood: S('INTEGER', { nullable: true }), stone: S('INTEGER', { nullable: true }), silver: S('INTEGER', { nullable: true }) } }),
    wall_before: S('INTEGER', { nullable: true }), wall_after: S('INTEGER', { nullable: true }),
    morale: S('INTEGER', { nullable: true }), luck: S('INTEGER', { nullable: true }), night_bonus: S('BOOLEAN', { nullable: true }),
    god: S('STRING', { nullable: true }), summary: S('STRING', { nullable: true }),
  },
  required: ['is_report', 'kind'],
});

export function reportPrompt(lang: Lang): string {
  return [
    'You extract data from Grepolis (browser game by InnoGames) reports. The input is report text copied from the game or a screenshot of a report. It may be in Greek, English or another language.',
    'Return ONLY data that is visible. Never guess numbers: use null or omit when unknown. If the input is not a Grepolis report, set is_report=false.',
    'kind: attack (we see an attack outcome), defense (a town was attacked and defended), spy (espionage report with buildings/units/resources), support, conquest (town conquered / conquest started), other.',
    'attacker/defender: player, alliance and town names exactly as written (keep Greek letters and numbers like "04. Sparta").',
    `Units: map every unit to one of these ids: ${Object.keys(UNIT_EN).join(', ')}, militia; "name" is the name as written. count = units involved (sent or present), lost = units lost (0 if none shown).`,
    'buildings: only for spy reports (senate, wall, tower, harbor, barracks, academy, temple, etc.) with levels. resources: stored resources for spy reports, loot for attacks.',
    'luck and morale in percent (luck can be negative). wall_before/wall_after: city wall level before/after if shown.',
    `summary: one short neutral sentence about the outcome, in ${lang === 'el' ? 'Greek' : 'English'}.`,
  ].join('\n');
}

const str = (v: unknown, n = 80): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : typeof v === 'string' && /^-?\d[\d.,\s]*$/.test(v) ? Number(v.replace(/[.,\s]/g, '')) : null);
const side = (v: unknown): Side => { const o = (v ?? {}) as Record<string, unknown>; return { player: str(o.player), alliance: str(o.alliance), town: str(o.town) }; };
const units = (v: unknown): UnitLine[] => (Array.isArray(v) ? v : []).slice(0, 40).flatMap((u) => {
  const o = (u ?? {}) as Record<string, unknown>;
  const id = String(o.unit ?? '').toLowerCase().trim();
  const count = int(o.count) ?? 0;
  const lost = Math.max(0, int(o.lost) ?? 0);
  if (!id || (count <= 0 && lost <= 0)) return [];
  return [{ unit: id in UNIT_EN || id === 'militia' ? id : 'other', name: str(o.name, 40) ?? id, count: Math.max(count, lost), lost }];
});

/** Normalize the model's JSON into a ParsedReport (never trusts shapes or types). */
export function normalizeReport(raw: unknown): ParsedReport {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind = REPORT_KINDS.includes(o.kind as ReportKind) ? (o.kind as ReportKind) : 'other';
  const res = o.resources as Record<string, unknown> | null | undefined;
  const resources = res ? { wood: int(res.wood), stone: int(res.stone), silver: int(res.silver) } : null;
  return {
    isReport: o.is_report !== false, kind, time: str(o.time, 40),
    attacker: side(o.attacker), defender: side(o.defender),
    attackerUnits: units(o.attacker_units), defenderUnits: units(o.defender_units),
    buildings: (Array.isArray(o.buildings) ? o.buildings : []).slice(0, 30).flatMap((b) => {
      const x = (b ?? {}) as Record<string, unknown>; const name = str(x.name, 40); const level = int(x.level);
      return name && level !== null && level >= 0 && level <= 60 ? [{ name, level }] : [];
    }),
    resources: resources && (resources.wood ?? resources.stone ?? resources.silver) !== null ? resources : null,
    wallBefore: int(o.wall_before), wallAfter: int(o.wall_after), morale: int(o.morale), luck: int(o.luck),
    nightBonus: typeof o.night_bonus === 'boolean' ? o.night_bonus : null, god: str(o.god, 30), summary: str(o.summary, 300),
  };
}

/** Find the town by exact (case-insensitive) name, preferring the one owned by the named player. */
export function matchTown(snap: WorldSnapshot, name: string | null, player: string | null): Town | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const hits = [...snap.towns.values()].filter((x) => x.name.trim().toLowerCase() === n);
  if (hits.length <= 1) return hits[0] ?? null;
  const pl = player?.trim().toLowerCase();
  return hits.find((x) => x.playerId !== null && snap.players.get(x.playerId)?.name.toLowerCase() === pl) ?? hits[0];
}

/** Grepolis report times: "24.11.2026 21:30:12", "24/11/2026 21:30", "2026-11-24 21:30:12", "24.11.26 21:30" (world tz). */
export function reportTime(s: string | null, tz: string): number | null {
  if (!s) return null;
  const iso = localToEpoch(s, tz);
  if (iso) return iso;
  const m = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const p = (x: string | number) => String(x).padStart(2, '0');
  return localToEpoch(`${y}-${p(m[2])}-${p(m[1])} ${p(m[4])}:${m[5]}:${p(m[6] ?? 0)}`, tz);
}

export function unitLabel(u: UnitLine, lang: Lang): string {
  return lang === 'en' ? UNIT_EN[u.unit] ?? u.name : u.name || UNIT_EN[u.unit] || u.unit;
}
const KIND_ICON: Record<ReportKind, string> = { attack: '⚔️', defense: '🛡️', spy: '🕵️', support: '🤝', conquest: '🏛️', other: '📜' };

export function reportEmbed(r: { id: number; world: string; reportTime: number | null; createdBy: string; source: string }, p: ParsedReport, lang: Lang, snap?: WorldSnapshot): APIEmbed {
  const sideTxt = (s: Side) => [s.town ? `**${s.town}**` : null, s.player, s.alliance ? `[${s.alliance}]` : null].filter(Boolean).join(' · ') || '-';
  const unitTxt = (us: UnitLine[]) => us.length ? us.map((u) => `${unitLabel(u, lang)}: ${fmt(u.count, lang)}${u.lost ? ` (−${fmt(u.lost, lang)})` : ''}`).join('\n') : '-';
  const fields: APIEmbed['fields'] = [
    { name: t(lang, 'rep.attacker'), value: sideTxt(p.attacker), inline: true },
    { name: t(lang, 'rep.defender'), value: sideTxt(p.defender), inline: true },
  ];
  if (p.attackerUnits.length) fields.push({ name: t(lang, 'rep.attUnits'), value: unitTxt(p.attackerUnits), inline: false });
  if (p.defenderUnits.length) fields.push({ name: t(lang, 'rep.defUnits'), value: unitTxt(p.defenderUnits), inline: false });
  if (p.buildings.length) fields.push({ name: t(lang, 'rep.buildings'), value: p.buildings.map((b) => `${b.name} ${b.level}`).join(' · '), inline: false });
  if (p.resources) fields.push({ name: t(lang, p.kind === 'spy' ? 'rep.stored' : 'rep.loot'), value: `🪵 ${fmt(p.resources.wood ?? 0, lang)} · 🪨 ${fmt(p.resources.stone ?? 0, lang)} · 🪙 ${fmt(p.resources.silver ?? 0, lang)}`, inline: false });
  const extra = [
    p.wallBefore !== null || p.wallAfter !== null ? `${t(lang, 'rep.wall')}: ${p.wallBefore ?? '?'}${p.wallAfter !== null && p.wallAfter !== p.wallBefore ? ` → ${p.wallAfter}` : ''}` : null,
    p.luck !== null ? `${t(lang, 'rep.luck')}: ${p.luck}%` : null,
    p.morale !== null ? `${t(lang, 'rep.morale')}: ${p.morale}%` : null,
    p.nightBonus ? t(lang, 'rep.night') : null,
    p.god ? `${t(lang, 'rep.god')}: ${p.god}` : null,
  ].filter(Boolean);
  if (extra.length) fields.push({ name: t(lang, 'rep.details'), value: extra.join(' · '), inline: false });
  const when = r.reportTime ? `<t:${r.reportTime}:f>` : p.time ?? '';
  const defTown = snap ? matchTown(snap, p.defender.town, p.defender.player) : null;
  return {
    title: `${KIND_ICON[p.kind]} ${t(lang, `rep.kind.${p.kind}`)} #${r.id} · ${r.world}`.slice(0, 256),
    description: [p.summary, when ? `🕒 ${when}` : null, defTown ? `📍 (${defTown.islandX}|${defTown.islandY})` : null].filter(Boolean).join('\n') || undefined,
    color: p.kind === 'attack' ? 0xed4245 : p.kind === 'defense' ? 0x5865f2 : p.kind === 'spy' ? 0x9b59b6 : 0x95a5a6,
    fields,
    footer: { text: t(lang, 'rep.footer', { source: t(lang, r.source === 'image' ? 'rep.src.image' : 'rep.src.text') }) },
  };
}
