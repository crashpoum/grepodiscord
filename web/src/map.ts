/** Canvas world map: towns by owner colour (our side vs enemies, or per alliance), pan/zoom, conquest timeline replay. */
import type { LiveCommand, MapPayload } from '../../src/web/types.js';
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { ownerAtTime, townXY, allianceColor, type Hist } from './geo.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; me: number | null; onWantCommands: (on: boolean) => void }
type Mode = 'sides' | 'alliances';

const COL = { ours: '#4f8cff', enemy: '#ed4245', ghost: '#5c5f66', none: '#8a8f98', neutral: '#b5bac1', me: '#fee75c' };
const DAY = 86400;

export class MapView {
  private canvas: HTMLCanvasElement;
  private ctx2: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private side: HTMLDivElement;
  private slider: HTMLInputElement;
  private whenEl: HTMLSpanElement;
  private playBtn: HTMLButtonElement;
  private ro: ResizeObserver;
  private players = new Map<number, { name: string; a: number }>();
  private alliances = new Map<number, { name: string; points: number; towns: number }>();
  private towns: { id: number; x: number; y: number; p: number; pts: number; name: string; ix: number; iy: number }[] = [];
  private townById = new Map<number, MapView['towns'][number]>();
  private hist = new Map<number, Hist[]>();
  private ours: Set<number>; private enemies: Set<number>;
  private mode: Mode = 'sides';
  private view = { cx: 500, cy: 500, scale: 1 };
  private t: number; private tMin: number; private tMax: number;
  private windowDays = 7;
  private playing: number | undefined;
  private highlight: { kind: 'a' | 'p' | 't'; id: number } | null = null;
  private commands: LiveCommand[] = [];
  private showCmds = false;
  private raf = 0;
  private dpr = 1;
  private pointers = new Map<number, { x: number; y: number }>();

  constructor(private root: HTMLElement, private data: MapPayload, private o: Opts) {
    for (const [id, name, a] of data.players) this.players.set(id, { name, a });
    for (const [id, name, points, towns] of data.alliances) this.alliances.set(id, { name, points, towns });
    for (const [id, ix, iy, slot, p, pts, name] of data.towns) {
      const [x, y] = townXY(ix, iy, slot);
      const tw = { id, x, y, p, pts, name, ix, iy };
      this.towns.push(tw); this.townById.set(id, tw);
    }
    for (const [time, town, nP, oP, nA, oA] of data.conquests) {
      let h = this.hist.get(town);
      if (!h) this.hist.set(town, (h = []));
      h.push({ time, newP: nP, oldP: oP, newA: nA, oldA: oA });
    }
    this.ours = new Set(data.sides.ours); this.enemies = new Set(data.sides.enemies);
    const nowS = Math.floor(data.generatedAt / 1000);
    this.tMax = nowS;
    this.tMin = data.conquests.length ? Math.min(data.conquests[0][0], nowS - DAY) : nowS - 30 * DAY;
    this.t = nowS;
    this.fitView();

    const { L, esc } = o;
    root.innerHTML = `<div class="mapwrap"><div class="mapmain"><canvas></canvas><div class="tip"></div>
      <div class="topbar"><button class="btn small on" data-mode="sides">${esc(L('colorSides'))}</button><button class="btn small ghost" data-mode="alliances">${esc(L('colorAlliances'))}</button>
        <input type="search" placeholder="${esc(L('search'))}" list="gc-names"><datalist id="gc-names"></datalist></div>
      <div class="overlay"><button class="btn small" data-play>▶ ${esc(L('play'))}</button><input type="range" min="0" max="1000" value="1000"><span class="when"></span>
        <button class="btn small ghost" data-now>${esc(L('now'))}</button>
        <label class="muted">${esc(L('window'))} <select data-win><option value="1">${esc(L('day1'))}</option><option value="7" selected>${esc(L('day7'))}</option><option value="30">${esc(L('day30'))}</option></select></label></div>
      </div><div class="mapside"></div></div>`;
    this.canvas = root.querySelector('canvas')!;
    this.ctx2 = this.canvas.getContext('2d')!;
    this.tip = root.querySelector('.tip')!;
    this.side = root.querySelector('.mapside')!;
    this.slider = root.querySelector('input[type=range]')!;
    this.whenEl = root.querySelector('.when')!;
    this.playBtn = root.querySelector('[data-play]')!;
    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement!);
    this.fillNames();
    this.resize();
  }

  destroy() { this.ro.disconnect(); clearInterval(this.playing); cancelAnimationFrame(this.raf); }
  wantsCommands() { return this.showCmds; }
  setCommands(c: LiveCommand[]) { this.commands = c; if (this.showCmds) this.draw(); }

  // ------------------------------------------------------------ geometry
  private fitView() {
    if (!this.towns.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tw of this.towns) { if (tw.p === 0) continue; x0 = Math.min(x0, tw.x); y0 = Math.min(y0, tw.y); x1 = Math.max(x1, tw.x); y1 = Math.max(y1, tw.y); }
    if (!Number.isFinite(x0)) return;
    // Centre on our side if known, else the whole world.
    const ours = this.towns.filter((tw) => this.ours.has(this.allianceOf(tw.p)));
    if (ours.length) {
      const cx = ours.reduce((s, tw) => s + tw.x, 0) / ours.length, cy = ours.reduce((s, tw) => s + tw.y, 0) / ours.length;
      this.view = { cx, cy, scale: 0 };
    } else this.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: 0 };
    (this as unknown as { bounds: number[] }).bounds = [x0, y0, x1, y1];
  }
  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * this.dpr));
    if (!this.view.scale) {
      const b = (this as unknown as { bounds?: number[] }).bounds ?? [0, 0, 1000, 1000];
      const ours = this.ours.size > 0;
      const span = ours ? 160 : Math.max(b[2] - b[0], b[3] - b[1], 50) * 1.05;
      this.view.scale = Math.min(r.width, r.height) / span;
    }
    this.draw();
  }
  private toScreen(x: number, y: number): [number, number] {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return [(x - this.view.cx) * this.view.scale + w / 2, (y - this.view.cy) * this.view.scale + h / 2];
  }
  private toWorld(sx: number, sy: number): [number, number] {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    return [(sx - w / 2) / this.view.scale + this.view.cx, (sy - h / 2) / this.view.scale + this.view.cy];
  }

  // ------------------------------------------------------------ ownership at time t
  private allianceOf(playerId: number) { return this.players.get(playerId)?.a ?? 0; }
  private ownerAt(tw: { id: number; p: number }): { p: number; a: number } {
    return ownerAtTime({ p: tw.p, a: this.allianceOf(tw.p) }, this.hist.get(tw.id), this.t, this.tMax);
  }
  private colorFor(p: number, a: number): string {
    if (!p) return COL.ghost;
    if (this.mode === 'sides') {
      if (this.ours.has(a)) return COL.ours;
      if (this.enemies.has(a)) return COL.enemy;
      return a ? COL.neutral : COL.none;
    }
    return a ? allianceColor(a) : COL.none;
  }

  // ------------------------------------------------------------ drawing
  private draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }
  private paint() {
    const c = this.ctx2, dpr = this.dpr;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0f2a3d'; c.fillRect(0, 0, w, h);
    // ocean grid (every 100 = one ocean)
    c.strokeStyle = 'rgba(255,255,255,.08)'; c.lineWidth = 1; c.fillStyle = 'rgba(255,255,255,.25)'; c.font = '11px system-ui';
    const [wx0, wy0] = this.toWorld(0, 0), [wx1, wy1] = this.toWorld(w, h);
    for (let gx = Math.floor(wx0 / 100) * 100; gx <= wx1; gx += 100) { const [sx] = this.toScreen(gx, 0); c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, h); c.stroke(); }
    for (let gy = Math.floor(wy0 / 100) * 100; gy <= wy1; gy += 100) { const [, sy] = this.toScreen(0, gy); c.beginPath(); c.moveTo(0, sy); c.lineTo(w, sy); c.stroke(); }
    if (this.view.scale > 1.2) {
      for (let gx = Math.floor(wx0 / 100) * 100; gx <= wx1; gx += 100) for (let gy = Math.floor(wy0 / 100) * 100; gy <= wy1; gy += 100) {
        if (gx < 0 || gy < 0) continue;
        const [sx, sy] = this.toScreen(gx + 3, gy + 8);
        c.fillText(`O${Math.floor(gx / 100)}${Math.floor(gy / 100)}`, sx, sy);
      }
    }
    const size = Math.max(1.5, Math.min(7, this.view.scale * 0.5));
    const hl = this.highlight;
    for (const tw of this.towns) {
      if (tw.x < wx0 - 2 || tw.x > wx1 + 2 || tw.y < wy0 - 2 || tw.y > wy1 + 2) continue;
      const own = this.ownerAt(tw);
      const [sx, sy] = this.toScreen(tw.x, tw.y);
      const s = size * (tw.pts > 10000 ? 1.25 : tw.pts < 3000 ? 0.8 : 1);
      c.fillStyle = this.colorFor(own.p, own.a);
      c.fillRect(sx - s / 2, sy - s / 2, s, s);
      const isHl = hl && ((hl.kind === 'a' && own.a === hl.id) || (hl.kind === 'p' && own.p === hl.id) || (hl.kind === 't' && tw.id === hl.id));
      if (isHl || (this.o.me && own.p === this.o.me)) { c.strokeStyle = isHl ? '#fff' : COL.me; c.lineWidth = 1.5; c.strokeRect(sx - s / 2 - 2, sy - s / 2 - 2, s + 4, s + 4); }
    }
    // conquests in the window ending at t
    const from = this.t - this.windowDays * DAY;
    const recent = this.data.conquests.filter((q) => q[0] > from && q[0] <= this.t);
    for (const q of recent) {
      const tw = this.townById.get(q[1]);
      if (!tw) continue;
      const [sx, sy] = this.toScreen(tw.x, tw.y);
      const age = (this.t - q[0]) / (this.windowDays * DAY);
      const mine = this.ours.has(q[4]) || this.enemies.has(q[4]) || this.ours.has(q[5]) || this.enemies.has(q[5]);
      c.strokeStyle = this.mode === 'sides' ? (this.ours.has(q[4]) ? COL.ours : this.enemies.has(q[4]) ? COL.enemy : '#ffffff') : allianceColor(q[4] || 1);
      c.globalAlpha = Math.max(0.2, 1 - age) * (this.mode === 'sides' && !mine ? 0.45 : 1);
      c.lineWidth = mine ? 2 : 1.25;
      c.beginPath(); c.arc(sx, sy, size + 3 + 4 * (1 - age), 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
    }
    if (this.showCmds) {
      const nowS = Date.now() / 1000;
      for (const cmd of this.commands) {
        const a = cmd.src.townId ? this.townById.get(cmd.src.townId) : undefined, b = cmd.trg.townId ? this.townById.get(cmd.trg.townId) : undefined;
        if (!a || !b) continue;
        const [x1, y1] = this.toScreen(a.x, a.y), [x2, y2] = this.toScreen(b.x, b.y);
        c.strokeStyle = cmd.side === 'in' ? COL.enemy : cmd.side === 'out' ? '#3ba55d' : '#b5bac1';
        c.globalAlpha = cmd.arrival - nowS < 900 ? 1 : 0.6; c.lineWidth = 1.5; c.setLineDash(cmd.type.includes('support') ? [4, 3] : []);
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
        c.setLineDash([]); c.globalAlpha = 1;
        c.fillStyle = c.strokeStyle; c.beginPath(); c.arc(x2, y2, 3, 0, Math.PI * 2); c.fill();
      }
    }
    this.whenEl.textContent = this.t >= this.tMax ? this.o.L('now') : new Date(this.t * 1000).toLocaleString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    this.renderSide(recent);
  }

  private sideKey = '';
  private renderSide(recent: MapPayload['conquests']) {
    const key = `${this.mode}|${this.t}|${this.windowDays}|${recent.length}|${this.showCmds}`;
    if (key === this.sideKey) return;
    this.sideKey = key;
    const { L, esc } = this.o;
    const pn = (id: number) => (id ? this.players.get(id)?.name ?? `#${id}` : L('ghost'));
    const an = (id: number) => (id ? this.alliances.get(id)?.name ?? `#${id}` : '');
    const legend = this.mode === 'sides'
      ? [[COL.ours, L('ours'), [...this.ours].map(an).join(', ')], [COL.enemy, L('enemies'), [...this.enemies].map(an).join(', ')], [COL.neutral, L('neutral'), ''], [COL.none, L('noAlliance'), ''], [COL.ghost, L('ghost'), '']]
      : [...this.alliances.entries()].sort((a, b) => b[1].points - a[1].points).slice(0, 15).map(([id, a]) => [allianceColor(id), a.name, String(a.towns)]);
    const list = recent.slice(-40).reverse().map((q) => {
      const tw = this.townById.get(q[1]);
      const when = new Date(q[0] * 1000).toLocaleString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<li data-town="${q[1]}" style="cursor:pointer"><span class="muted">${esc(when)}</span> ${esc(L('conquered', { town: tw?.name ?? `#${q[1]}`, to: `${pn(q[2])}${an(q[4]) ? ` [${an(q[4])}]` : ''}`, from: `${pn(q[3])}${an(q[5]) ? ` [${an(q[5])}]` : ''}` }))}</li>`;
    }).join('');
    this.side.innerHTML = `<h3>${esc(L('legend'))}</h3><ul class="list legend">${legend.map(([c, n, extra]) => `<li><span><span class="sw" style="background:${c}"></span>${esc(n)}</span><span class="muted">${esc(extra)}</span></li>`).join('')}</ul>
      <label class="chk"><input type="checkbox" data-cmds ${this.showCmds ? 'checked' : ''}> ${esc(L('showCommands'))}</label>
      <p class="muted">${esc(L('zoomHint'))}</p>
      <h3>${esc(L('conquestsAt', { date: this.whenEl.textContent ?? '' }))}</h3>${list ? `<ul class="list">${list}</ul>` : `<p class="muted">${esc(L('noConquests'))}</p>`}
      ${Object.keys(this.data.history).length > 1 ? `<h3>${esc(L('townsChart'))}</h3><canvas class="chart"></canvas>` : ''}`;
    this.side.querySelector<HTMLInputElement>('[data-cmds]')?.addEventListener('change', (e) => { this.showCmds = (e.target as HTMLInputElement).checked; this.o.onWantCommands(this.showCmds); this.sideKey = ''; this.draw(); });
    this.side.querySelectorAll<HTMLElement>('[data-town]').forEach((li) => li.addEventListener('click', () => this.focusTown(Number(li.dataset.town))));
    this.drawChart();
  }

  private drawChart() {
    const cv = this.side.querySelector<HTMLCanvasElement>('canvas.chart');
    if (!cv) return;
    const days = Object.keys(this.data.history).sort();
    const ids = new Set<number>();
    for (const d of days) for (const k of Object.keys(this.data.history[d])) ids.add(Number(k));
    const show = [...ids].sort((a, b) => (this.alliances.get(b)?.points ?? 0) - (this.alliances.get(a)?.points ?? 0)).filter((id) => this.ours.has(id) || this.enemies.has(id)).concat([...ids].filter((id) => !this.ours.has(id) && !this.enemies.has(id)).slice(0, 4)).slice(0, 8);
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    let max = 1;
    for (const d of days) for (const id of show) max = Math.max(max, this.data.history[d][id] ?? 0);
    for (const id of show) {
      c.strokeStyle = this.mode === 'sides' ? (this.ours.has(id) ? COL.ours : this.enemies.has(id) ? COL.enemy : COL.neutral) : allianceColor(id);
      c.lineWidth = 1.5; c.beginPath();
      days.forEach((d, i) => { const v = this.data.history[d][id]; if (v === undefined) return; const x = (i / Math.max(1, days.length - 1)) * (r.width - 8) + 4; const y = r.height - 6 - (v / max) * (r.height - 14); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    }
  }

  // ------------------------------------------------------------ interaction
  private setT(t: number) { this.t = Math.max(this.tMin, Math.min(this.tMax, t)); this.slider.value = String(Math.round(((this.t - this.tMin) / Math.max(1, this.tMax - this.tMin)) * 1000)); this.draw(); }
  private focusTown(id: number) {
    const tw = this.townById.get(id);
    if (!tw) return;
    this.highlight = { kind: 't', id }; this.view.cx = tw.x; this.view.cy = tw.y; this.view.scale = Math.max(this.view.scale, 8); this.draw();
  }
  private fillNames() {
    const dl = this.root.querySelector('datalist')!;
    const top = [...this.alliances.entries()].sort((a, b) => b[1].points - a[1].points).slice(0, 200).map(([, a]) => a.name);
    dl.innerHTML = top.map((n) => `<option value="${this.o.esc(n)}">`).join('');
  }
  private search(q: string) {
    const s = q.trim().toLowerCase();
    if (!s) { this.highlight = null; return this.draw(); }
    for (const [id, a] of this.alliances) if (a.name.toLowerCase() === s) { this.highlight = { kind: 'a', id }; return this.centerOn((tw) => this.allianceOf(tw.p) === id); }
    for (const [id, p] of this.players) if (p.name.toLowerCase() === s) { this.highlight = { kind: 'p', id }; return this.centerOn((tw) => tw.p === id); }
    const tw = this.towns.find((x) => x.name.toLowerCase() === s) ?? this.towns.find((x) => x.name.toLowerCase().startsWith(s));
    if (tw) return this.focusTown(tw.id);
    const p = [...this.players.entries()].find(([, x]) => x.name.toLowerCase().startsWith(s));
    if (p) { this.highlight = { kind: 'p', id: p[0] }; return this.centerOn((x) => x.p === p[0]); }
  }
  private centerOn(f: (tw: MapView['towns'][number]) => boolean) {
    const sel = this.towns.filter(f);
    if (!sel.length) return this.draw();
    this.view.cx = sel.reduce((a, tw) => a + tw.x, 0) / sel.length; this.view.cy = sel.reduce((a, tw) => a + tw.y, 0) / sel.length;
    this.draw();
  }
  private hit(sx: number, sy: number) {
    let best: MapView['towns'][number] | null = null, bd = 10 * 10;
    for (const tw of this.towns) { const [x, y] = this.toScreen(tw.x, tw.y); const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bd) { bd = d; best = tw; } }
    return best;
  }
  private bind() {
    const { L, esc } = this.o;
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      this.mode = b.dataset.mode as Mode;
      this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((x) => x.className = `btn small ${x.dataset.mode === this.mode ? 'on' : 'ghost'}`);
      this.sideKey = ''; this.draw();
    }));
    const input = this.root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.addEventListener('change', () => this.search(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.search(input.value); });
    this.slider.addEventListener('input', () => this.setT(this.tMin + (Number(this.slider.value) / 1000) * (this.tMax - this.tMin)));
    this.root.querySelector('[data-now]')!.addEventListener('click', () => { this.stop(); this.setT(this.tMax); });
    this.root.querySelector<HTMLSelectElement>('[data-win]')!.addEventListener('change', (e) => { this.windowDays = Number((e.target as HTMLSelectElement).value); this.sideKey = ''; this.draw(); });
    this.playBtn.addEventListener('click', () => {
      if (this.playing) return this.stop();
      if (this.t >= this.tMax) this.setT(Math.max(this.tMin, this.tMax - 30 * DAY));
      this.playBtn.textContent = `⏸ ${L('pause')}`;
      const step = Math.max(600, (this.tMax - Math.min(this.t, this.tMax - DAY)) / 300);
      this.playing = window.setInterval(() => { if (this.t >= this.tMax) return this.stop(); this.setT(this.t + step); }, 80);
    });
    const cv = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    let pinch: { d: number; scale: number } | null = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: this.view.cx, cy: this.view.cy };
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.view.scale }; drag = null; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.view.scale = Math.max(0.3, Math.min(60, pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); return this.draw(); }
      if (drag) { this.view.cx = drag.cx - (e.offsetX - drag.x) / this.view.scale; this.view.cy = drag.cy - (e.offsetY - drag.y) / this.view.scale; this.tip.style.display = 'none'; return this.draw(); }
      const tw = this.hit(e.offsetX, e.offsetY);
      if (!tw) { this.tip.style.display = 'none'; return; }
      const own = this.ownerAt(tw);
      const pl = own.p ? this.players.get(own.p)?.name ?? `#${own.p}` : L('ghost');
      const al = own.a ? this.alliances.get(own.a)?.name ?? `#${own.a}` : L('noAlliance');
      this.tip.innerHTML = `<b>${esc(tw.name)}</b> · ${tw.pts.toLocaleString()} ${esc(L('points'))}<br>${esc(L('owner'))}: ${esc(pl)}<br>${esc(L('alliance'))}: ${esc(al)}<br>${esc(L('island'))}: ${tw.ix}|${tw.iy}`;
      this.tip.style.display = 'block'; this.tip.style.left = `${Math.min(e.offsetX + 14, cv.clientWidth - 270)}px`; this.tip.style.top = `${e.offsetY + 14}px`;
    });
    const up = (e: PointerEvent) => { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) pinch = null; if (!this.pointers.size) drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wy] = this.toWorld(e.offsetX, e.offsetY);
      this.view.scale = Math.max(0.3, Math.min(60, this.view.scale * Math.exp(-e.deltaY * 0.0015)));
      const [nx, ny] = this.toWorld(e.offsetX, e.offsetY);
      this.view.cx += wx - nx; this.view.cy += wy - ny;
      this.draw();
    }, { passive: false });
  }
  private stop() { clearInterval(this.playing); this.playing = undefined; this.playBtn.textContent = `▶ ${this.o.L('play')}`; }
}
