/**
 * /live: a dense, GrepoData-style command overview (own design and code, MIT). Performance:
 * - the list is virtualized (only the rows in view, plus a small overscan, are in the DOM);
 * - filtering/grouping runs only when data or filters change; scrolling re-renders at most once per animation frame;
 * - countdowns, the clock and "updated Xs ago" are refreshed by ONE 1-second timer (tick()), touching only visible rows.
 */
import type { LiveCommand, LiveView } from '../../src/web/types.js';
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { injectSprite, loadOfficialIcons, playerIcon, typeIcon, unitDef, unitIcon, UNIT_ORDER, type CmdKind } from './icons.js';
import { describeCommand, HOSTILE, type CmdInfo } from '../../src/web/cmdKind.js';
import { activeView, closeView, createView, DEFAULT_ID, emptyFilters, loadViews, renameView, saveViews, selectView, storageKey, updateActive, type Group, type Sel, type ViewFilters, type ViewState } from './views.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; units: Record<string, string>; user: string | null; world?: string | null; storage?: Pick<Storage, 'getItem' | 'setItem'> | null }
type Row = { h: true; key: string; label: string; n: number; first: number } | { h: false; c: LiveCommand; k: CmdKind; d: CmdInfo };
/** Kind/icon/label of a command, computed once per received command object. */
const infos = new WeakMap<LiveCommand, CmdInfo>();
export function infoOf(c: LiveCommand, nowSec = Date.now() / 1000): CmdInfo {
  let d = infos.get(c);
  if (!d) infos.set(c, (d = describeCommand(c, nowSec)));
  return d;
}
/**
 * GrepoData's "Total units" bar: units summed over the commands currently shown (after every view filter), leaving out
 * hidden (soft-deleted) commands; commands whose units are not shared are counted separately.
 */
export function totalUnits(cmds: LiveCommand[]): { units: Map<string, number>; unknown: number } {
  const units = new Map<string, number>();
  let unknown = 0;
  for (const c of cmds) {
    if (c.deleted) continue;
    if (!c.units.length) { if (c.silver === null) unknown++; continue; }
    for (const [u, n] of c.units) units.set(u, (units.get(u) ?? 0) + n);
  }
  return { units, unknown };
}

const ROW = 48;
const OVERSCAN = 6;

export function fmtCountdown(sec: number): string {
  const d = Math.max(0, Math.round(sec));
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Pure filter + grouping (unit-tested). */
export type Filters = ViewFilters;
type MsKey = 'towns' | 'players' | 'alliances' | 'uploaders';
const MS_KEYS: MsKey[] = ['towns', 'players', 'alliances', 'uploaders'];
/** Values of a command a multi-select looks at (either end counts for towns/players/alliances). */
export function valuesOf(c: LiveCommand, k: MsKey): string[] {
  if (k === 'towns') return [c.src.town, c.trg.town];
  if (k === 'players') return [c.src.player, c.trg.player];
  if (k === 'alliances') return [c.src.alliance, c.trg.alliance];
  return [c.by];
}
const passSel = (s: Sel, set: Set<string>, vals: string[]) => !set.size || (s.include ? vals.some((v) => set.has(v)) : !vals.some((v) => set.has(v)));
export function filterCommands(all: LiveCommand[], f: Filters): LiveCommand[] {
  const q = f.text.trim().toLowerCase();
  const sets = MS_KEYS.map((k) => [k, new Set(f[k].values)] as const);
  const units = new Set(f.units);
  return all.filter((c) => {
    const k = infoOf(c).kind;
    if (!f.returns && k === 'return') return false;
    if (!f.support && k === 'support') return false;
    if (!f.outgoing && c.side === 'out') return false;
    if (!f.other && c.side === 'other') return false;
    if (f.target !== null && c.trg.townId !== f.target) return false;
    for (const [mk, set] of sets) if (!passSel(f[mk], set, valuesOf(c, mk))) return false;
    if (units.size && !c.units.some(([u]) => units.has(u))) return false;
    if (q && ![c.src.town, c.src.player, c.src.alliance, c.trg.town, c.trg.player, c.trg.alliance, c.by].some((x) => x.toLowerCase().includes(q))) return false;
    return true;
  });
}
export function groupRows(cmds: LiveCommand[], g: Group): Row[] {
  const rows = (cs: LiveCommand[]) => cs.map((c): Row => { const d = infoOf(c); return { h: false, c, k: d.kind, d }; });
  if (g === 'none') return rows(cmds);
  const key = (c: LiveCommand): [string, string] => {
    if (g === 'target') return [`t${c.trg.townId ?? c.trg.town}`, `${c.trg.town} (${c.trg.player})`];
    if (g === 'attacker') return [`p${c.src.playerId ?? c.src.player}`, `${c.src.player}${c.src.alliance ? ` [${c.src.alliance}]` : ''}`];
    const ours = c.side === 'out' ? c.src : c.trg;
    return [`o${ours.playerId ?? ours.player}`, ours.player || '?'];
  };
  const m = new Map<string, { label: string; cs: LiveCommand[] }>();
  for (const c of cmds) { const [k, label] = key(c); let e = m.get(k); if (!e) m.set(k, (e = { label, cs: [] })); e.cs.push(c); }
  const out: Row[] = [];
  for (const [k, e] of [...m].sort((a, b) => a[1].cs[0].arrival - b[1].cs[0].arrival)) {
    out.push({ h: true, key: k, label: e.label, n: e.cs.length, first: e.cs[0].arrival });
    out.push(...rows(e.cs));
  }
  return out;
}
export interface TargetCard { id: number | null; key: string; town: string; player: string; alliance: string; n: number; avg: number; first: number }
export function targetCards(cmds: LiveCommand[], incomingOnly: boolean): TargetCard[] {
  const m = new Map<string, TargetCard & { sum: number }>();
  for (const c of cmds) {
    if (incomingOnly && c.side !== 'in') continue;
    if (infoOf(c).kind === 'return') continue;
    const k = String(c.trg.townId ?? c.trg.town);
    let e = m.get(k);
    if (!e) m.set(k, (e = { id: c.trg.townId, key: k, town: c.trg.town, player: c.trg.player, alliance: c.trg.alliance, n: 0, avg: 0, first: c.arrival, sum: 0 }));
    e.n++; e.sum += c.arrival; e.first = Math.min(e.first, c.arrival);
  }
  return [...m.values()].map((e) => ({ ...e, avg: Math.round(e.sum / e.n) })).sort((a, b) => b.n - a.n || a.first - b.first);
}


const KIND_LABEL: Record<CmdKind, WebKey> = { attack: 'typeAttack', support: 'typeSupport', revolt: 'typeRevolt', conquest: 'typeConquest', siege: 'typeSiege', colonize: 'typeColonize', spy: 'typeSpy', farm: 'typeFarm', return: 'typeReturn', other: 'typeOther' };
const BADGE_LABEL: Record<CmdInfo['badges'][number], WebKey> = { siege: 'badgeSiege', revoltArising: 'badgeRevoltArising', revoltRunning: 'badgeRevoltRunning', returning: 'badgeReturning', planned: 'planned', quest: 'badgeQuest', temple: 'badgeTemple', portal: 'badgePortal', spot: 'badgeSpot' };
const MS_LABEL: Record<MsKey, WebKey> = { towns: 'selectTowns', players: 'selectPlayers', alliances: 'selectAlliances', uploaders: 'uploadedBy' };

export class LiveScreen {
  private data: LiveView | null = null;
  private vs: ViewState;
  private vkey: string;
  private f: Filters = emptyFilters();
  private group: Group = 'none';
  private incomingOnly = true;
  private targetQ = '';
  private rows: Row[] = [];
  private filtered: LiveCommand[] = [];
  private selected: string | null = null;
  private sideOpen = false;
  private settingsOpen = false;
  private openMs: MsKey | null = null;
  private msQ = '';
  private renaming: string | null = null;
  private raf = 0;
  private lastRange = '';
  private el: Record<string, HTMLElement> = {};
  private sideKey = '';
  private stripKey = '';

  constructor(private root: HTMLElement, private o: Opts) {
    injectSprite();
    const { L, esc } = o;
    const store = o.storage === undefined ? (() => { try { return window.localStorage; } catch { return null; } })() : o.storage;
    this.o.storage = store;
    this.vkey = storageKey(o.user, o.world ?? null);
    this.vs = loadViews(store, this.vkey);
    const ms = (k: MsKey) => `<span class="ms" data-ms="${k}"><button class="ms-btn" type="button"><span>${esc(L(MS_LABEL[k]))}</span> ▾</button><button class="ms-inc" type="button" title="${esc(L('inclToggle'))}"></button>
        <div class="ms-pop" hidden><input type="search" class="ms-q" placeholder="${esc(L('msSearch'))}"><div class="ms-list"></div><button class="gbtn ms-clear" type="button">${esc(L('msClear'))}</button></div></span>`;
    root.innerHTML = `<div class="gd">
      <div class="gd-top"><span class="gd-brand">GREPO<b>CORD</b> <span>${esc(L('teamOps'))}</span></span><span class="gd-teams"></span><span class="gd-world"></span>
        <span class="gd-status"><i class="dot"></i><span></span></span></div>
      <div class="gd-banner" hidden></div>
      <div class="gd-views"><span class="vtabs"></span><button class="vnew" type="button">+ ${esc(L('newView'))}</button></div>
      <div class="gd-filters">
        <input type="search" class="f-text" placeholder="${esc(L('filterText'))}">
        <span class="chip f-target" hidden></span>
        ${MS_KEYS.map(ms).join('')}
        <button class="gbtn f-clear">${esc(L('clearFilters'))}</button>
        <span class="gd-settings"><button class="gbtn f-settings">⚙ ${esc(L('viewSettings'))}</button><div class="gd-menu" hidden>
          ${(['returns', 'support', 'outgoing', 'other'] as const).map((k) => `<label><input type="checkbox" data-opt="${k}" checked> ${esc(L(k === 'returns' ? 'showReturns' : k === 'support' ? 'showSupport' : k === 'outgoing' ? 'showOutgoing' : 'showOther'))}</label>`).join('')}
        </div></span>
        <button class="gbtn f-side">${esc(L('targetsBtn', { n: 0 }))}</button>
      </div>
      <div class="gd-body">
        <section class="gd-panel">
          <div class="gd-title"><span class="clock"></span><span class="ttl"></span><span class="liveflag">${esc(L('live'))}</span></div>
          <div class="gd-tabs">${(['none', 'target', 'attacker', 'ours'] as const).map((g) => `<button data-g="${g}">${esc(L(g === 'none' ? 'groupNone' : g === 'target' ? 'groupTarget' : g === 'attacker' ? 'groupAttacker' : 'groupOurs'))}</button>`).join('')}</div>
          <div class="gd-list"><div class="gd-spacer"><div class="gd-rows"></div></div><p class="gd-empty" hidden>${esc(L('noMatch'))}</p></div>
          <div class="gd-strip" title="${esc(L('unitFilter'))}"><span class="l"></span><span class="r"></span></div>
        </section>
        <aside class="gd-side">
          <div class="gd-sidehead"><b>${esc(L('opTargets'))}</b> <span class="badge">0</span></div>
          <div class="gd-sidetools"><input type="search" class="t-q" placeholder="${esc(L('filterTargets'))}"><label class="tog"><input type="checkbox" class="t-in" checked> ${esc(L('incomingOnly'))}</label></div>
          <div class="gd-cards"></div>
        </aside>
      </div></div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    for (const k of ['banner', 'status', 'teams', 'world', 'list', 'spacer', 'rows', 'empty', 'strip', 'cards', 'clock', 'ttl', 'liveflag', 'side', 'target', 'sideBtn', 'badge', 'menu', 'vtabs', 'text'] as const) {
      this.el[k] = q({ banner: '.gd-banner', status: '.gd-status', teams: '.gd-teams', world: '.gd-world', list: '.gd-list', spacer: '.gd-spacer', rows: '.gd-rows', empty: '.gd-empty', strip: '.gd-strip',
        cards: '.gd-cards', clock: '.clock', ttl: '.ttl', liveflag: '.liveflag', side: '.gd-side', target: '.f-target', sideBtn: '.f-side', badge: '.badge', menu: '.gd-menu', vtabs: '.vtabs', text: '.f-text' }[k]);
    }
    this.bind();
    this.applyView();
    // Official Grepolis icons (same-origin proxy, cached): swap them in when they load, keep the own SVGs otherwise.
    void loadOfficialIcons().then((changed) => { if (changed) this.iconsChanged(); });
  }

  setData(d: LiveView) {
    this.data = d;
    this.recompute();
    this.tick();
  }
  destroy() { cancelAnimationFrame(this.raf); }
  private iconsChanged() {
    injectSprite();
    this.rowCache = new WeakMap(); this.stripKey = ''; this.lastRange = '';
    if (this.data) { this.renderStrip(); this.renderRows(); }
  }

  // ------------------------------------------------------------ saved views
  /** Load the active view's state into the controls. */
  private applyView() {
    const v = activeView(this.vs);
    this.f = structuredClone(v.f);
    this.group = v.group;
    (this.el.text as HTMLInputElement).value = this.f.text;
    this.root.querySelectorAll<HTMLElement>('[data-g]').forEach((x) => x.classList.toggle('on', x.dataset.g === this.group));
    this.el.menu.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((x) => { x.checked = this.f[x.dataset.opt as 'returns' | 'support' | 'outgoing' | 'other']; });
    this.renderTabs();
    this.renderMsButtons();
  }
  private persist() { this.vs = updateActive(this.vs, { f: structuredClone(this.f), group: this.group }); saveViews(this.o.storage ?? null, this.vkey, this.vs); }
  private setViews(s: ViewState) { this.vs = s; saveViews(this.o.storage ?? null, this.vkey, s); this.applyView(); this.el.list.scrollTop = 0; this.recompute(); }
  private renderTabs() {
    const { L, esc } = this.o;
    this.el.vtabs.innerHTML = this.vs.views.map((v) => {
      const name = v.id === DEFAULT_ID ? L('viewDefault') : v.name;
      const on = v.id === this.vs.active ? ' on' : '';
      if (this.renaming === v.id) return `<span class="vtab${on}" data-v="${esc(v.id)}"><input class="vren" value="${esc(name)}" maxlength="24"></span>`;
      return `<span class="vtab${on}" data-v="${esc(v.id)}"${v.id === DEFAULT_ID ? '' : ` title="${esc(L('renameView'))}"`}><b>${esc(name)}</b>${v.id === DEFAULT_ID ? '' : `<button class="vx" type="button" aria-label="${esc(L('closeView'))}" title="${esc(L('closeView'))}">×</button>`}</span>`;
    }).join('');
    const inp = this.el.vtabs.querySelector<HTMLInputElement>('.vren');
    if (inp) { inp.focus(); inp.select(); }
  }

  // ------------------------------------------------------------ multi-selects
  private options(k: MsKey): string[] {
    const s = new Set<string>();
    for (const c of this.data?.commands ?? []) for (const v of valuesOf(c, k)) if (v) s.add(v);
    for (const v of this.f[k].values) s.add(v); // keep selected values visible even if no longer in the data
    return [...s].sort((a, b) => a.localeCompare(b));
  }
  private renderMsButtons() {
    const { L, esc } = this.o;
    for (const k of MS_KEYS) {
      const box = this.root.querySelector<HTMLElement>(`[data-ms="${k}"]`)!;
      const sel = this.f[k];
      box.classList.toggle('active', sel.values.length > 0);
      box.querySelector('.ms-btn span')!.textContent = sel.values.length ? L('msSelected', { label: L(MS_LABEL[k]), n: sel.values.length }) : L(MS_LABEL[k]);
      const inc = box.querySelector<HTMLElement>('.ms-inc')!;
      inc.className = `ms-inc ${sel.include ? 'inc' : 'exc'}`;
      inc.innerHTML = `${sel.include ? '✓' : '✕'} ${esc(L(sel.include ? 'included' : 'excluded'))}`;
      const pop = box.querySelector<HTMLElement>('.ms-pop')!;
      pop.hidden = this.openMs !== k;
    }
    if (this.openMs) this.renderMsList();
  }
  private renderMsList() {
    const k = this.openMs!; const { L, esc } = this.o;
    const box = this.root.querySelector<HTMLElement>(`[data-ms="${k}"]`)!;
    const sel = new Set(this.f[k].values);
    const q = this.msQ.trim().toLowerCase();
    const all = this.options(k).filter((v) => !q || v.toLowerCase().includes(q));
    all.sort((a, b) => Number(sel.has(b)) - Number(sel.has(a)));
    const shown = all.slice(0, 150);
    box.querySelector('.ms-list')!.innerHTML = shown.map((v) => `<label><input type="checkbox" data-val="${esc(v)}"${sel.has(v) ? ' checked' : ''}> ${esc(v)}</label>`).join('')
      + (all.length > shown.length ? `<p class="ms-more">${esc(L('msMore', { n: all.length - shown.length }))}</p>` : '');
  }

  // ------------------------------------------------------------ derived state (only on data/filter change)
  private recompute() {
    const d = this.data;
    if (!d) return;
    const { L, esc } = this.o;
    this.filtered = filterCommands(d.commands, this.f);
    this.rows = groupRows(this.filtered, this.group);
    this.el.spacer.style.height = `${this.rows.length * ROW}px`;
    this.el.empty.hidden = this.rows.length > 0;
    this.el.ttl.textContent = L('overview', { n: this.filtered.length });
    this.el.world.textContent = d.world ?? '';
    this.el.teams.innerHTML = d.teams.map((t) => `<span class="team">${esc(t.name)}</span>`).join('');
    if (this.openMs) this.renderMsList();
    this.el.target.hidden = this.f.target === null;
    if (this.f.target !== null) {
      const c = d.commands.find((x) => x.trg.townId === this.f.target);
      this.el.target.innerHTML = `${esc(c?.trg.town ?? `#${this.f.target}`)} <button class="x" aria-label="${esc(L('close'))}">×</button>`;
    }
    this.renderBanner();
    this.renderStrip();
    this.renderSide();
    this.lastRange = '';
    this.renderRows();
  }

  private renderBanner() {
    const d = this.data!;
    const { L, esc } = this.o;
    const p = d.status?.problem;
    const msg = !p ? '' : p === 'token' ? L('banToken') : p === 'refresh' ? L('banRefresh') : p === 'noTeams' ? L('banNoTeams') : p === 'busy' ? L('banBusy') : p === 'notSetup' ? (d.error ?? '') : L('banOther', { msg: d.error ?? '?' });
    this.el.banner.hidden = !msg;
    this.el.banner.className = `gd-banner ${p === 'busy' ? 'warn' : 'bad'}`;
    if (msg) this.el.banner.textContent = msg;
  }

  private renderStrip() {
    const { L, esc } = this.o;
    const all = new Set<string>();
    for (const c of this.data!.commands) for (const [u] of c.units) all.add(u);
    for (const u of this.f.units) all.add(u);
    const { units: tot, unknown } = totalUnits(this.filtered);
    const key = `${[...all].sort().join(',')}|${[...tot].join(',')}|${unknown}|${this.f.units.join(',')}`;
    if (key === this.stripKey) return;
    this.stripKey = key;
    const order = (a: string, b: string) => (UNIT_ORDER.indexOf(a) + 1 || 999) - (UNIT_ORDER.indexOf(b) + 1 || 999);
    const nf = new Intl.NumberFormat(this.o.lang === 'el' ? 'el-GR' : 'en-GB');
    const btn = (u: string) => { const n = tot.get(u) ?? 0; const name = this.o.units[u] ?? u; return `<button class="${this.f.units.includes(u) ? 'on' : ''}${n ? '' : ' zero'}" data-u="${esc(u)}" title="${esc(`${name}: ${nf.format(n)}`)}">${unitIcon(u, name, 26)}<i>${n ? nf.format(n) : ''}</i></button>`; };
    const ids = [...all].sort(order);
    const left = ids.filter((u) => ['land', 'hero'].includes(unitDef(u).cat)), right = ids.filter((u) => !['land', 'hero'].includes(unitDef(u).cat));
    this.el.strip.querySelector('.l')!.innerHTML = `<b class="tl">${esc(L('totalUnits'))}</b>${left.map(btn).join('')}`;
    this.el.strip.querySelector('.r')!.innerHTML = right.map(btn).join('') + (unknown ? `<span class="unkn" title="${esc(L('unitsUnknown'))}">${esc(L('plusUnknown', { n: unknown }))}</span>` : '');
  }
  private renderSide() {
    const { L, esc } = this.o;
    const all = targetCards(this.data!.commands, this.incomingOnly);
    const q = this.targetQ.trim().toLowerCase();
    const cards = (q ? all.filter((c) => `${c.town} ${c.player} ${c.alliance}`.toLowerCase().includes(q)) : all).slice(0, 150);
    this.el.badge.textContent = String(all.length);
    this.el.sideBtn.textContent = L('targetsBtn', { n: all.length });
    const key = `${cards.map((c) => `${c.key}:${c.n}:${c.avg}`).join(',')}|${this.f.target}`;
    if (key === this.sideKey) return;
    this.sideKey = key;
    this.el.cards.innerHTML = cards.map((c) => `<button class="tcard${c.id !== null && c.id === this.f.target ? ' sel' : ''}" data-t="${c.id ?? ''}">
      <span class="tn">${esc(c.town)}</span><span class="cnt">${c.n}</span>
      <span class="to">${esc(c.player)}${c.alliance ? ` • ${esc(c.alliance)}` : ''}</span>
      <span class="ti2">${esc(L('incomingCmds', { n: c.n }))}</span>
      <span class="tc"><b data-arr="${c.avg}">${fmtCountdown(c.avg - Date.now() / 1000)}</b> ${esc(L('avgArrival'))}</span></button>`).join('');
  }

  // ------------------------------------------------------------ virtual list
  private schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderRows(); }); }
  private renderRows() {
    const list = this.el.list;
    const top = list.scrollTop, h = list.clientHeight || 600;
    const a = Math.max(0, Math.floor(top / ROW) - OVERSCAN), b = Math.min(this.rows.length, Math.ceil((top + h) / ROW) + OVERSCAN);
    const range = `${a}-${b}-${this.selected}`;
    if (range === this.lastRange) return;
    this.lastRange = range;
    const { L, esc } = this.o;
    const loc = this.o.lang === 'el' ? 'el-GR' : 'en-GB';
    if (!this.fmt) this.fmt = [new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }), new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric' })];
    const [fT, fD] = this.fmt;
    const nowS = Date.now() / 1000;
    const t0 = performance.now();
    const end = (e: LiveCommand['src']) => `<b class="town">${esc(e.town || '?')}</b>${e.player ? ` (<span class="ply">${playerIcon}${esc(e.player)}</span>)` : ''}`;
    const out: string[] = [];
    for (let i = a; i < b; i++) {
      const r = this.rows[i];
      if (r.h) { out.push(`<div class="gr-h" style="top:${i * ROW}px"><b>${esc(r.label)}</b><span>${esc(L('commandsCount', { n: r.n }))} · ${esc(L('firstIn', { t: '' }))}<b data-arr="${r.first}">${fmtCountdown(r.first - nowS)}</b></span></div>`); continue; }
      const c = r.c;
      const soon = c.arrival - nowS < 600;
      const key = `${i}|${c.id === this.selected ? 1 : 0}|${soon ? 1 : 0}`;
      const hit = this.rowCache.get(c);
      if (hit && hit.key === key) { out.push(hit.html); continue; }
      const d = r.d;
      const when = (t: number) => { const x = new Date(t * 1000); return `${fT.format(x)} ${fD.format(x)}`; };
      const at = when(c.arrival);
      const hostileIn = HOSTILE.has(r.k) && c.side === 'in';
      const cls = `gr ${i % 2 ? 'odd' : ''} k-${r.k} ${hostileIn ? 'atk' : ''} ${hostileIn && soon ? 'soon' : ''} ${c.planned ? 'planned' : ''} ${c.deleted ? 'deleted' : ''} ${c.id === this.selected ? 'sel' : ''} s-${c.side}`;
      const kindTitle = L(KIND_LABEL[r.k]);
      const time = d.label === 'planned' ? L('plannedAt', { dep: c.started ? when(c.started) : '?', t: at })
        : d.label === 'revoltP2' ? `(${c.started && c.started * 1000 > Date.now() ? `${L('phase2Start', { t: when(c.started) })}, ` : ''}${L('phase2End', { t: at })})`
        : L(d.label === 'conquered' ? 'conqueredAt' : d.label === 'colonized' ? 'colonizedAt' : d.label === 'arrivalPortal' ? 'arrivalPortalAt' : 'arrivalAt', { t: at });
      const tags = d.badges.filter((b) => b !== 'planned').map((b) => `<span class="tag t-${b}">${esc(L(BADGE_LABEL[b]))}</span>`).join('')
        + (c.planned ? ` <span class="tag">${esc(L('planned'))}</span>` : '') + (c.deleted ? ` <span class="tag t-del">${esc(L('hiddenCmd'))}</span>` : '');
      const [a1, a2, arrow] = c.ret ? [c.trg, c.src, '&lt;-'] : [c.src, c.trg, '-&gt;'];
      const units = c.silver !== null ? `<span class="silver" title="${esc(L('silver'))}">🪙<i>${c.silver.toLocaleString(loc)}</i></span>`
        : c.units.length ? c.units.slice(0, 8).map(([u, n]) => `<span>${unitIcon(u, this.o.units[u] ?? u, 18)}<i>${n}</i></span>`).join('')
        : `<span class="unk" title="${esc(L('unitsUnknown'))}" aria-label="${esc(L('unitsUnknown'))}">?</span>`;
      const html = (`<div class="${cls}" style="top:${i * ROW}px" data-id="${esc(c.id)}">${typeIcon(r.k, kindTitle, 30, d.icon)}
        <div class="gr-m"><div class="l1">${end(a1)} <span class="arrow">${arrow}</span> ${end(a2)} ${tags}</div>
        <div class="l2"><b class="cd" data-arr="${d.countdownAt}">${fmtCountdown(d.countdownAt - nowS)}</b> <span>${esc(time)}</span>${c.by ? ` <span class="by">· ${esc(L('by', { n: c.by }))}</span>` : ''}</div></div>
        <div class="gr-u">${units}</div></div>`);
      this.rowCache.set(c, { key, html });
      out.push(html);
    }
    this.el.rows.innerHTML = out.join('');
    // Cached rows carry the countdown from when they were built: refresh just the visible cells.
    this.el.rows.querySelectorAll<HTMLElement>('[data-arr]').forEach((el) => { el.textContent = fmtCountdown(Number(el.dataset.arr) - nowS); });
    this.renderMs = performance.now() - t0;
  }
  /** Row HTML keyed by command object (a fresh poll brings new objects, so the WeakMap drops the old ones). */
  private rowCache = new WeakMap<LiveCommand, { key: string; html: string }>();
  private fmt: [Intl.DateTimeFormat, Intl.DateTimeFormat] | null = null;
  /** Last virtual-list render time (ms), for perf checks. */
  renderMs = 0;

  /** The single 1 s update: clock, poll status, countdowns of the rows/cards in view. */
  tick() {
    const d = this.data;
    const { L } = this.o;
    const nowMs = Date.now();
    this.el.clock.textContent = new Date(nowMs).toLocaleTimeString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { hour12: false });
    if (d?.status) {
      const st = d.status;
      const ago = st.lastOkAt ? Math.max(0, Math.round((nowMs - st.lastOkAt) / 1000)) : null;
      const next = st.nextPollAt ? Math.max(0, Math.round((st.nextPollAt - st.serverNow - (nowMs - this.recvAt)) / 1000)) : st.intervalSec;
      const txt = st.state === 'ok' ? L('statusOk', { s: ago ?? 0, i: st.intervalSec }) : st.state === 'warming' ? L('statusWarming') : st.state === 'throttled' ? L('statusThrottled', { s: next }) : L('statusError', { s: next });
      const stale = ago !== null && ago > Math.max(30, st.intervalSec * 4);
      this.el.status.className = `gd-status ${st.state === 'ok' && !stale ? 'ok' : st.state === 'warming' || st.state === 'throttled' ? 'warn' : 'bad'}`;
      this.el.status.querySelector('span')!.textContent = txt + (stale && st.state === 'ok' ? ' ⚠' : '');
      this.el.liveflag.className = `liveflag ${st.state === 'ok' && !stale ? '' : 'off'}`;
      this.el.liveflag.textContent = st.state === 'ok' && !stale ? L('live') : L('paused');
    }
    const nowS = nowMs / 1000;
    this.root.querySelectorAll<HTMLElement>('[data-arr]').forEach((el) => { el.textContent = fmtCountdown(Number(el.dataset.arr) - nowS); });
  }
  private recvAt = Date.now();
  markReceived() { this.recvAt = Date.now(); }

  // ------------------------------------------------------------ events
  private bind() {
    const r = this.root;
    const refilter = () => { this.persist(); this.el.list.scrollTop = 0; this.recompute(); };
    let tq = 0;
    this.el.text.addEventListener('input', (e) => { clearTimeout(tq); tq = window.setTimeout(() => { this.f.text = (e.target as HTMLInputElement).value; refilter(); }, 150); });
    r.querySelector('.f-clear')!.addEventListener('click', () => {
      const e = emptyFilters();
      this.f = { ...this.f, text: '', towns: e.towns, players: e.players, alliances: e.alliances, uploaders: e.uploaders, target: null, units: [] };
      (this.el.text as HTMLInputElement).value = '';
      this.openMs = null; this.renderMsButtons();
      refilter();
    });
    // view tabs
    r.querySelector('.vnew')!.addEventListener('click', () => {
      const s = createView(this.vs, this.o.L('viewN', { n: this.vs.views.length }));
      if (s === this.vs) return;
      this.renaming = s.active;
      this.setViews(s);
    });
    this.el.vtabs.addEventListener('click', (e) => {
      const t = e.target as HTMLElement; const tab = t.closest<HTMLElement>('[data-v]'); if (!tab || t.classList.contains('vren')) return;
      const id = tab.dataset.v!;
      if (t.classList.contains('vx')) { this.renaming = null; this.setViews(closeView(this.vs, id)); return; }
      if (id !== this.vs.active) { this.renaming = null; this.setViews(selectView(this.vs, id)); }
    });
    this.el.vtabs.addEventListener('dblclick', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-v]'); if (!tab || tab.dataset.v === DEFAULT_ID) return;
      this.renaming = tab.dataset.v!; this.renderTabs();
    });
    const finishRename = (inp: HTMLInputElement, save: boolean) => {
      if (!this.renaming) return;
      const id = this.renaming; this.renaming = null;
      if (save) { this.vs = renameView(this.vs, id, inp.value); saveViews(this.o.storage ?? null, this.vkey, this.vs); }
      this.renderTabs();
    };
    this.el.vtabs.addEventListener('keydown', (e) => { const inp = e.target as HTMLInputElement; if (!inp.classList.contains('vren')) return; if (e.key === 'Enter') finishRename(inp, true); else if (e.key === 'Escape') finishRename(inp, false); });
    this.el.vtabs.addEventListener('focusout', (e) => { const inp = e.target as HTMLInputElement; if (inp.classList?.contains('vren')) finishRename(inp, true); });
    // multi-selects
    r.querySelectorAll<HTMLElement>('[data-ms]').forEach((box) => {
      const k = box.dataset.ms as MsKey;
      box.querySelector('.ms-btn')!.addEventListener('click', () => { this.openMs = this.openMs === k ? null : k; this.msQ = ''; box.querySelector<HTMLInputElement>('.ms-q')!.value = ''; this.renderMsButtons(); if (this.openMs) box.querySelector<HTMLInputElement>('.ms-q')!.focus(); });
      box.querySelector('.ms-inc')!.addEventListener('click', () => { this.f[k] = { ...this.f[k], include: !this.f[k].include }; this.renderMsButtons(); refilter(); });
      box.querySelector('.ms-q')!.addEventListener('input', (e) => { this.msQ = (e.target as HTMLInputElement).value; this.renderMsList(); });
      box.querySelector('.ms-clear')!.addEventListener('click', () => { this.f[k] = { ...this.f[k], values: [] }; this.renderMsButtons(); refilter(); });
      box.querySelector('.ms-list')!.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement; const v = t.dataset.val; if (v === undefined) return;
        const vals = this.f[k].values.filter((x) => x !== v);
        if (t.checked) vals.push(v);
        this.f[k] = { ...this.f[k], values: vals };
        this.renderMsButtons(); refilter();
      });
    });
    document.addEventListener('click', (e) => { if (this.openMs && !(e.target as HTMLElement).closest?.('[data-ms]')) { this.openMs = null; this.renderMsButtons(); } });
    r.querySelector('.f-settings')!.addEventListener('click', () => { this.settingsOpen = !this.settingsOpen; this.el.menu.hidden = !this.settingsOpen; });
    this.el.menu.addEventListener('change', (e) => { const t = e.target as HTMLInputElement; const k = t.dataset.opt as 'returns' | 'support' | 'outgoing' | 'other'; if (k) { this.f[k] = t.checked; refilter(); } });
    this.el.target.addEventListener('click', (e) => { if ((e.target as HTMLElement).classList.contains('x')) { this.f.target = null; refilter(); } });
    r.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) => b.addEventListener('click', () => {
      this.group = b.dataset.g as Group;
      r.querySelectorAll('[data-g]').forEach((x) => x.classList.toggle('on', x === b));
      refilter();
    }));
    this.el.list.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.rows.addEventListener('click', (e) => { const row = (e.target as HTMLElement).closest<HTMLElement>('.gr'); if (row) { this.selected = row.dataset.id === this.selected ? null : row.dataset.id ?? null; this.lastRange = ''; this.renderRows(); } });
    this.el.strip.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-u]'); if (!b) return; const u = b.dataset.u!; this.f.units = this.f.units.includes(u) ? this.f.units.filter((x) => x !== u) : [...this.f.units, u]; refilter(); });
    this.el.cards.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]'); if (!b || !b.dataset.t) return;
      const id = Number(b.dataset.t);
      this.f.target = this.f.target === id ? null : id;
      if (window.innerWidth < 760) this.toggleSide(false);
      refilter();
    });
    r.querySelector<HTMLInputElement>('.t-q')!.addEventListener('input', (e) => { this.targetQ = (e.target as HTMLInputElement).value; this.sideKey = ''; this.renderSide(); });
    r.querySelector<HTMLInputElement>('.t-in')!.addEventListener('change', (e) => { this.incomingOnly = (e.target as HTMLInputElement).checked; this.sideKey = ''; this.renderSide(); });
    this.el.sideBtn.addEventListener('click', () => this.toggleSide());
    new ResizeObserver(() => { this.lastRange = ''; this.schedule(); }).observe(this.el.list);
  }
  private toggleSide(open = !this.sideOpen) { this.sideOpen = open; this.el.side.classList.toggle('open', open); }
}
