/**
 * /troops: alliance town lists shared from GrepoGod, shown like its Friends panel
 * (at home / in town / total incl. outside / support / wall). Official unit icons via /gpcdn.
 * Filtering and totals run only when data or filters change; the 1 s timer only refreshes ages.
 */
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { filterSnaps, totalUnits, GG_LIMITS, type GgFilters, type GgPlayerSnap, type GgTown, type UnitMap } from '../../src/web/ggCore.js';
import { injectSprite, loadOfficialIcons, unitIcon, UNIT_ORDER } from './icons.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; units: Record<string, string> }
export interface TroopsView { players: GgPlayerSnap[]; serverNow: number }

const PH = 56, TH = 48, OVERSCAN = 4;
const townH = (t: GgTown, open: boolean) => open ? 52 + 64 * (2 + (t.it ? 1 : 0) + (Object.keys(t.sup).length ? 1 : 0)) : TH;
type Row = { k: 'p'; p: GgPlayerSnap; h: number } | { k: 't'; p: GgPlayerSnap; t: GgTown; open: boolean; h: number };

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

  private recompute() {
    const d = this.data;
    if (!d) return;
    const ranked = [...d.players].sort((a, b) => Number(b.mine) - Number(a.mine) || a.playerName.localeCompare(b.playerName));
    this.shown = filterSnaps(ranked, this.f);
    this.rows = [];
    for (const p of this.shown) {
      this.rows.push({ k: 'p', p, h: PH });
      if (!this.openP.has(p.playerId)) continue;
      for (const t of p.towns) {
        const open = this.openT.has(`${p.playerId}:${t.id}`);
        this.rows.push({ k: 't', p, t, open, h: townH(t, open) });
      }
    }
    this.el.spacer.style.height = `${this.rows.reduce((s, r) => s + r.h, 0)}px`;
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
      const h = this.rows[i].h, y1 = acc, y2 = acc + h;
      if (y2 >= top - OVERSCAN * TH && a === 0 && i) a = i;
      if (y1 > top + vh + OVERSCAN * TH) { b = i; break; }
      acc += h;
    }
    if (top <= OVERSCAN * TH) a = 0;
    const range = `${a}-${b}-${this.openP.size}-${this.openT.size}-${this.f.unit ?? ''}`;
    if (range === this.lastRange) { this.tickAges(); return; }
    this.lastRange = range;
    const { L, esc } = this.o;
    const loc = this.o.lang === 'el' ? 'el-GR' : 'en-GB';
    const when = (sec: number) => new Date(sec * 1000).toLocaleString(loc, { hour: '2-digit', minute: '2-digit', hour12: false, day: 'numeric', month: 'short' });
    const now = Date.now();
    const skew = now - this.recvAt;
    let y = this.rows.slice(0, a).reduce((s, r) => s + r.h, 0);
    const out: string[] = [];
    const t0 = performance.now();
    for (let i = a; i < b; i++) {
      const r = this.rows[i];
      if (r.k === 'p') {
        const stale = now - (r.p.recvAt + skew) > GG_LIMITS.staleMs;
        const ini = (Array.from(r.p.playerName.replace(/^[\s#._\-'"·]+/, ''))[0] || '?').toUpperCase();
        out.push(`<div class="trp-p${stale ? ' stale' : ''}" style="top:${y}px" data-p="${r.p.playerId}">
          <span class="trp-av">${esc(ini)}<i class="${stale ? '' : 'on'}"></i></span>
          <span class="trp-pn"><b>${esc(r.p.playerName)}${r.p.mine ? ` <em>${esc(L('youBadge'))}</em>` : ''}</b>
            <span><em class="${stale ? 'off' : 'on'}">${esc(L(stale ? 'stale' : 'online'))}</em> · <span class="trp-age" data-at="${r.p.recvAt}">${esc(L('updatedAgo', { t: ageText(now - (r.p.recvAt + skew), L) }))}</span></span></span>
          <span class="trp-ps">${esc(L('townsCount', { n: r.p.towns.length }))} <span class="trp-car">${this.openP.has(r.p.playerId) ? '▾' : '▸'}</span></span></div>`);
      } else {
        const id = `${r.p.playerId}:${r.t.id}`;
        const body = r.open ? `<table class="trp-tt">
          <tr><td>${esc(L('atHome'))}</td><td>${unitsHtml(r.t.home, this.o.units, esc)}</td></tr>
          ${r.t.it ? `<tr class="it"><td title="${esc(L('inTownTip'))}"><b>${esc(L('inTown'))}</b></td><td>${unitsHtml(r.t.it, this.o.units, esc)}</td></tr>` : ''}
          <tr><td>${esc(L('totalIncl'))}</td><td>${unitsHtml(r.t.total, this.o.units, esc)}</td></tr>
          ${Object.keys(r.t.sup).length ? `<tr><td>${esc(L('supportIn'))}</td><td>${unitsHtml(r.t.sup, this.o.units, esc)}</td></tr>` : ''}
        </table>` : '';
        out.push(`<div class="trp-t${r.open ? ' open' : ''}" style="top:${y}px;height:${r.h}px" data-tid="${esc(id)}">
          <div class="trp-th"><span class="trp-car">${r.open ? '▾' : '▸'}</span><b title="${esc(r.t.n)}">${esc(r.t.n)}</b>${wallBadge(r.t, L, esc, when)}<span class="trp-sea">${esc(L('oceanN', { n: r.t.sea }))}</span></div>${body}</div>`);
      }
      y += r.h;
    }
    this.el.rows.innerHTML = out.join('');
    this.renderMs = performance.now() - t0;
  }

  tick() { this.tickAges(); }
  private tickAges() {
    if (!this.data) return;
    const { L } = this.o;
    const now = Date.now(), skew = now - this.recvAt;
    this.root.querySelectorAll<HTMLElement>('.trp-age[data-at]').forEach((el) => {
      el.textContent = L('updatedAgo', { t: ageText(now - (Number(el.dataset.at) + skew), L) });
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
      const p = (e.target as HTMLElement).closest<HTMLElement>('[data-p]');
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tid]');
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
    new ResizeObserver(() => { this.lastRange = ''; this.schedule(); }).observe(this.el.list);
  }
}
