/** Small shared helpers for the Alerts, Ops, Mini and Admin screens (formatting only, no state). */
import type { WebKey, WebLang } from '../../src/web/strings.js';
import type { IncomingType, Prediction } from '../../src/web/syncFeeds.js';
import type { UnitMap } from '../../src/web/ggCore.js';
import { unitIcon, UNIT_ORDER } from './icons.js';

export type Lf = (k: WebKey, v?: Record<string, string | number>) => string;
export type Esc = (s: unknown) => string;
export interface ScreenOpts { L: Lf; esc: Esc; lang: WebLang; units: Record<string, string> }
export interface FeedPlayer<T> { playerId: number; playerName: string; mine: boolean; ts: number; recvAt: number; items: T[] }
export interface FeedView<T> { players: FeedPlayer<T>[]; serverNow: number; planner?: { windowMin: number; timezone: string } }

/** Synced feeds count as stale after ~12 minutes without a POST. */
export const STALE_MS = 12 * 60_000;

export function ageText(ms: number, L: Lf): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return L('agoS', { n: s });
  if (s < 3600) return L('agoM', { n: Math.floor(s / 60) });
  return L('agoH', { n: Math.floor(s / 3600) });
}

export function fmtCd(sec: number): string {
  const d = Math.max(0, Math.round(sec));
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const fmts = new Map<string, Intl.DateTimeFormat>();
/** hh:mm:ss (with day/month when not today) in the given timezone (browser zone by default). */
export function fmtAt(sec: number, lang: WebLang, tz?: string, nowSec = Date.now() / 1000): string {
  const loc = lang === 'el' ? 'el-GR' : 'en-GB';
  const far = Math.abs(sec - nowSec) > 18 * 3600;
  const k = `${loc}|${tz ?? ''}|${far}`;
  let f = fmts.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(loc, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...(far ? { day: '2-digit', month: '2-digit' } : {}) }); }
    catch { f = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
    fmts.set(k, f);
  }
  return f.format(new Date(sec * 1000));
}

export const TYPE_ICON: Record<IncomingType, string> = { attack: '⚔️', conquest: '👑', revolt: '🔥', spy: '👁️', support: '🛡️', other: '•' };
const TYPE_KEY: Record<IncomingType, WebKey> = { attack: 'typeAttack', conquest: 'typeConquest', revolt: 'typeRevolt', spy: 'typeSpy', support: 'typeSupport', other: 'typeOther' };
export const typeName = (t: IncomingType, L: Lf) => L(TYPE_KEY[t] ?? 'typeOther');
export const typeChip = (t: IncomingType, L: Lf, esc: Esc) => `<span class="sx-type t-${t}" title="${esc(typeName(t, L))}">${TYPE_ICON[t] ?? '•'} <b>${esc(typeName(t, L))}</b></span>`;

const order = (a: string, b: string) => (UNIT_ORDER.indexOf(a) + 1 || 999) - (UNIT_ORDER.indexOf(b) + 1 || 999);
/** Unit ids (types only), a unit map with counts, or a free text. */
export function unitsAny(u: string | UnitMap | string[] | undefined, units: Record<string, string>, esc: Esc, size = 20): string {
  if (u == null) return '';
  if (typeof u === 'string') return `<span class="sx-utext">${esc(u)}</span>`;
  if (Array.isArray(u)) return `<span class="sx-us">${[...u].sort(order).map((id) => `<span class="sx-u" title="${esc(units[id] ?? id)}">${unitIcon(id, units[id] ?? id, size)}</span>`).join('')}</span>`;
  return `<span class="sx-us">${Object.keys(u).sort(order).map((id) => `<span class="sx-u" title="${esc(units[id] ?? id)}">${unitIcon(id, units[id] ?? id, size)}<b>${u[id].toLocaleString()}</b></span>`).join('')}</span>`;
}

const KIND_KEY: Record<string, WebKey> = { colo: 'kindColo', naval: 'kindNaval', land: 'kindLand' };
export function predHtml(p: Prediction | undefined, units: Record<string, string>, L: Lf, esc: Esc): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.kind) parts.push(`<span class="sx-kind k-${esc(p.kind)}">${esc(KIND_KEY[p.kind] ? L(KIND_KEY[p.kind]) : p.kind)}</span>`);
  if (p.groups?.length) {
    parts.push(`<span class="sx-groups">${p.groups.map((g) => `<span class="sx-grp"><i class="sx-pct" style="--p:${Math.round(g.pct)}%">${Math.round(g.pct)}%</i>${unitsAny(g.units, units, esc, 18)}</span>`).join('')}</span>`);
  } else if (p.units) parts.push(unitsAny(p.units, units, esc, 18));
  if (typeof p.conf === 'number') parts.push(`<span class="muted small">${esc(L('alertsConf', { n: Math.round(p.conf * 100) }))}</span>`);
  if (p.note) parts.push(`<span class="sx-note">${esc(p.note)}</span>`);
  return `<div class="sx-pred">${parts.join('')}</div>`;
}

/** Update every `[data-end]` countdown inside `root` (one 1 s timer for the whole screen). */
export function tickCountdowns(root: HTMLElement, nowSec: number) {
  root.querySelectorAll<HTMLElement>('[data-end]').forEach((e) => {
    const left = Number(e.dataset.end) - nowSec;
    e.textContent = left > 0 ? fmtCd(left) : '0:00:00';
    e.classList.toggle('soon', left > 0 && left < 300);
    e.classList.toggle('past', left <= 0);
  });
}
