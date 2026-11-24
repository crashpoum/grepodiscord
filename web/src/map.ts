/**
 * World map on canvas: sea + ocean grid, stylized islands at their true positions (official islands.txt), towns
 * coloured by side or alliance, zoom/pan, level-of-detail labels, search, live-command overlay, conquest replay.
 * Performance: the static sea/island layer is rendered into cached tiles per zoom level (LRU, at most a few new tiles
 * per frame); each frame only blits tiles and draws the dynamic overlay for what is in view (spatial grids), and only
 * when something changed (one requestAnimationFrame, nothing while the tab is hidden).
 */
import type { LiveCommand, MapPayload } from '../../src/web/types.js';
import type { WebKey, WebLang } from '../../src/web/strings.js';
import { allianceColor, decodeIslands, Grid, ISLAND_R, islandClass, islandShape, oceanOf, ownerAtTime, SIDE_COLOR, sideOf, townXY, type Hist, type Islands, type Side } from './geo.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; me: number | null; onWantCommands: (on: boolean) => void; islands: ArrayBuffer | null }
type Mode = 'sides' | 'alliances';
const DAY = 86400;
const TILE = 256;
const MAX_TILES = 40;
const NEW_TILES_PER_FRAME = 2;
const SEA = '#1d5677', SEA_DEEP = '#164764', SAND = '#d8c48c', GRASS = '#6f9a4f', ROCK = '#8c8676';

interface Town { id: number; x: number; y: number; p: number; pts: number; name: string; ix: number; iy: number }

export class MapView {
  private canvas: HTMLCanvasElement;
  private c: CanvasRenderingContext2D;
  private tip: HTMLDivElement; private side: HTMLDivElement; private slider: HTMLInputElement; private whenEl: HTMLSpanElement; private playBtn: HTMLButtonElement; private sugg: HTMLUListElement;
  private ro: ResizeObserver;
  private players = new Map<number, { name: string; a: number }>();
  private alliances = new Map<number, { name: string; points: number; towns: number }>();
  private towns: Town[] = [];
  private townById = new Map<number, Town>();
  private townGrid = new Grid(4);
  private isl: Islands | null;
  private islGrid = new Grid(10);
  private shapes = new Map<number, Float32Array>();
  private hist = new Map<number, Hist[]>();
  private mode: Mode = 'sides';
  private view = { cx: 500, cy: 500, scale: 0 };
  private t: number; private tMin: number; private tMax: number;
  private windowDays = 7;
  private playing: number | undefined;
  private highlight: { kind: 'a' | 'p' | 't'; id: number } | null = null;
  private selected: number | null = null;
  private commands: LiveCommand[] = [];
  private targets = new Map<number, number>();
  private showCmds = false; private showTargets = true; private showLabels = true;
  private raf = 0; dpr = 1;
  /** Called at the end of every map paint (same frame): the drawing overlay re-projects its shapes. */
  afterPaint: (() => void) | null = null;
  /** Hover hook for overlays: tooltip HTML for a screen point, or null to fall through to towns. */
  hoverExtra: ((sx: number, sy: number) => string | null) | null = null;
  get scale() { return this.view.scale; }
  private tiles = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private pointers = new Map<number, { x: number; y: number }>();
  private labelsA: { id: number; x: number; y: number; n: number }[] = [];
  private perf: number[] = [];

  constructor(private root: HTMLElement, private data: MapPayload, private o: Opts) {
    for (const [id, name, a] of data.players) this.players.set(id, { name, a });
    for (const [id, name, points, towns] of data.alliances) this.alliances.set(id, { name, points, towns });
    for (const [id, ix, iy, slot, p, pts, name] of data.towns) {
      const [x, y] = townXY(ix, iy, slot);
      const tw = { id, x, y, p, pts, name, ix, iy };
      this.townGrid.add(this.towns.length, x, y);
      this.towns.push(tw); this.townById.set(id, tw);
    }
    for (const [time, town, nP, oP, nA, oA] of data.conquests) {
      let h = this.hist.get(town);
      if (!h) this.hist.set(town, (h = []));
      h.push({ time, newP: nP, oldP: oP, newA: nA, oldA: oA });
    }
    this.isl = o.islands ? decodeIslands(o.islands) : null;
    if (this.isl) for (let i = 0; i < this.isl.n; i++) this.islGrid.add(i, this.isl.xs[i], this.isl.ys[i]);
    const nowS = Math.floor(data.generatedAt / 1000);
    this.tMax = nowS; this.t = nowS;
    this.tMin = data.conquests.length ? Math.min(data.conquests[0][0], nowS - DAY) : nowS - 30 * DAY;
    this.computeAllianceLabels();
    this.fitView();

    const { L, esc } = o;
    root.innerHTML = `<div class="mapwrap"><div class="mapmain"><canvas></canvas><div class="tip"></div>
      <div class="topbar"><div class="seg"><button class="on" data-mode="sides">${esc(L('colorSides'))}</button><button data-mode="alliances">${esc(L('colorAlliances'))}</button></div>
        <div class="searchbox"><input type="search" placeholder="${esc(L('searchHint'))}" autocomplete="off"><ul class="sugg" hidden></ul></div>
        <button class="gbtn side-toggle">☰ ${esc(L('legend'))}</button></div>
      <div class="zoom"><button data-z="1">+</button><button data-z="-1">−</button></div>
      <div class="overlay"><button class="gbtn" data-play>▶ ${esc(L('play'))}</button><input type="range" min="0" max="1000" value="1000"><span class="when"></span>
        <button class="gbtn" data-now>${esc(L('now'))}</button>
        <select data-win><option value="1">${esc(L('day1'))}</option><option value="7" selected>${esc(L('day7'))}</option><option value="30">${esc(L('day30'))}</option></select></div>
      </div><div class="mapside"></div></div>`;
    const q = <T extends Element>(s: string) => root.querySelector<T>(s)!;
    this.canvas = q('canvas'); this.c = this.canvas.getContext('2d', { alpha: false })!;
    this.tip = q('.tip'); this.side = q('.mapside'); this.slider = q('input[type=range]'); this.whenEl = q('.when'); this.playBtn = q('[data-play]'); this.sugg = q('.sugg');
    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement!);
    document.addEventListener('visibilitychange', this.onVis);
    this.resize();
    (window as unknown as { __gcMap?: MapView }).__gcMap = this;
  }

  destroy() { this.ro.disconnect(); clearInterval(this.playing); cancelAnimationFrame(this.raf); document.removeEventListener('visibilitychange', this.onVis); this.tiles.clear(); }
  wantsCommands() { return this.showCmds || this.showTargets; }
  setCommands(c: LiveCommand[]) {
    this.commands = c;
    this.targets.clear();
    for (const x of c) if (x.trg.townId && x.side === 'in') this.targets.set(x.trg.townId, (this.targets.get(x.trg.townId) ?? 0) + 1);
    this.sideKey = '';
    this.draw();
  }
  /** Paint timings (ms) of the last frames, for the perf report. */
  perfStats() { const a = [...this.perf].sort((x, y) => x - y); return { frames: a.length, median: a[a.length >> 1] ?? 0, p95: a[Math.floor(a.length * 0.95)] ?? 0, max: a[a.length - 1] ?? 0, tiles: this.tiles.size, islands: this.isl?.n ?? 0, towns: this.towns.length }; }
  private onVis = () => { if (!document.hidden) this.draw(); };

  // ------------------------------------------------------------ geometry
  private fitView() {
    const ours = this.towns.filter((tw) => this.sideOfTown(tw) === 'own');
    const pts = ours.length ? ours : this.towns.filter((tw) => tw.p);
    if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tw of pts) { x0 = Math.min(x0, tw.x); y0 = Math.min(y0, tw.y); x1 = Math.max(x1, tw.x); y1 = Math.max(y1, tw.y); }
    this.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: 0 };
    this.fitSpan = ours.length ? Math.min(110, Math.max(50, Math.min(x1 - x0, y1 - y0) * 0.6)) : Math.min(160, Math.max(x1 - x0, y1 - y0, 50) * 1.05);
  }
  private fitSpan = 200;
  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * this.dpr));
    if (!this.view.scale) this.view.scale = Math.min(r.width, r.height) / this.fitSpan;
    this.draw();
  }
  get w() { return this.canvas.width / this.dpr; }
  get h() { return this.canvas.height / this.dpr; }
  toScreen(x: number, y: number): [number, number] { return [(x - this.view.cx) * this.view.scale + this.w / 2, (y - this.view.cy) * this.view.scale + this.h / 2]; }
  toWorld(sx: number, sy: number): [number, number] { return [(sx - this.w / 2) / this.view.scale + this.view.cx, (sy - this.h / 2) / this.view.scale + this.view.cy]; }
  zoomAt(sx: number, sy: number, f: number) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.view.scale = Math.max(0.4, Math.min(80, this.view.scale * f));
    const [nx, ny] = this.toWorld(sx, sy);
    this.view.cx += wx - nx; this.view.cy += wy - ny;
    this.draw();
  }

  // ------------------------------------------------------------ ownership / colour
  private allianceOf(p: number) { return this.players.get(p)?.a ?? 0; }
  private ownerAt(tw: Town): { p: number; a: number } { return ownerAtTime({ p: tw.p, a: this.allianceOf(tw.p) }, this.hist.get(tw.id), this.t, this.tMax); }
  private sideOfTown(tw: Town): Side { return sideOf(tw.p, this.allianceOf(tw.p), this.data.sides); }
  private colorFor(p: number, a: number): string {
    if (this.mode === 'sides') return SIDE_COLOR[sideOf(p, a, this.data.sides)];
    if (!p) return SIDE_COLOR.ghost;
    return a ? allianceColor(a) : SIDE_COLOR.none;
  }
  private computeAllianceLabels() {
    const acc = new Map<number, { x: number; y: number; n: number }>();
    for (const tw of this.towns) { const a = this.allianceOf(tw.p); if (!a) continue; const e = acc.get(a) ?? { x: 0, y: 0, n: 0 }; e.x += tw.x; e.y += tw.y; e.n++; acc.set(a, e); }
    this.labelsA = [...acc].filter(([, e]) => e.n >= 8).sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([id, e]) => ({ id, x: e.x / e.n, y: e.y / e.n, n: e.n }));
  }

  // ------------------------------------------------------------ static layer tiles
  private tileZ() { return Math.max(-2, Math.min(7, Math.round(Math.log2(this.view.scale)))); }
  private renderTile(z: number, tx: number, ty: number): HTMLCanvasElement | OffscreenCanvas {
    const s = 2 ** z, span = TILE / s, px = Math.round(TILE * this.dpr);
    const cv: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
    const c = cv.getContext('2d') as CanvasRenderingContext2D;
    c.fillStyle = SEA; c.fillRect(0, 0, px, px);
    const k = px / span; // device px per world unit
    const wx0 = tx * span, wy0 = ty * span;
    const isl = this.isl;
    if (isl && k < 3) {
      // Far zoom: islands are a few pixels, so write them straight into the pixel buffer (no paths): ~40k islands in a few ms.
      const img = c.getImageData(0, 0, px, px), buf = new Uint32Array(img.data.buffer);
      const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
      const rgba = (hex: string) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return le ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255; };
      const colS = rgba(SAND), colG = rgba(GRASS), colR = rgba(ROCK);
      this.islGrid.each(wx0 - 1, wy0 - 1, wx0 + span + 1, wy0 + span + 1, (i) => {
        const cls = islandClass(isl.types[i]);
        if (cls === 'rock' && k < 1.5) return;
        const cx = Math.floor((isl.xs[i] + 0.5 - wx0) * k), cy = Math.floor((isl.ys[i] + 0.5 - wy0) * k);
        const rr = cls === 'big' ? (k >= 1.5 ? 1 : 0) : 0;
        const col = cls === 'rock' ? colR : cls === 'big' && k >= 1.5 ? colG : colS;
        for (let yy = cy - rr; yy <= cy + rr; yy++) { if (yy < 0 || yy >= px) continue; for (let xx = cx - rr; xx <= cx + rr; xx++) if (xx >= 0 && xx < px) buf[yy * px + xx] = col; }
      });
      c.putImageData(img, 0, 0);
    } else if (isl) {
      const sand = new Path2D(), grass = new Path2D(), rock = new Path2D();
      const detail = k >= 7;
      this.islGrid.each(wx0 - 1, wy0 - 1, wx0 + span + 1, wy0 + span + 1, (i) => {
        const t = isl.types[i], cls = islandClass(t);
        if (cls === 'rock' && k < 2) return;
        const cx = (isl.xs[i] + 0.5 - wx0) * k, cy = (isl.ys[i] + 0.5 - wy0) * k, r = Math.max(ISLAND_R[cls] * k, (cls === 'big' ? 2.2 : cls === 'small' ? 1.7 : 0.9) * this.dpr);
        const target = cls === 'rock' ? rock : sand;
        if (r < 1.6) { target.rect(cx - Math.max(0.6, r), cy - Math.max(0.6, r), Math.max(1.2, r * 2), Math.max(1.2, r * 2)); return; }
        let sh = this.shapes.get(t);
        if (!sh) this.shapes.set(t, (sh = islandShape(t)));
        const poly = (p: Path2D, rr: number) => { p.moveTo(cx + sh![0] * rr, cy + sh![1] * rr); for (let j = 2; j < sh!.length; j += 2) p.lineTo(cx + sh![j] * rr, cy + sh![j + 1] * rr); p.closePath(); };
        poly(target, r);
        if (detail && cls !== 'rock') poly(grass, r * 0.74);
      });
      if (k >= 7) { c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = Math.max(1, k * 0.05); c.stroke(sand); }
      c.fillStyle = SAND; c.fill(sand);
      c.fillStyle = GRASS; c.fill(grass);
      c.fillStyle = ROCK; c.fill(rock);
    }
    return cv;
  }
  private getTile(z: number, tx: number, ty: number, mayRender: boolean) {
    const key = `${z}:${tx}:${ty}`;
    const t = this.tiles.get(key);
    if (t) { this.tiles.delete(key); this.tiles.set(key, t); return t; } // LRU touch
    if (!mayRender) return null;
    const nt = this.renderTile(z, tx, ty);
    this.tiles.set(key, nt);
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!);
    return nt;
  }

  // ------------------------------------------------------------ drawing
  draw() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; if (!document.hidden) this.paint(); }); }
  private paint() {
    const t0 = performance.now();
    const c = this.c, dpr = this.dpr, w = this.w, h = this.h, sc = this.view.scale;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = SEA_DEEP; c.fillRect(0, 0, w, h);
    const [wx0, wy0] = this.toWorld(0, 0), [wx1, wy1] = this.toWorld(w, h);
    // 1. static tiles
    const z = this.tileZ(), span = TILE / 2 ** z;
    let budget = NEW_TILES_PER_FRAME, missing = false;
    c.imageSmoothingEnabled = true;
    for (let tx = Math.floor(wx0 / span); tx <= Math.floor(wx1 / span); tx++) for (let ty = Math.floor(wy0 / span); ty <= Math.floor(wy1 / span); ty++) {
      const cached = this.tiles.has(`${z}:${tx}:${ty}`);
      const tile = this.getTile(z, tx, ty, budget > 0);
      if (tile && !cached) budget--;
      const [sx, sy] = this.toScreen(tx * span, ty * span);
      const size = span * sc;
      if (tile) { c.drawImage(tile as CanvasImageSource, sx, sy, size + 0.5, size + 0.5); continue; }
      missing = true;
      const parent = this.tiles.get(`${z - 1}:${Math.floor(tx / 2)}:${Math.floor(ty / 2)}`);
      if (parent) { const pw = (parent as HTMLCanvasElement).width / 2; c.drawImage(parent as CanvasImageSource, (tx & 1) * pw, (ty & 1) * pw, pw, pw, sx, sy, size + 0.5, size + 0.5); }
    }
    // 2. ocean grid + numbers
    c.strokeStyle = 'rgba(255,255,255,.16)'; c.lineWidth = 1;
    c.beginPath();
    for (let gx = Math.ceil(wx0 / 100) * 100; gx <= wx1; gx += 100) { const [sx] = this.toScreen(gx, 0); c.moveTo(Math.round(sx) + 0.5, 0); c.lineTo(Math.round(sx) + 0.5, h); }
    for (let gy = Math.ceil(wy0 / 100) * 100; gy <= wy1; gy += 100) { const [, sy] = this.toScreen(0, gy); c.moveTo(0, Math.round(sy) + 0.5); c.lineTo(w, Math.round(sy) + 0.5); }
    c.stroke();
    if (sc >= 3) { // sub-grid every 10 units when close
      c.strokeStyle = 'rgba(255,255,255,.05)'; c.beginPath();
      for (let gx = Math.ceil(wx0 / 10) * 10; gx <= wx1; gx += 10) { const [sx] = this.toScreen(gx, 0); c.moveTo(sx, 0); c.lineTo(sx, h); }
      for (let gy = Math.ceil(wy0 / 10) * 10; gy <= wy1; gy += 10) { const [, sy] = this.toScreen(0, gy); c.moveTo(0, sy); c.lineTo(w, sy); }
      c.stroke();
    }
    c.font = `600 ${Math.max(12, Math.min(40, sc * 9))}px system-ui, sans-serif`; c.fillStyle = 'rgba(255,255,255,.22)'; c.textBaseline = 'top';
    for (let gx = Math.floor(wx0 / 100) * 100; gx <= wx1; gx += 100) for (let gy = Math.floor(wy0 / 100) * 100; gy <= wy1; gy += 100) {
      if (gx < 0 || gy < 0 || gx >= 1000 || gy >= 1000) continue;
      const [sx, sy] = this.toScreen(gx, gy);
      c.fillText(String(oceanOf(gx, gy)).padStart(2, '0'), sx + 6, sy + 6);
    }
    // 3. towns (batched per colour)
    const r = Math.max(1.6, Math.min(4.5, sc * 0.08));
    const byCol = new Map<string, Path2D>();
    const visible: number[] = [];
    this.townGrid.each(wx0 - 1, wy0 - 1, wx1 + 1, wy1 + 1, (i) => {
      const tw = this.towns[i];
      if (tw.x < wx0 - 1 || tw.x > wx1 + 1 || tw.y < wy0 - 1 || tw.y > wy1 + 1) return;
      visible.push(i);
      const own = this.ownerAt(tw);
      const col = this.colorFor(own.p, own.a);
      let p = byCol.get(col);
      if (!p) byCol.set(col, (p = new Path2D()));
      const [sx, sy] = this.toScreen(tw.x, tw.y);
      const rr = r * (tw.pts > 10000 ? 1.2 : tw.pts < 3000 ? 0.8 : 1);
      if (rr < 2.2) p.rect(sx - rr, sy - rr, rr * 2, rr * 2); else { p.moveTo(sx + rr, sy); p.arc(sx, sy, rr, 0, Math.PI * 2); }
    });
    for (const [col, p] of byCol) { c.fillStyle = col; c.fill(p); }
    if (r >= 2.2) { c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 1; for (const p of byCol.values()) c.stroke(p); }
    // 4. highlights: me, search, selection, live targets
    const hl = this.highlight;
    const ring = (tw: Town, col: string, extra = 3, lw = 2) => { const [sx, sy] = this.toScreen(tw.x, tw.y); c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(sx, sy, r + extra, 0, Math.PI * 2); c.stroke(); };
    for (const i of visible) {
      const tw = this.towns[i];
      const own = hl || this.o.me ? this.ownerAt(tw) : null;
      if (this.o.me && own && own.p === this.o.me) ring(tw, '#ffe14d', 2.5, 1.5);
      if (hl && own && ((hl.kind === 'a' && own.a === hl.id) || (hl.kind === 'p' && own.p === hl.id) || (hl.kind === 't' && tw.id === hl.id))) ring(tw, '#ffffff', 4, 2);
      if (this.showTargets && this.targets.has(tw.id)) ring(tw, '#ff9f1a', 5 + Math.min(6, this.targets.get(tw.id)!), 2.5);
      if (this.selected === tw.id) ring(tw, '#ffffff', 7, 1.5);
    }
    // 5. conquests in the replay window
    const from = this.t - this.windowDays * DAY;
    const recent = this.recentConquests(from);
    for (const q of recent) {
      const tw = this.townById.get(q[1]);
      if (!tw || tw.x < wx0 || tw.x > wx1 || tw.y < wy0 || tw.y > wy1) continue;
      const age = (this.t - q[0]) / (this.windowDays * DAY);
      const ns = sideOf(q[2], q[4], this.data.sides), os = sideOf(q[3], q[5], this.data.sides);
      const involved = ns === 'own' || ns === 'ally' || ns === 'enemy' || os === 'own' || os === 'ally' || os === 'enemy';
      // Conquests between other alliances only show when zoomed in (and faintly), so the war stays readable.
      if (this.mode === 'sides' && !involved && (sc < 8 || age > 0.5)) continue;
      c.globalAlpha = Math.max(0.25, 1 - age);
      if (this.mode === 'sides' && !involved) c.globalAlpha *= 0.5;
      ring(tw, this.mode === 'sides' ? (ns === 'own' || ns === 'ally' || ns === 'enemy' ? SIDE_COLOR[ns] : os === 'own' || os === 'ally' ? '#ffffff' : '#e8dcc0') : allianceColor(q[4] || 1), 3 + 5 * (1 - age), involved ? 2 : 1);
      c.globalAlpha = 1;
    }
    // 6. live commands
    if (this.showCmds) {
      const nowS = Date.now() / 1000;
      for (const cmd of this.commands) {
        const a = cmd.src.townId ? this.townById.get(cmd.src.townId) : undefined, b = cmd.trg.townId ? this.townById.get(cmd.trg.townId) : undefined;
        if (!a || !b) continue;
        const [x1, y1] = this.toScreen(a.x, a.y), [x2, y2] = this.toScreen(b.x, b.y);
        c.strokeStyle = cmd.side === 'in' ? SIDE_COLOR.enemy : cmd.side === 'out' ? '#4ade80' : '#d0d0d0';
        c.globalAlpha = cmd.arrival - nowS < 900 ? 1 : 0.6; c.lineWidth = 1.6; c.setLineDash(/support/i.test(cmd.type) ? [5, 4] : []);
        c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
        c.setLineDash([]); c.globalAlpha = 1;
      }
    }
    // 7. labels (level of detail)
    if (this.showLabels) this.paintLabels(visible, r);
    this.whenEl.textContent = this.t >= this.tMax ? this.o.L('now') : new Date(this.t * 1000).toLocaleString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    this.renderSide(recent);
    this.perf.push(performance.now() - t0);
    if (this.perf.length > 240) this.perf.shift();
    this.afterPaint?.();
    if (missing) this.draw(); // more tiles to render next frame
  }
  /** Show arbitrary (already escaped) tooltip HTML at a screen point. */
  tipHtml(html: string, x: number, y: number) {
    this.tip.innerHTML = html; this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(x + 14, this.w - 240)}px`; this.tip.style.top = `${Math.min(y + 14, this.h - 80)}px`;
  }
  private paintLabels(visible: number[], r: number) {
    const c = this.c, sc = this.view.scale;
    c.textBaseline = 'middle'; c.lineJoin = 'round';
    if (sc < 9) { // alliance names at their centroid
      c.font = `700 ${sc < 2 ? 11 : 13}px system-ui, sans-serif`; c.textAlign = 'center';
      const boxes: [number, number, number, number][] = [];
      for (const l of this.labelsA.slice(0, sc < 2 ? 15 : 40)) {
        const [sx, sy] = this.toScreen(l.x, l.y);
        if (sx < -80 || sy < -20 || sx > this.w + 80 || sy > this.h + 20) continue;
        const name = this.alliances.get(l.id)?.name ?? '';
        const bw = c.measureText(name).width / 2 + 4, bh = 9;
        if (boxes.some(([x0, y0, x1, y1]) => sx + bw > x0 && sx - bw < x1 && sy + bh > y0 && sy - bh < y1)) continue; // no overlapping labels
        boxes.push([sx - bw, sy - bh, sx + bw, sy + bh]);
        const side = sideOf(1, l.id, this.data.sides);
        c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 3; c.strokeText(name, sx, sy);
        c.fillStyle = side === 'own' || side === 'ally' || side === 'enemy' ? SIDE_COLOR[side] : '#f3ead2'; c.fillText(name, sx, sy);
      }
      c.textAlign = 'start';
      return;
    }
    if (sc < 16) return;
    const max = 350;
    c.font = `600 ${sc >= 40 ? 12 : 11}px system-ui, sans-serif`; c.textAlign = 'center';
    let n = 0;
    const boxes: [number, number, number, number][] = [];
    // Targets and big towns first; a label that would overlap one already drawn is skipped.
    const order = visible.filter((i) => sc >= 26 || this.towns[i].pts >= 6000 || this.targets.has(this.towns[i].id))
      .sort((a, b) => (this.targets.has(this.towns[b].id) ? 1e6 : 0) + this.towns[b].pts - (this.targets.has(this.towns[a].id) ? 1e6 : 0) - this.towns[a].pts);
    for (const i of order) {
      const tw = this.towns[i];
      if (++n > max) break;
      const [sx, sy] = this.toScreen(tw.x, tw.y);
      const bw = c.measureText(tw.name).width / 2 + 2, ly = sy - r - 8;
      if (boxes.some(([x0, y0, x1, y1]) => sx + bw > x0 && sx - bw < x1 && ly + 7 > y0 && ly - 7 < y1)) continue;
      boxes.push([sx - bw, ly - 7, sx + bw, ly + 7]);
      c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineWidth = 3; c.strokeText(tw.name, sx, sy - r - 8);
      c.fillStyle = '#fff'; c.fillText(tw.name, sx, sy - r - 8);
      if (sc >= 40 && tw.p) {
        const pn = this.players.get(tw.p)?.name ?? '', py = sy + r + 9, pw = c.measureText(pn).width / 2 + 2;
        if (!boxes.some(([x0, y0, x1, y1]) => sx + pw > x0 && sx - pw < x1 && py + 7 > y0 && py - 7 < y1)) {
          boxes.push([sx - pw, py - 7, sx + pw, py + 7]);
          c.font = '11px system-ui, sans-serif'; c.strokeText(pn, sx, py); c.fillStyle = '#ffe9b0'; c.fillText(pn, sx, py); c.font = '600 12px system-ui, sans-serif';
        }
      }
    }
    c.textAlign = 'start';
  }
  private recentCache = { from: -1, to: -1, list: [] as MapPayload['conquests'] };
  private recentConquests(from: number) {
    if (this.recentCache.from !== from || this.recentCache.to !== this.t) {
      const cq = this.data.conquests;
      let lo = 0, hi = cq.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cq[m][0] <= from) lo = m + 1; else hi = m; }
      const list: MapPayload['conquests'] = [];
      for (let i = lo; i < cq.length && cq[i][0] <= this.t; i++) list.push(cq[i]);
      this.recentCache = { from, to: this.t, list };
    }
    return this.recentCache.list;
  }

  // ------------------------------------------------------------ side panel (legend, layers, details, conquests)
  private sideKey = '';
  private renderSide(recent: MapPayload['conquests']) {
    const key = `${this.mode}|${this.t}|${this.windowDays}|${recent.length}|${this.showCmds}|${this.showTargets}|${this.showLabels}|${this.selected}|${this.targets.size}`;
    if (key === this.sideKey) return;
    this.sideKey = key;
    const { L, esc } = this.o;
    const s = this.data.sides;
    const pn = (id: number) => (id ? this.players.get(id)?.name ?? `#${id}` : L('ghost'));
    const an = (id: number) => (id ? this.alliances.get(id)?.name ?? `#${id}` : '');
    const legend: [string, string, string][] = this.mode === 'sides'
      ? [[SIDE_COLOR.own, L('legendOwn'), s.ours.map(an).join(', ') || '—'], [SIDE_COLOR.ally, L('legendAllies'), (s.allies ?? []).map(an).join(', ') || '—'], [SIDE_COLOR.enemy, L('legendEnemies'), s.enemies.map(an).join(', ') || '—'],
        [SIDE_COLOR.other, L('legendOthers'), ''], [SIDE_COLOR.none, L('noAlliance'), ''], [SIDE_COLOR.ghost, L('ghost'), '']]
      : [...this.alliances.entries()].sort((a, b) => b[1].points - a[1].points).slice(0, 15).map(([id, a]) => [allianceColor(id), a.name, String(a.towns)]);
    const src = (s as { source?: string }).source ?? 'set';
    const sel = this.selected !== null ? this.townById.get(this.selected) : undefined;
    let details = '';
    if (sel) {
      const own = this.ownerAt(sel);
      const nIn = this.targets.get(sel.id) ?? 0;
      details = `<section class="det"><h3>${esc(sel.name)} <button class="x" data-close>×</button></h3>
        <p>${sel.pts.toLocaleString()} ${esc(L('points'))}<br>${esc(L('owner'))}: <b>${esc(pn(own.p))}</b><br>${esc(L('alliance'))}: ${esc(an(own.a) || L('noAlliance'))}
        <br>${esc(L('island'))}: ${sel.ix}|${sel.iy} · ${esc(L('ocean'))} ${String(oceanOf(sel.ix, sel.iy)).padStart(2, '0')}${nIn ? `<br><b class="hot">${esc(L('incomingHere', { n: nIn }))}</b>` : ''}</p></section>`;
    }
    const list = recent.slice(-40).reverse().map((q) => {
      const tw = this.townById.get(q[1]);
      const when = new Date(q[0] * 1000).toLocaleString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<li data-town="${q[1]}"><span class="muted">${esc(when)}</span> ${esc(L('conquered', { town: tw?.name ?? `#${q[1]}`, to: `${pn(q[2])}${an(q[4]) ? ` [${an(q[4])}]` : ''}`, from: `${pn(q[3])}${an(q[5]) ? ` [${an(q[5])}]` : ''}` }))}</li>`;
    }).join('');
    this.side.innerHTML = `${details}<h3>${esc(L('legend'))}</h3><ul class="legend">${legend.map(([c, n, extra]) => `<li><span class="sw" style="background:${c}"></span><span class="ln">${esc(n)}</span><span class="muted">${esc(extra)}</span></li>`).join('')}
      ${this.mode === 'sides' ? `<li><span class="sw ring"></span><span class="ln">${esc(L('legendTargets'))}</span><span class="muted">${this.targets.size}</span></li>` : ''}</ul>
      ${this.mode === 'sides' ? `<p class="muted small ${src === 'none' ? 'warnline' : ''}">${esc(L(`sidesFrom.${src}` as WebKey))}</p>` : ''}
      <h3>${esc(L('layers'))}</h3>
      <label class="chk"><input type="checkbox" data-l="cmds" ${this.showCmds ? 'checked' : ''}> ${esc(L('showCommands'))}</label>
      <label class="chk"><input type="checkbox" data-l="targets" ${this.showTargets ? 'checked' : ''}> ${esc(L('highlightTargets'))}</label>
      <label class="chk"><input type="checkbox" data-l="labels" ${this.showLabels ? 'checked' : ''}> ${esc(L('labels'))}</label>
      <p class="muted small">${esc(L('zoomHint'))}</p>
      <h3>${esc(L('conquestsAt', { date: this.whenEl.textContent ?? '' }))}</h3>${list ? `<ul class="list">${list}</ul>` : `<p class="muted">${esc(L('noConquests'))}</p>`}
      ${Object.keys(this.data.history).length > 1 ? `<h3>${esc(L('townsChart'))}</h3><canvas class="chart"></canvas>` : ''}`;
    this.side.querySelectorAll<HTMLInputElement>('[data-l]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.l;
      if (k === 'cmds') this.showCmds = cb.checked; else if (k === 'targets') this.showTargets = cb.checked; else this.showLabels = cb.checked;
      this.o.onWantCommands(this.wantsCommands()); this.sideKey = ''; this.draw();
    }));
    this.side.querySelector('[data-close]')?.addEventListener('click', () => { this.selected = null; this.sideKey = ''; this.draw(); });
    this.side.querySelectorAll<HTMLElement>('[data-town]').forEach((li) => li.addEventListener('click', () => this.focusTown(Number(li.dataset.town))));
    this.drawChart();
  }
  private drawChart() {
    const cv = this.side.querySelector<HTMLCanvasElement>('canvas.chart');
    if (!cv) return;
    const days = Object.keys(this.data.history).sort();
    const ids = new Set<number>();
    for (const d of days) for (const k of Object.keys(this.data.history[d])) ids.add(Number(k));
    const s = this.data.sides;
    const mine = (id: number) => sideOf(1, id, s);
    const show = [...ids].filter((id) => mine(id) !== 'other').concat([...ids].filter((id) => mine(id) === 'other').slice(0, 4)).slice(0, 8);
    const r = cv.getBoundingClientRect(), dpr = this.dpr;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    let max = 1;
    for (const d of days) for (const id of show) max = Math.max(max, this.data.history[d][id] ?? 0);
    for (const id of show) {
      c.strokeStyle = this.mode === 'sides' ? SIDE_COLOR[mine(id)] : allianceColor(id);
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
    this.highlight = { kind: 't', id }; this.selected = id; this.sideKey = '';
    this.view.cx = tw.x; this.view.cy = tw.y; this.view.scale = Math.max(this.view.scale, 30); this.draw();
  }
  private centerOn(f: (tw: Town) => boolean) {
    const sel = this.towns.filter(f);
    if (!sel.length) return this.draw();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tw of sel) { x0 = Math.min(x0, tw.x); y0 = Math.min(y0, tw.y); x1 = Math.max(x1, tw.x); y1 = Math.max(y1, tw.y); }
    this.view.cx = (x0 + x1) / 2; this.view.cy = (y0 + y1) / 2;
    this.view.scale = Math.max(1, Math.min(30, Math.min(this.w, this.h) / Math.max(8, (x1 - x0) * 1.2, (y1 - y0) * 1.2)));
    this.draw();
  }
  /** Search suggestions: alliances, players, towns (prefix first, then substring), max 8. */
  private suggestions(q: string): { kind: 'a' | 'p' | 't'; id: number; label: string; sub: string }[] {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const out: { kind: 'a' | 'p' | 't'; id: number; label: string; sub: string; rank: number }[] = [];
    const score = (n: string) => { const l = n.toLowerCase(); return l === s ? 0 : l.startsWith(s) ? 1 : l.includes(s) ? 2 : -1; };
    for (const [id, a] of this.alliances) { const r = score(a.name); if (r >= 0) out.push({ kind: 'a', id, label: a.name, sub: `${a.towns} 🏛`, rank: r * 3 }); }
    for (const [id, p] of this.players) { const r = score(p.name); if (r >= 0) out.push({ kind: 'p', id, label: p.name, sub: this.alliances.get(p.a)?.name ?? '', rank: r * 3 + 1 }); }
    if (out.length < 30) for (const tw of this.towns) { const r = score(tw.name); if (r >= 0) out.push({ kind: 't', id: tw.id, label: tw.name, sub: `${tw.ix}|${tw.iy}`, rank: r * 3 + 2 }); if (out.length > 200) break; }
    return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).slice(0, 8);
  }
  private pick(kind: 'a' | 'p' | 't', id: number) {
    this.sugg.hidden = true;
    if (kind === 't') return this.focusTown(id);
    this.highlight = { kind, id };
    this.centerOn((tw) => (kind === 'a' ? this.allianceOf(tw.p) === id : tw.p === id));
  }
  private hit(sx: number, sy: number): Town | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const rad = 12 / this.view.scale;
    let best: Town | null = null, bd = 12 * 12;
    this.townGrid.each(wx - rad, wy - rad, wx + rad, wy + rad, (i) => { const tw = this.towns[i]; const [x, y] = this.toScreen(tw.x, tw.y); const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bd) { bd = d; best = tw; } });
    return best;
  }
  private showTip(tw: Town, x: number, y: number) {
    const { L, esc } = this.o;
    const own = this.ownerAt(tw);
    const pl = own.p ? this.players.get(own.p)?.name ?? `#${own.p}` : L('ghost');
    const al = own.a ? this.alliances.get(own.a)?.name ?? `#${own.a}` : L('noAlliance');
    const n = this.targets.get(tw.id);
    this.tip.innerHTML = `<b>${esc(tw.name)}</b> · ${tw.pts.toLocaleString()}<br>${esc(pl)} · ${esc(al)}<br><span class="muted">${tw.ix}|${tw.iy} · ${esc(L('ocean'))} ${String(oceanOf(tw.ix, tw.iy)).padStart(2, '0')}</span>${n ? `<br><b class="hot">${esc(L('incomingHere', { n }))}</b>` : ''}`;
    this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(x + 14, this.w - 240)}px`; this.tip.style.top = `${Math.min(y + 14, this.h - 80)}px`;
  }
  private bind() {
    const { L } = this.o;
    this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      this.mode = b.dataset.mode as Mode;
      this.root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      this.sideKey = ''; this.draw();
    }));
    const input = this.root.querySelector<HTMLInputElement>('.searchbox input')!;
    let st = 0;
    input.addEventListener('input', () => { clearTimeout(st); st = window.setTimeout(() => {
      const res = this.suggestions(input.value);
      const icon = { a: '🛡', p: '👤', t: '🏛' } as const;
      this.sugg.innerHTML = res.map((r) => `<li data-k="${r.kind}" data-id="${r.id}"><span>${icon[r.kind]} ${this.o.esc(r.label)}</span><span class="muted">${this.o.esc(r.sub)}</span></li>`).join('');
      this.sugg.hidden = !res.length;
      if (!input.value.trim()) { this.highlight = null; this.draw(); }
    }, 120); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = this.suggestions(input.value)[0]; if (f) this.pick(f.kind, f.id); } if (e.key === 'Escape') this.sugg.hidden = true; });
    this.sugg.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest<HTMLElement>('li'); if (li) { input.value = li.querySelector('span')!.textContent!.slice(2).trim(); this.pick(li.dataset.k as 'a' | 'p' | 't', Number(li.dataset.id)); } });
    this.root.querySelector('.side-toggle')!.addEventListener('click', () => this.root.querySelector('.mapwrap')!.classList.toggle('side-open'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-z]').forEach((b) => b.addEventListener('click', () => this.zoomAt(this.w / 2, this.h / 2, Number(b.dataset.z) > 0 ? 1.6 : 1 / 1.6)));
    this.slider.addEventListener('input', () => this.setT(this.tMin + (Number(this.slider.value) / 1000) * (this.tMax - this.tMin)));
    this.root.querySelector('[data-now]')!.addEventListener('click', () => { this.stop(); this.setT(this.tMax); });
    this.root.querySelector<HTMLSelectElement>('[data-win]')!.addEventListener('change', (e) => { this.windowDays = Number((e.target as HTMLSelectElement).value); this.sideKey = ''; this.draw(); });
    this.playBtn.addEventListener('click', () => {
      if (this.playing) return this.stop();
      if (this.t >= this.tMax) this.setT(Math.max(this.tMin, this.tMax - 30 * DAY));
      this.playBtn.textContent = `⏸ ${L('pause')}`;
      const step = Math.max(600, (this.tMax - Math.min(this.t, this.tMax - DAY)) / 300);
      this.playing = window.setInterval(() => { if (document.hidden) return; if (this.t >= this.tMax) return this.stop(); this.setT(this.t + step); }, 80);
    });
    const cv = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    let pinch: { d: number; scale: number } | null = null;
    let hover: { x: number; y: number } | null = null, hoverRaf = 0;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: this.view.cx, cy: this.view.cy, moved: false };
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.view.scale }; drag = null; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; const f = (pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / this.view.scale; return this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, f); }
      if (drag) {
        if (Math.abs(e.offsetX - drag.x) + Math.abs(e.offsetY - drag.y) > 4) drag.moved = true;
        this.view.cx = drag.cx - (e.offsetX - drag.x) / this.view.scale; this.view.cy = drag.cy - (e.offsetY - drag.y) / this.view.scale; this.tip.style.display = 'none'; return this.draw();
      }
      hover = { x: e.offsetX, y: e.offsetY };
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (!hover) return; const ex = this.hoverExtra?.(hover.x, hover.y); if (ex) return this.tipHtml(ex, hover.x, hover.y); const tw = this.hit(hover.x, hover.y); if (tw) this.showTip(tw, hover.x, hover.y); else this.tip.style.display = 'none'; });
    });
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved && this.pointers.size === 1) { const tw = this.hit(e.offsetX, e.offsetY); this.selected = tw ? tw.id : null; this.sideKey = ''; if (tw) this.root.querySelector('.mapwrap')!.classList.add('side-open'); this.draw(); }
      this.pointers.delete(e.pointerId); if (this.pointers.size < 2) pinch = null; if (!this.pointers.size) drag = null;
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { hover = null; this.tip.style.display = 'none'; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  }
  private stop() { clearInterval(this.playing); this.playing = undefined; this.playBtn.textContent = `▶ ${this.o.L('play')}`; }
}
