/**
 * /troops: alliance town lists shared from GrepoGod, shown like its Friends panel
 * (2-column town grid, troops in town / support / total / wall, plus resources and active spells).
 * Filtering and totals run only when data or filters change; the 1 s timer only refreshes ages and countdowns.
 */
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { filterSnaps, totalUnits, gridH, townH, GG_LIMITS, type GgFilters, type GgPlayerSnap, type GgRes, type GgSpell, type GgTown, type UnitMap } from '../../src/web/ggCore.js';
import { HOSTILE_SPELLS, fmtDur, fmtK, spellLabel } from '../../src/web/ggSpells.js';
import { injectSprite, loadOfficialIcons, unitIcon, UNIT_ORDER } from './icons.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; units: Record<string, string> }
export interface TroopsView { players: GgPlayerSnap[]; serverNow: number }

const PH = 56, TH = 56, OVERSCAN = 4, GAP = 8, HEAD = 52, ROW = 58, RES_H = 100, SPELL_BASE = 36, SPELL_LINE = 26;


type Row = { p: GgPlayerSnap; open: boolean; towns: { t: GgTown; open: boolean; h: number }[]; h: number };

function ageText(ms: number, L: Opts['L']): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return L('agoS', { n: s });
  if (s < 3600) return L('agoM', { n: Math.floor(s / 60) });
  return L('agoH', { n: Math.floor(s / 3600) });
}

const WALL_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 21V8h3V5h3v3h6V5h3v3h3v13z"/><path d="M3 14h18M9 14v7M15 14v7M12 8v6"/></svg>';

export function wallBadge(t: GgTown, L: Opts['L'], esc: Opts['esc'], when: (sec: number) => string): string {
  if (typeof t.w !== 'number') return `<span class="trp-wall na" title="${esc(L('wallUnknown'))}">${WALL_SVG}<span>${esc(L('wall'))}</span> ?</span>`;
  const q = typeof t.wq === 'number' && t.wq !== t.w ? t.wq : null;
  let tip = q == null ? L('wallLevel', { n: t.w }) : L(q > t.w ? 'wallUp' : 'wallDown', { n: t.w, q });
  if (q != null && t.wa) tip += ' · ' + L('wallFinish', { t: when(t.wa) });
  return `<span class="trp-wall${t.w === 0 ? ' zero' : ''}${q == null ? '' : q > t.w ? ' up' : ' dn'}" title="${esc(tip)}">${WALL_SVG}<span>${esc(L('wall'))}</span> <b>${t.w}</b>${q == null ? '' : `<i>${q > t.w ? '→' : '↓'} ${q}</i>`}</span>`;
}

export function unitsHtml(u: UnitMap | undefined, units: Record<string, string>, esc: Opts['esc'], empty = '—'): string {
  const ks = Object.keys(u ?? {});
  if (!ks.length) return `<span class="muted">${empty}</span>`;
  const order = (a: string, b: string) => (UNIT_ORDER.indexOf(a) + 1 || 999) - (UNIT_ORDER.indexOf(b) + 1 || 999);
  return ks.sort(order).map((k) => {
    const name = units[k] ?? k, n = u![k];
    return `<span class="trp-u" title="${esc(name)}">${unitIcon(k, name, 22)}<i>${esc(k.slice(0, 3).toUpperCase())}</i><b>${n.toLocaleString()}</b></span>`;
  }).join('');
}

export function resHtml(r: GgRes, L: Opts['L'], esc: Opts['esc']): string {
  const cap = r.storage, full = [r.wood, r.stone, r.iron].some((v) => v >= cap);
  const bar = (key: 'w' | 's' | 'i', label: WebKey, v: number) => {
    const pct = Math.min(100, Math.round((v / cap) * 100));
    return `<div class="trp-r"><div class="trp-rl"><span>${esc(L(label))}</span><b>${esc(fmtK(v))}</b></div><div class="trp-bar"><b class="trp-${key}${pct >= 95 ? ' full' : ''}" style="width:${pct}%"></b></div></div>`;
  };
  let meta = `${esc(L('warehouse', { n: fmtK(cap) }))}`;
  if (full) meta += ` · <span class="full">${esc(L('resFull'))}</span>`;
  if (r.pop_free != null) meta += ` · ${esc(L('freePop', { n: r.pop_free }))}`;
  return `<div class="trp-rs">${bar('w', 'resWood', r.wood)}${bar('s', 'resStone', r.stone)}${bar('i', 'resSilver', r.iron)}</div><div class="trp-wh">${meta}</div>`;
}

export function spellsHtml(sp: GgSpell[], L: Opts['L'], esc: Opts['esc'], lang: WebLang, nowSec: number, when: (sec: number) => string): string {
  if (!sp.length) return `<span class="muted">${esc(L('spellsNone'))}</span>`;
  return `<span class="trp-sp">${sp.map((s) => {
    const name = spellLabel(s.id, s.name, lang);
    const bad = HOSTILE_SPELLS.has(s.id);
    const end = s.ends_at && s.ends_at > nowSec ? s.ends_at : 0;
    const tip = [bad ? L('hostileSpell') : '', end ? L('endsAt', { t: when(end) }) : ''].filter(Boolean).join(' · ');
    const cd = end ? ` <em class="trp-cd" data-end="${end}">${esc(fmtDur(end - nowSec))}</em>` : '';
    return `<span class="trp-spc${bad ? ' bad' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(name)}${cd}</span>`;
  }).join('')}</span>`;
}

export class TroopsScreen {
  private data: TroopsView | null = null;
  private f: GgFilters = { q: '', player: null, unit: null };
  private openP = new Set<number>();
  private openT = new Set<string>();
  private rows: Row[] = [];
  private shown: GgPlayerSnap[] = [];
  private raf = 0;
  private lastRange = '';
  private stripKey = '';
  private cols = 2;
  private el: Record<string, HTMLElement> = {};
  recvAt = Date.now();
  serverNow = Date.now();
  renderMs = 0;

  constructor(private root: HTMLElement, private o: Opts) {
    injectSprite();
    const { L, esc } = o;
    root.innerHTML = `<div class="trp">
      <div class="trp-top"><b>${esc(L('troopsTitle'))}</b><span class="trp-hint">${esc(L('troopsHint'))}</span></div>
      <div class="trp-filters">
        <input type="search" class="trp-q" placeholder="${esc(L('troopsSearch'))}">
        <select class="trp-pl"><option value="">${esc(L('troopsAllPlayers'))}</option></select>
        <button type="button" class="gbtn trp-clear">${esc(L('troopsClear'))}</button>
      </div>
      <div class="trp-units" title="${esc(L('troopsUnit'))}"></div>
      <div class="trp-totals" hidden></div>
      <div class="trp-list"><div class="trp-spacer"><div class="trp-rows"></div></div><p class="trp-empty" hidden></p></div>
    </div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    this.el = { list: q('.trp-list'), spacer: q('.trp-spacer'), rows: q('.trp-rows'), empty: q('.trp-empty'), totals: q('.trp-totals'), pl: q('.trp-pl'), search: q('.trp-q'), units: q('.trp-units') };
    this.bind();
    void loadOfficialIcons().then((c) => { if (c) { this.lastRange = ''; this.stripKey = ''; this.renderTotals(); this.renderRows(); } });
  }

  setData(d: TroopsView) {
    this.data = d;
    this.serverNow = d.serverNow;
    this.recvAt = Date.now();
    if (!this.openP.size && d.players.length && d.players.length <= 6) for (const p of d.players) this.openP.add(p.playerId);
    this.recompute();
  }
  destroy() { cancelAnimationFrame(this.raf); }
  markReceived() { this.recvAt = Date.now(); }

  private colCount() { return (this.el.list.clientWidth || 800) < 700 ? 1 : 2; }

  private recompute() {
    const d = this.data;
    if (!d) return;
    this.cols = this.colCount();
    const ranked = [...d.players].sort((a, b) => Number(b.mine) - Number(a.mine) || a.playerName.localeCompare(b.playerName));
    this.shown = filterSnaps(ranked, this.f);
    this.rows = [];
    for (const p of this.shown) {
      const open = this.openP.has(p.playerId);
      const towns = open ? p.towns.map((t) => {
        const on = this.openT.has(`${p.playerId}:${t.id}`);
        return { t, open: on, h: townH(t, on) };
      }) : [];
      const h = PH + (open && towns.length ? GAP + gridH(towns.map((x) => x.h), this.cols) : 0);
      this.rows.push({ p, open, towns, h });
    }
    this.el.spacer.style.height = `${this.rows.reduce((s, r) => s + r.h + GAP, 0)}px`;
    const empty = !d.players.length ? this.o.L('troopsEmpty') : !this.rows.length ? this.o.L('noMatchTroops') : '';
    this.el.empty.hidden = !empty;
    this.el.empty.textContent = empty;
    this.renderPlayers();
    this.renderUnitStrip();
    this.renderTotals();
    this.lastRange = '';
    this.renderRows();
  }

  private renderPlayers() {
    const { L, esc } = this.o;
    const sel = this.el.pl as HTMLSelectElement;
    const cur = sel.value;
    const names = [...new Map((this.data?.players ?? []).map((p) => [p.playerId, p.playerName])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = `<option value="">${esc(L('troopsAllPlayers'))}</option>` + names.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
    sel.value = cur;
  }

  private renderUnitStrip() {
    const ids = new Set<string>();
    for (const p of this.data?.players ?? []) for (const t of p.towns) for (const u of Object.keys(t.total)) ids.add(u);
    for (const p of this.shown) for (const t of p.towns) for (const u of Object.keys(t.total)) ids.add(u);
    const order = (a: string, b: string) => (UNIT_ORDER.indexOf(a) + 1 || 999) - (UNIT_ORDER.indexOf(b) + 1 || 999);
    const list = [...ids].sort(order);
    this.el.units.innerHTML = list.map((u) => {
      const name = this.o.units[u] ?? u;
      return `<button type="button" class="${this.f.unit === u ? 'on' : ''}" data-u="${this.o.esc(u)}" title="${this.o.esc(name)}">${unitIcon(u, name, 24)}</button>`;
    }).join('');
    this.el.units.hidden = list.length === 0;
  }

  private renderTotals() {
    const { L, esc } = this.o;
    const own = totalUnits(this.shown, 'total'), inn = totalUnits(this.shown, 'it'), sup = totalUnits(this.shown, 'sup');
    const key = `${[...own].join(';')}|${[...inn].join(';')}|${[...sup].join(';')}|${this.f.unit ?? ''}`;
    if (key === this.stripKey) return;
    this.stripKey = key;
    const row = (label: string, m: Map<string, number>) => m.size ? `<div class="trp-trow"><span class="trp-tl">${esc(label)}</span><span class="trp-tu">${unitsHtml(Object.fromEntries(m), this.o.units, esc)}</span></div>` : '';
    const html = `<b>${esc(L('allianceTotals'))}</b>${row(L('totalsOwn'), own)}${row(L('totalsInTown'), inn)}${row(L('totalsSupport'), sup)}`;
    this.el.totals.innerHTML = html;
    this.el.totals.hidden = !this.shown.length;
  }

  private schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderRows(); }); }

  private renderRows() {
    const list = this.el.list, top = list.scrollTop, vh = list.clientHeight || 600;
    let acc = 0, a = 0, b = this.rows.length;
    for (let i = 0; i < this.rows.length; i++) {
      const h = this.rows[i].h + GAP, y1 = acc, y2 = acc + h;
      if (y2 >= top - OVERSCAN * TH && a === 0 && i) a = i;
      if (y1 > top + vh + OVERSCAN * TH) { b = i; break; }
      acc += h;
    }
    if (top <= OVERSCAN * TH) a = 0;
    const range = `${a}-${b}-${this.openP.size}-${this.openT.size}-${this.f.unit ?? ''}-${this.cols}`;
    if (range === this.lastRange) { this.tickAges(); return; }
    this.lastRange = range;
    const { L, esc, lang } = this.o;
    const loc = lang === 'el' ? 'el-GR' : 'en-GB';
    const when = (sec: number) => new Date(sec * 1000).toLocaleString(loc, { hour: '2-digit', minute: '2-digit', hour12: false, day: 'numeric', month: 'short' });
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const skew = now - this.recvAt;
    let y = this.rows.slice(0, a).reduce((s, r) => s + r.h + GAP, 0);
    const out: string[] = [];
    const t0 = performance.now();
    for (let i = a; i < b; i++) {
      const r = this.rows[i];
      const stale = now - (r.p.recvAt + skew) > GG_LIMITS.staleMs;
      const ini = (Array.from(r.p.playerName.replace(/^[\s#._\-'"·]+/, ''))[0] || '?').toUpperCase();
      const tiles = r.open ? `<div class="trp-grid">${r.towns.map((x) => {
        const id = `${r.p.playerId}:${x.t.id}`;
        const body = x.open ? `<table class="trp-tt">
          <tr><td>${esc(L('atHome'))}</td><td>${unitsHtml(x.t.home, this.o.units, esc)}</td></tr>
          ${x.t.it ? `<tr class="it"><td title="${esc(L('inTownTip'))}"><b>${esc(L('inTown'))}</b></td><td>${unitsHtml(x.t.it, this.o.units, esc)}</td></tr>` : ''}
          <tr><td>${esc(L('totalIncl'))}</td><td>${unitsHtml(x.t.total, this.o.units, esc)}</td></tr>
          ${Object.keys(x.t.sup).length ? `<tr><td>${esc(L('supportIn'))}</td><td>${unitsHtml(x.t.sup, this.o.units, esc)}</td></tr>` : ''}
          ${x.t.res ? `<tr><td>${esc(L('resRow'))}</td><td>${resHtml(x.t.res, L, esc)}</td></tr>` : ''}
          ${x.t.spells ? `<tr><td>${esc(L('spellsRow'))}</td><td>${spellsHtml(x.t.spells, L, esc, lang, nowSec, when)}</td></tr>` : ''}
        </table>` : '';
        return `<div class="trp-tile${x.open ? ' open' : ''}" data-tid="${esc(id)}">
          <div class="trp-th"><span class="trp-car">${x.open ? '▾' : '▸'}</span><b title="${esc(x.t.n)}">${esc(x.t.n)}</b>${wallBadge(x.t, L, esc, when)}<span class="trp-sea">${esc(L('oceanN', { n: x.t.sea }))}</span></div>${body}</div>`;
      }).join('')}</div>` : '';
      out.push(`<div class="trp-block" style="top:${y}px;height:${r.h}px">
        <div class="trp-p${stale ? ' stale' : ''}" data-p="${r.p.playerId}">
          <span class="trp-av">${esc(ini)}<i class="${stale ? '' : 'on'}"></i></span>
          <span class="trp-pn"><b>${esc(r.p.playerName)}${r.p.mine ? ` <em>${esc(L('youBadge'))}</em>` : ''}</b>
            <span><em class="${stale ? 'off' : 'on'}">${esc(L(stale ? 'stale' : 'online'))}</em> · <span class="trp-age" data-at="${r.p.recvAt}">${esc(L('updatedAgo', { t: ageText(now - (r.p.recvAt + skew), L) }))}</span></span></span>
          <span class="trp-ps">${esc(L('townsCount', { n: r.p.towns.length }))} <span class="trp-car">${r.open ? '▾' : '▸'}</span></span>
        </div>${tiles}</div>`);
      y += r.h + GAP;
    }
    this.el.rows.innerHTML = out.join('');
    this.renderMs = performance.now() - t0;
  }

  tick() { this.tickAges(); }
  private tickAges() {
    if (!this.data) return;
    const { L } = this.o;
    const now = Date.now(), skew = now - this.recvAt, nowSec = Math.floor(now / 1000);
    this.root.querySelectorAll<HTMLElement>('.trp-age[data-at]').forEach((el) => {
      el.textContent = L('updatedAgo', { t: ageText(now - (Number(el.dataset.at) + skew), L) });
    });
    this.root.querySelectorAll<HTMLElement>('.trp-cd[data-end]').forEach((el) => {
      const end = Number(el.dataset.end) || 0;
      const left = Math.max(0, end - nowSec);
      el.textContent = fmtDur(left);
      el.hidden = left <= 0;
    });
  }

  private bind() {
    const refilter = () => { this.el.list.scrollTop = 0; this.recompute(); };
    let tq = 0;
    this.el.search.addEventListener('input', (e) => { clearTimeout(tq); tq = window.setTimeout(() => { this.f.q = (e.target as HTMLInputElement).value; refilter(); }, 120); });
    this.el.pl.addEventListener('change', (e) => { const v = (e.target as HTMLSelectElement).value; this.f.player = v ? Number(v) : null; refilter(); });
    this.root.querySelector('.trp-clear')!.addEventListener('click', () => { this.f = { q: '', player: null, unit: null }; (this.el.search as HTMLInputElement).value = ''; (this.el.pl as HTMLSelectElement).value = ''; refilter(); });
    this.el.units.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-u]'); if (!b) return; const u = b.dataset.u!; this.f.unit = this.f.unit === u ? null : u; refilter(); });
    this.el.list.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.rows.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tid]');
      const p = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
      if (t) {
        const id = t.dataset.tid!;
        if (this.openT.has(id)) this.openT.delete(id); else this.openT.add(id);
        this.recompute(); return;
      }
      if (p) {
        const id = Number(p.dataset.p);
        if (this.openP.has(id)) this.openP.delete(id); else this.openP.add(id);
        this.recompute();
      }
    });
    new ResizeObserver(() => {
      const next = this.colCount();
      if (next !== this.cols) { this.cols = next; this.recompute(); }
      else { this.lastRange = ''; this.schedule(); }
    }).observe(this.el.list);
  }
}
