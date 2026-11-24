/**
 * /live: a dense, GrepoData-style command overview (own design and code, MIT). Performance:
 * - the list is virtualized (only the rows in view, plus a small overscan, are in the DOM);
 * - filtering/grouping runs only when data or filters change; scrolling re-renders at most once per animation frame;
 * - countdowns, the clock and "updated Xs ago" are refreshed by ONE 1-second timer (tick()), touching only visible rows.
 */
import type { LiveCommand, LiveView } from '../../src/web/types.js';
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { cmdKind, injectSprite, playerIcon, typeIcon, unitDef, unitIcon, UNIT_ORDER, type CmdKind } from './icons.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; units: Record<string, string>; user: string | null }
type Group = 'none' | 'target' | 'attacker' | 'ours';
type Row = { h: true; key: string; label: string; n: number; first: number } | { h: false; c: LiveCommand; k: CmdKind };

const ROW = 48;
const OVERSCAN = 6;

export function fmtCountdown(sec: number): string {
  const d = Math.max(0, Math.round(sec));
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Pure filter + grouping (unit-tested). */
export interface Filters { text: string; player: string; uploader: string; target: number | null; units: Set<string>; returns: boolean; support: boolean; outgoing: boolean; other: boolean }
export function filterCommands(all: LiveCommand[], f: Filters): LiveCommand[] {
  const q = f.text.trim().toLowerCase();
  return all.filter((c) => {
    const k = cmdKind(c.type, c.sub, c.ret);
    if (!f.returns && k === 'return') return false;
    if (!f.support && k === 'support') return false;
    if (!f.outgoing && c.side === 'out') return false;
    if (!f.other && c.side === 'other') return false;
    if (f.target !== null && c.trg.townId !== f.target) return false;
    if (f.player && c.src.player !== f.player && c.trg.player !== f.player) return false;
    if (f.uploader && c.by !== f.uploader) return false;
    if (f.units.size && !c.units.some(([u]) => f.units.has(u))) return false;
    if (q && ![c.src.town, c.src.player, c.src.alliance, c.trg.town, c.trg.player, c.trg.alliance, c.by].some((x) => x.toLowerCase().includes(q))) return false;
    return true;
  });
}
export function groupRows(cmds: LiveCommand[], g: Group): Row[] {
  const rows = (cs: LiveCommand[]) => cs.map((c): Row => ({ h: false, c, k: cmdKind(c.type, c.sub, c.ret) }));
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
    if (cmdKind(c.type, c.sub, c.ret) === 'return') continue;
    const k = String(c.trg.townId ?? c.trg.town);
    let e = m.get(k);
    if (!e) m.set(k, (e = { id: c.trg.townId, key: k, town: c.trg.town, player: c.trg.player, alliance: c.trg.alliance, n: 0, avg: 0, first: c.arrival, sum: 0 }));
    e.n++; e.sum += c.arrival; e.first = Math.min(e.first, c.arrival);
  }
  return [...m.values()].map((e) => ({ ...e, avg: Math.round(e.sum / e.n) })).sort((a, b) => b.n - a.n || a.first - b.first);
}

export class LiveScreen {
  private data: LiveView | null = null;
  private f: Filters = { text: '', player: '', uploader: '', target: null, units: new Set(), returns: true, support: true, outgoing: true, other: true };
  private group: Group = 'none';
  private incomingOnly = true;
  private targetQ = '';
  private rows: Row[] = [];
  private filtered: LiveCommand[] = [];
  private selected: string | null = null;
  private sideOpen = false;
  private settingsOpen = false;
  private raf = 0;
  private lastRange = '';
  private el: Record<string, HTMLElement> = {};
  private sideKey = '';
  private optsKey = '';
  private stripKey = '';

  constructor(private root: HTMLElement, private o: Opts) {
    injectSprite();
    const { L, esc } = o;
    root.innerHTML = `<div class="gd">
      <div class="gd-top"><span class="gd-brand">GREPO<b>CORD</b> <span>${esc(L('teamOps'))}</span></span><span class="gd-teams"></span><span class="gd-world"></span>
        <span class="gd-status"><i class="dot"></i><span></span></span></div>
      <div class="gd-banner" hidden></div>
      <div class="gd-filters">
        <input type="search" class="f-text" placeholder="${esc(L('filterText'))}">
        <span class="chip f-target" hidden></span>
        <select class="f-player"></select><select class="f-uploader"></select>
        <button class="gbtn f-clear">${esc(L('clearFilters'))}</button>
        <span class="gd-settings"><button class="gbtn f-settings">⚙ ${esc(L('viewSettings'))}</button><div class="gd-menu" hidden>
          ${(['returns', 'support', 'outgoing', 'other'] as const).map((k) => `<label><input type="checkbox" data-opt="${k}" checked> ${esc(L(k === 'returns' ? 'showReturns' : k === 'support' ? 'showSupport' : k === 'outgoing' ? 'showOutgoing' : 'showOther'))}</label>`).join('')}
        </div></span>
        <button class="gbtn f-side">${esc(L('targetsBtn', { n: 0 }))}</button>
      </div>
      <div class="gd-body">
        <section class="gd-panel">
          <div class="gd-title"><span class="clock"></span><span class="ttl"></span><span class="liveflag">${esc(L('live'))}</span></div>
          <div class="gd-tabs">${(['none', 'target', 'attacker', 'ours'] as const).map((g) => `<button data-g="${g}" class="${g === 'none' ? 'on' : ''}">${esc(L(g === 'none' ? 'groupNone' : g === 'target' ? 'groupTarget' : g === 'attacker' ? 'groupAttacker' : 'groupOurs'))}</button>`).join('')}</div>
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
    for (const k of ['banner', 'status', 'teams', 'world', 'list', 'spacer', 'rows', 'empty', 'strip', 'cards', 'clock', 'ttl', 'liveflag', 'side', 'target', 'player', 'uploader', 'sideBtn', 'badge', 'menu'] as const) {
      this.el[k] = q({ banner: '.gd-banner', status: '.gd-status', teams: '.gd-teams', world: '.gd-world', list: '.gd-list', spacer: '.gd-spacer', rows: '.gd-rows', empty: '.gd-empty', strip: '.gd-strip',
        cards: '.gd-cards', clock: '.clock', ttl: '.ttl', liveflag: '.liveflag', side: '.gd-side', target: '.f-target', player: '.f-player', uploader: '.f-uploader', sideBtn: '.f-side', badge: '.badge', menu: '.gd-menu' }[k]);
    }
    this.bind();
  }

  setData(d: LiveView) {
    this.data = d;
    this.recompute();
    this.tick();
  }
  destroy() { cancelAnimationFrame(this.raf); }

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
    // dropdowns (only rebuilt when their option list changes)
    const players = [...new Set(d.commands.flatMap((c) => [c.src.player, c.trg.player]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const ups = [...new Set(d.commands.map((c) => c.by).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const ok = `${players.join('\u0001')}|${ups.join('\u0001')}|${this.f.player}|${this.f.uploader}`;
    if (ok !== this.optsKey) {
      this.optsKey = ok;
      (this.el.player as HTMLSelectElement).innerHTML = `<option value="">${esc(L('selectPlayers'))}</option>${players.map((p) => `<option${p === this.f.player ? ' selected' : ''}>${esc(p)}</option>`).join('')}`;
      (this.el.uploader as HTMLSelectElement).innerHTML = `<option value="">${esc(L('uploadedBy'))}</option>${ups.map((p) => `<option${p === this.f.uploader ? ' selected' : ''}>${esc(p)}</option>`).join('')}`;
    }
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
    const tot = new Map<string, number>();
    for (const c of this.data!.commands) for (const [u, n] of c.units) tot.set(u, (tot.get(u) ?? 0) + n);
    const key = `${[...tot.keys()].sort().join(',')}|${[...this.f.units].join(',')}`;
    if (key === this.stripKey) return;
    this.stripKey = key;
    const order = (a: string, b: string) => (UNIT_ORDER.indexOf(a) + 1 || 999) - (UNIT_ORDER.indexOf(b) + 1 || 999);
    const btn = (u: string) => `<button class="${this.f.units.has(u) ? 'on' : ''}" data-u="${this.o.esc(u)}">${unitIcon(u, this.o.units[u] ?? u, 22)}</button>`;
    const ids = [...tot.keys()].sort(order);
    const left = ids.filter((u) => ['land', 'hero'].includes(unitDef(u).cat)), right = ids.filter((u) => !['land', 'hero'].includes(unitDef(u).cat));
    this.el.strip.querySelector('.l')!.innerHTML = left.map(btn).join('');
    this.el.strip.querySelector('.r')!.innerHTML = right.map(btn).join('');
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
    const end = (e: LiveCommand['src']) => `<b class="town">${esc(e.town || '?')}</b> (<span class="ply">${playerIcon}${esc(e.player || '?')}</span>)`;
    const out: string[] = [];
    for (let i = a; i < b; i++) {
      const r = this.rows[i];
      if (r.h) { out.push(`<div class="gr-h" style="top:${i * ROW}px"><b>${esc(r.label)}</b><span>${esc(L('commandsCount', { n: r.n }))} · ${esc(L('firstIn', { t: '' }))}<b data-arr="${r.first}">${fmtCountdown(r.first - nowS)}</b></span></div>`); continue; }
      const c = r.c;
      const soon = c.arrival - nowS < 600;
      const key = `${i}|${c.id === this.selected ? 1 : 0}|${soon ? 1 : 0}`;
      const hit = this.rowCache.get(c);
      if (hit && hit.key === key) { out.push(hit.html); continue; }
      const arr = new Date(c.arrival * 1000);
      const at = `${fT.format(arr)} ${fD.format(arr)}`;
      const atk = r.k === 'attack' || r.k === 'conquest' || r.k === 'revolt';
      const cls = `gr ${i % 2 ? 'odd' : ''} ${atk && c.side === 'in' ? 'atk' : ''} ${atk && c.side === 'in' && soon ? 'soon' : ''} ${c.id === this.selected ? 'sel' : ''} s-${c.side}`;
      const kindTitle = L(r.k === 'attack' ? 'typeAttack' : r.k === 'support' ? 'typeSupport' : r.k === 'revolt' ? 'typeRevolt' : r.k === 'conquest' ? 'typeConquest' : r.k === 'return' ? 'typeReturn' : r.k === 'spy' ? 'typeSpy' : 'typeOther');
      const html = (`<div class="${cls}" style="top:${i * ROW}px" data-id="${esc(c.id)}">${typeIcon(r.k, kindTitle)}
        <div class="gr-m"><div class="l1">${end(c.src)} <span class="arrow">-&gt;</span> ${end(c.trg)}</div>
        <div class="l2"><b class="cd" data-arr="${c.arrival}">${fmtCountdown(c.arrival - nowS)}</b> <span>${esc(L('arrivalAt', { t: at }))}</span>${c.by ? ` <span class="by">· ${esc(L('by', { n: c.by }))}</span>` : ''}${c.planned ? ` <span class="tag">${esc(L('planned'))}</span>` : ''}</div></div>
        <div class="gr-u">${c.units.slice(0, 8).map(([u, n]) => `<span>${unitIcon(u, this.o.units[u] ?? u, 18)}<i>${n}</i></span>`).join('')}</div></div>`);
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
    const refilter = () => { this.el.list.scrollTop = 0; this.recompute(); };
    let tq = 0;
    r.querySelector<HTMLInputElement>('.f-text')!.addEventListener('input', (e) => { clearTimeout(tq); tq = window.setTimeout(() => { this.f.text = (e.target as HTMLInputElement).value; refilter(); }, 150); });
    this.el.player.addEventListener('change', (e) => { this.f.player = (e.target as HTMLSelectElement).value; refilter(); });
    this.el.uploader.addEventListener('change', (e) => { this.f.uploader = (e.target as HTMLSelectElement).value; refilter(); });
    r.querySelector('.f-clear')!.addEventListener('click', () => {
      this.f = { ...this.f, text: '', player: '', uploader: '', target: null, units: new Set() };
      r.querySelector<HTMLInputElement>('.f-text')!.value = '';
      refilter();
    });
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
    this.el.strip.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-u]'); if (!b) return; const u = b.dataset.u!; if (this.f.units.has(u)) this.f.units.delete(u); else this.f.units.add(u); refilter(); });
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
