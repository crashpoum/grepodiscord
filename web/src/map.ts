/**
 * World map on canvas: sea + ocean grid, stylized islands at their true positions (official islands.txt), towns
 * coloured by side or alliance, zoom/pan, level-of-detail labels, search, live-command overlay, conquest replay.
 * Performance: the static sea/island layer is rendered into cached tiles per zoom level (LRU, at most a few new tiles
 * per frame); each frame only blits tiles and draws the dynamic overlay for what is in view (spatial grids), and only
 * when something changed (one requestAnimationFrame, nothing while the tab is hidden).
 */
import type { LiveCommand, MapPayload } from '../../src/web/types.js';
import type { WebKey, WebLang } from '../../src/web/strings.js';
import type { TownPanel } from '../../src/web/townPanel.js';
import { fmtAt, typeChip, unitsAny } from './ui.js';
import { fallbackSpeeds, fmtHms, mapRangeRadius, mapTownTravel, parseMapQuery, RULER_UNIT_ORDER, type MapSpeeds, type TravelMods } from '../../src/web/travel.js';
import { injectSprite, loadOfficialIcons, unitIcon } from './icons.js';
import { allianceColor, decodeIslands, Grid, ISLAND_R, islandClass, islandShape, oceanOf, ownerAtTime, SIDE_COLOR, sideOf, townXY, type Hist, type Islands, type Side } from './geo.js';

interface Opts { L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string; lang: WebLang; me: number | null; onWantCommands: (on: boolean) => void; islands: ArrayBuffer | null;
  /** Town-click details (owner history, activity clock, synced troops/incoming) from /api/town. */
  townInfo?: (id: number) => Promise<TownPanel | null>; units?: Record<string, string> }
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
  private highlight: { kind: 'a' | 'p' | 't' | 'o' | 'xy'; id: number; x?: number; y?: number } | null = null;
  private speeds: MapSpeeds;
  private rulerMode = false;
  private rulerA: number | null = null;
  private rulerB: number | null = null;
  private mods: TravelMods = { meteorology: false, cartography: false, lighthouse: false, boost: 0, transport: 'big_transporter' };
  private rangePick = false;
  private rangeOrigin: number | null = null;
  private rangeUnit = 'attack_ship';
  private rangeMin = 60;
  private arrowSegs: { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number; cmd: LiveCommand }[] = [];
  private selected: number | null = null;
  private commands: LiveCommand[] = [];
  private targets = new Map<number, number>();
  private targetsSig = '';
  private showCmds = false; private showTargets = true; private showLabels = true; private showHeat = false;
  private tinfo: { id: number; at: number; data: TownPanel | null; loading: boolean } | null = null;
  private raf = 0; dpr = 1;
  /** Called at the end of every map paint (same frame): the drawing overlay re-projects its shapes. */
  afterPaint: (() => void) | null = null;
  /** Hover hook for overlays: tooltip HTML for a screen point, or null to fall through to towns. */
  hoverExtra: ((sx: number, sy: number) => string | null) | null = null;
  get scale() { return this.view.scale; }
  private tiles = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private tilesInView = 0;
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
    this.speeds = data.speeds ?? fallbackSpeeds();
    injectSprite();
    void loadOfficialIcons().then((ok) => { if (ok) { this.sideKey = ''; this.draw(); } });
    this.computeAllianceLabels();
    this.fitView();

    const { L, esc } = o;
    root.innerHTML = `<div class="mapwrap"><div class="mapmain"><canvas></canvas><div class="tip"></div>
      <div class="topbar"><div class="seg"><button class="on" data-mode="sides">${esc(L('colorSides'))}</button><button data-mode="alliances">${esc(L('colorAlliances'))}</button></div>
        <div class="searchbox"><input type="search" placeholder="${esc(L('mapSearchPlaceholder'))}" autocomplete="off"><ul class="sugg" hidden></ul></div>
        <button class="gbtn" data-ruler title="${esc(L('mapRulerHint'))}">📏 ${esc(L('mapRuler'))}</button>
        <button class="gbtn" data-hl-clear hidden>✕ ${esc(L('mapHighlightClear'))}</button>
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
  wantsCommands() { return this.showCmds || this.showTargets || this.showHeat; }
  setCommands(c: LiveCommand[]) {
    this.commands = c;
    this.targets.clear();
    for (const x of c) if (x.trg.townId && x.side === 'in') this.targets.set(x.trg.townId, (this.targets.get(x.trg.townId) ?? 0) + 1);
    const sig = [...this.targets].map(([k, v]) => `${k}:${v}`).join(',');
    if (sig !== this.targetsSig) { this.targetsSig = sig; this.sideKey = ''; }
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.floor(r.width * dpr)), H = Math.max(1, Math.floor(r.height * dpr));
    // Assigning width/height clears the canvas: only do it when the size really changed (no blank frames).
    if (dpr !== this.dpr) this.tiles.clear();
    this.dpr = dpr;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
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
      // Never read pixels back (Brave's fingerprinting protection adds random noise to getImageData, so tiles would
      // differ on every render and flicker): start from a fresh buffer filled with the sea colour.
      const img = c.createImageData(px, px), buf = new Uint32Array(img.data.buffer);
      const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
      const rgba = (hex: string) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return le ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255; };
      buf.fill(rgba(SEA));
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
    while (this.tiles.size > Math.max(MAX_TILES, this.tilesInView * 2 + 8)) this.tiles.delete(this.tiles.keys().next().value!);
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
    this.tilesInView = (Math.floor(wx1 / span) - Math.floor(wx0 / span) + 1) * (Math.floor(wy1 / span) - Math.floor(wy0 / span) + 1);
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
    const hl = this.highlight;
    // 2b. attack heatmap: conquests in the replay window + live incoming targets (additive soft blobs)
    if (this.showHeat) this.paintHeat(wx0, wy0, wx1, wy1, sc);
    if (hl?.kind === 'o') {
      const ox = Math.floor(hl.id / 10) * 100, oy = (hl.id % 10) * 100;
      const [sx0, sy0] = this.toScreen(ox, oy), [sx1, sy1] = this.toScreen(ox + 100, oy + 100);
      c.fillStyle = 'rgba(255, 225, 77, 0.08)'; c.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
      c.strokeStyle = '#ffe14d'; c.lineWidth = 2.5; c.setLineDash([8, 6]); c.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0); c.setLineDash([]);
    }
    if (this.rangeOrigin !== null) this.paintRangeRing();
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
    const ring = (tw: Town, col: string, extra = 3, lw = 2) => { const [sx, sy] = this.toScreen(tw.x, tw.y); c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(sx, sy, r + extra, 0, Math.PI * 2); c.stroke(); };
    for (const i of visible) {
      const tw = this.towns[i];
      const own = hl || this.o.me ? this.ownerAt(tw) : null;
      if (this.o.me && own && own.p === this.o.me) ring(tw, '#ffe14d', 2.5, 1.5);
      if (hl && ((hl.kind === 'o' && oceanOf(tw.ix, tw.iy) === hl.id) || (own && ((hl.kind === 'a' && own.a === hl.id) || (hl.kind === 'p' && own.p === hl.id) || (hl.kind === 't' && tw.id === hl.id))))) ring(tw, '#ffffff', 4, 2);
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
    // 6. live movement arrows
    this.arrowSegs = [];
    if (this.showCmds) {
      const nowS = Date.now() / 1000;
      const seenPair = new Map<string, number>();
      for (const cmd of this.commands) {
        const a = cmd.src.townId ? this.townById.get(cmd.src.townId) : undefined, b = cmd.trg.townId ? this.townById.get(cmd.trg.townId) : undefined;
        if (!a || !b || a.id === b.id) continue;
        const [x1, y1] = this.toScreen(a.x, a.y), [x2, y2] = this.toScreen(b.x, b.y);
        if (Math.max(x1, x2) < -40 || Math.min(x1, x2) > w + 40 || Math.max(y1, y2) < -40 || Math.min(y1, y2) > h + 40) continue;
        const pk = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        const idx = seenPair.get(pk) ?? 0; seenPair.set(pk, idx + 1);
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const dir = (a.id < b.id ? 1 : -1) * (idx % 2 === 0 ? 1 : -1);
        const curve = Math.min(34, len * 0.16) * (1 + Math.floor(idx / 2) * 0.45) * dir;
        const nx = -dy / len, ny = dx / len;
        const cx = (x1 + x2) / 2 + nx * curve, cy = (y1 + y2) / 2 + ny * curve;
        const urgent = cmd.arrival - nowS < 900;
        const isSup = /support/i.test(cmd.type);
        const col = cmd.side === 'in' ? (isSup ? '#22c7c7' : SIDE_COLOR.enemy) : cmd.side === 'out' ? '#4ade80' : '#cbd5e1';
        c.strokeStyle = col; c.fillStyle = col;
        c.globalAlpha = cmd.ret ? 0.5 : urgent ? 0.95 : 0.72;
        c.lineWidth = urgent && !cmd.ret ? 2.3 : 1.6;
        c.setLineDash(cmd.ret || isSup ? [5, 4] : []);
        c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo(cx, cy, x2, y2); c.stroke();
        c.setLineDash([]);
        // Arrowhead near target town
        const tx = x2 - cx, ty = y2 - cy, tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl, uy = ty / tl, tipX = x2 - ux * (r + 3), tipY = y2 - uy * (r + 3), ah = urgent ? 8 : 6.5;
        c.beginPath(); c.moveTo(tipX, tipY);
        c.lineTo(tipX - ux * ah - uy * ah * 0.55, tipY - uy * ah + ux * ah * 0.55);
        c.lineTo(tipX - ux * ah + uy * ah * 0.55, tipY - uy * ah - ux * ah * 0.55);
        c.closePath(); c.fill();
        // Progress marker when departure time is known
        if (cmd.started && cmd.arrival > cmd.started && nowS >= cmd.started && nowS <= cmd.arrival) {
          const p = (nowS - cmd.started) / (cmd.arrival - cmd.started);
          const q = 1 - p;
          const px = q * q * x1 + 2 * q * p * cx + p * p * x2;
          const py = q * q * y1 + 2 * q * p * cy + p * p * y2;
          c.beginPath(); c.arc(px, py, 3, 0, Math.PI * 2); c.fill();
        }
        this.arrowSegs.push({ x1, y1, cx, cy, x2, y2, cmd });
        c.globalAlpha = 1;
      }
    }
    if (hl?.kind === 'xy' && hl.x !== undefined && hl.y !== undefined) {
      const [sx, sy] = this.toScreen(hl.x, hl.y);
      c.strokeStyle = '#ffe14d'; c.lineWidth = 2;
      c.beginPath(); c.arc(sx, sy, 12, 0, Math.PI * 2); c.moveTo(sx - 18, sy); c.lineTo(sx + 18, sy); c.moveTo(sx, sy - 18); c.lineTo(sx, sy + 18); c.stroke();
    }
    if (this.rulerA !== null) this.paintRuler();
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
  /** Heat per town: each conquest in the window counts 1 (fading with age), each live incoming command 0.6. */
  private heatCache = { key: '', pts: [] as [number, number, number][] };
  private paintHeat(wx0: number, wy0: number, wx1: number, wy1: number, sc: number) {
    const key = `${this.t}|${this.windowDays}|${this.commands.length}`;
    if (this.heatCache.key !== key) {
      const w = new Map<number, number>();
      for (const q of this.recentConquests(this.t - this.windowDays * DAY)) w.set(q[1], (w.get(q[1]) ?? 0) + Math.max(0.3, 1 - (this.t - q[0]) / (this.windowDays * DAY)));
      for (const [id, n] of this.targets) w.set(id, (w.get(id) ?? 0) + 0.6 * n);
      const pts: [number, number, number][] = [];
      for (const [id, v] of w) { const tw = this.townById.get(id); if (tw) pts.push([tw.x, tw.y, v]); }
      this.heatCache = { key, pts };
    }
    const c = this.c;
    const rad = Math.max(14, Math.min(60, sc * 6));
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const [x, y, v] of this.heatCache.pts) {
      if (x < wx0 - 10 || x > wx1 + 10 || y < wy0 - 10 || y > wy1 + 10) continue;
      const [sx, sy] = this.toScreen(x, y);
      const r = rad * Math.min(2, 0.8 + Math.sqrt(v) * 0.4);
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, r);
      const a = Math.min(0.55, 0.18 + v * 0.08);
      g.addColorStop(0, `rgba(255,80,30,${a})`); g.addColorStop(0.5, `rgba(255,160,40,${a * 0.5})`); g.addColorStop(1, 'rgba(255,200,60,0)');
      c.fillStyle = g; c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }
  /** Fetch the clicked town's details once (cached 60 s); the side panel re-renders when they arrive. */
  private loadTownInfo(id: number) {
    if (!this.o.townInfo) return;
    if (this.tinfo && this.tinfo.id === id && Date.now() - this.tinfo.at < 60_000) return;
    this.tinfo = { id, at: Date.now(), data: null, loading: true };
    this.o.townInfo(id).then((d) => { if (this.tinfo?.id === id) { this.tinfo = { id, at: Date.now(), data: d, loading: false }; this.sideKey = ''; this.draw(); } })
      .catch(() => { if (this.tinfo?.id === id) { this.tinfo.loading = false; this.sideKey = ''; this.draw(); } });
  }
  private townInfoHtml(): string {
    const { L, esc, lang } = this.o;
    const ti = this.tinfo;
    if (!ti || ti.id !== this.selected) return '';
    if (ti.loading) return `<p class="muted small">${esc(L('townLoading'))}</p>`;
    const d = ti.data;
    if (!d) return '';
    const day = (sec: number) => new Date(sec * 1000).toLocaleString(lang === 'el' ? 'el-GR' : 'en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    let h = `<h4>${esc(L('townHistory'))}</h4>${d.history.length ? `<ul class="list small">${d.history.map(([t, np, op]) => `<li><span class="muted">${esc(day(t))}</span> ${esc(op || L('ghost'))} → <b>${esc(np || L('ghost'))}</b></li>`).join('')}</ul>` : `<p class="muted small">${esc(L('townNoHistory'))}</p>`}`;
    if (d.clock) {
      // Stored per UTC hour; shown in the viewer's local hours.
      const off = -new Date().getTimezoneOffset() / 60;
      const loc = Array.from({ length: 24 }, (_, i) => d.clock![(((i - off) % 24) + 24) % 24 | 0] ?? 0);
      const max = Math.max(1, ...loc);
      h += `<h4>${esc(L('townClock'))}</h4><div class="clock">${loc.map((n, i) => `<i style="height:${Math.round((n / max) * 100)}%" title="${String(i).padStart(2, '0')}:00 · ${n}"></i>`).join('')}</div><div class="clock-x"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>`;
    }
    if (d.troops) h += `<h4>${esc(L('townTroops'))}</h4><p class="small muted">${esc(d.troops.player)}</p><div class="small">${esc(L('inTown'))}: ${unitsAny(d.troops.town.total, this.o.units ?? {}, esc, 18) || '—'}</div>`;
    if (d.incoming?.length) h += `<h4>${esc(L('townIncoming'))}</h4><ul class="list small">${d.incoming.slice(0, 10).map((x) => `<li>${typeChip(x.cmd.type, L, esc)} ${esc(x.cmd.from_player ?? '?')} · <b>${esc(fmtAt(x.cmd.arrival, lang))}</b></li>`).join('')}</ul>`;
    return h;
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

  private paintRangeRing() {
    const orig = this.rangeOrigin !== null ? this.townById.get(this.rangeOrigin) : undefined;
    if (!orig) return;
    const rad = mapRangeRadius(this.rangeUnit, this.rangeMin * 60, this.speeds, this.mods);
    const [sx, sy] = this.toScreen(orig.x, orig.y);
    const c = this.c;
    if (rad > 0) {
      const rPx = rad * this.view.scale;
      c.save();
      c.fillStyle = 'rgba(255, 190, 50, 0.08)';
      c.beginPath(); c.arc(sx, sy, rPx, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(255, 190, 50, 0.35)'; c.lineWidth = 1.2; c.setLineDash([4, 4]);
      c.beginPath(); c.arc(sx, sy, rPx * 0.5, 0, Math.PI * 2); c.stroke();
      c.strokeStyle = '#ffbe32'; c.lineWidth = 2; c.setLineDash([7, 5]);
      c.beginPath(); c.arc(sx, sy, rPx, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      const lbl = `${fmtHms(this.rangeMin * 60)} · ${this.o.units?.[this.rangeUnit] ?? this.rangeUnit}`;
      c.font = '600 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      const ly = sy - rPx - 4;
      c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineWidth = 3; c.strokeText(lbl, sx, ly);
      c.fillStyle = '#ffbe32'; c.fillText(lbl, sx, ly);
      c.restore();
    }
    c.strokeStyle = '#ffbe32'; c.lineWidth = 2;
    c.beginPath(); c.arc(sx, sy, 8, 0, Math.PI * 2); c.stroke();
  }

  private paintRuler() {
    const a = this.rulerA !== null ? this.townById.get(this.rulerA) : undefined;
    if (!a) return;
    const b = this.rulerB !== null ? this.townById.get(this.rulerB) : undefined;
    const [ax, ay] = this.toScreen(a.x, a.y);
    const c = this.c;
    c.save();
    const pin = (x: number, y: number, col: string, tag: string) => {
      c.fillStyle = col; c.strokeStyle = '#111'; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill(); c.stroke();
      c.font = '700 11px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.strokeStyle = 'rgba(0,0,0,.85)'; c.lineWidth = 3; c.strokeText(tag, x, y - 9);
      c.fillStyle = col; c.fillText(tag, x, y - 9);
    };
    if (b) {
      const [bx, by] = this.toScreen(b.x, b.y);
      c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 4;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.strokeStyle = '#ffe14d'; c.lineWidth = 2; c.setLineDash([7, 5]);
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.setLineDash([]);
      const atk = mapTownTravel(a, b, 'attack_ship', this.speeds, this.mods);
      const col = mapTownTravel(a, b, 'colonize_ship', this.speeds, this.mods);
      if (atk && col) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const txt = `${atk.sameIsland ? '=' : `${atk.distGrid.toFixed(1)} isl`} · ⛵ ${fmtHms(atk.seconds)} · 👑 ${fmtHms(col.seconds)}`;
        c.font = '600 12px system-ui, sans-serif';
        const tw = c.measureText(txt).width + 14;
        c.fillStyle = 'rgba(22, 18, 12, 0.9)'; c.strokeStyle = '#ffe14d'; c.lineWidth = 1.2;
        c.beginPath(); c.roundRect(mx - tw / 2, my - 12, tw, 22, 6); c.fill(); c.stroke();
        c.fillStyle = '#fff5cc'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(txt, mx, my - 1);
      }
      pin(bx, by, '#4ade80', `B: ${b.name}`);
    }
    pin(ax, ay, '#ffe14d', `A: ${a.name}`);
    c.restore();
  }

  // ------------------------------------------------------------ side panel (legend, layers, details, conquests)
  private sideKey = '';
  private renderSide(recent: MapPayload['conquests']) {
    const key = `${this.mode}|${this.t}|${this.windowDays}|${recent.length}|${this.showCmds}|${this.showTargets}|${this.showLabels}|${this.showHeat}|${this.selected}|${this.targets.size}|${this.rulerMode}|${this.rulerA}|${this.rulerB}|${this.rangePick}|${this.rangeOrigin}|${this.rangeUnit}|${this.rangeMin}|${JSON.stringify(this.mods)}`;
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
        <br>${esc(L('island'))}: ${sel.ix}|${sel.iy} · ${esc(L('ocean'))} ${String(oceanOf(sel.ix, sel.iy)).padStart(2, '0')}${nIn ? `<br><b class="hot">${esc(L('incomingHere', { n: nIn }))}</b>` : ''}</p>
        <div class="map-act"><button class="gbtn small" data-from-ruler="${sel.id}">${esc(L('mapRulerFromHere'))}</button>
        <button class="gbtn small" data-from-range="${sel.id}">${esc(L('mapRangeFromHere'))}</button></div>
        ${this.townInfoHtml()}</section>`;
      this.loadTownInfo(sel.id);
    }
    const list = recent.slice(-40).reverse().map((q) => {
      const tw = this.townById.get(q[1]);
      const when = new Date(q[0] * 1000).toLocaleString(this.o.lang === 'el' ? 'el-GR' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<li data-town="${q[1]}"><span class="muted">${esc(when)}</span> ${esc(L('conquered', { town: tw?.name ?? `#${q[1]}`, to: `${pn(q[2])}${an(q[4]) ? ` [${an(q[4])}]` : ''}`, from: `${pn(q[3])}${an(q[5]) ? ` [${an(q[5])}]` : ''}` }))}</li>`;
    }).join('');
    this.side.innerHTML = `${details}${this.rulerHtml()}${this.rangeHtml()}<h3>${esc(L('legend'))}</h3><ul class="legend">${legend.map(([c, n, extra]) => `<li><span class="sw" style="background:${c}"></span><span class="ln">${esc(n)}</span><span class="muted">${esc(extra)}</span></li>`).join('')}
      ${this.mode === 'sides' ? `<li><span class="sw ring"></span><span class="ln">${esc(L('legendTargets'))}</span><span class="muted">${this.targets.size}</span></li>` : ''}</ul>
      ${this.mode === 'sides' ? `<p class="muted small ${src === 'none' ? 'warnline' : ''}">${esc(L(`sidesFrom.${src}` as WebKey))}</p>` : ''}
      <h3>${esc(L('layers'))}</h3>
      <label class="chk"><input type="checkbox" data-l="cmds" ${this.showCmds ? 'checked' : ''}> ${esc(L('mapMovements'))}</label>
      <label class="chk"><input type="checkbox" data-l="targets" ${this.showTargets ? 'checked' : ''}> ${esc(L('highlightTargets'))}</label>
      <label class="chk"><input type="checkbox" data-l="labels" ${this.showLabels ? 'checked' : ''}> ${esc(L('labels'))}</label>
      <label class="chk" title="${esc(L('heatHint'))}"><input type="checkbox" data-l="heat" ${this.showHeat ? 'checked' : ''}> ${esc(L('heatLayer'))}</label>
      <p class="muted small">${esc(L('zoomHint'))}</p>
      <h3>${esc(L('conquestsAt', { date: this.whenEl.textContent ?? '' }))}</h3>${list ? `<ul class="list">${list}</ul>` : `<p class="muted">${esc(L('noConquests'))}</p>`}
      ${Object.keys(this.data.history).length > 1 ? `<h3>${esc(L('townsChart'))}</h3><canvas class="chart"></canvas>` : ''}`;
    this.side.querySelectorAll<HTMLInputElement>('[data-l]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.l;
      if (k === 'cmds') this.showCmds = cb.checked; else if (k === 'targets') this.showTargets = cb.checked; else if (k === 'heat') this.showHeat = cb.checked; else this.showLabels = cb.checked;
      this.o.onWantCommands(this.wantsCommands()); this.sideKey = ''; this.draw();
    }));
    this.side.querySelector('[data-close]')?.addEventListener('click', () => { this.selected = null; this.sideKey = ''; this.draw(); });
    this.bindTools();
    this.side.querySelectorAll<HTMLElement>('[data-town]').forEach((li) => li.addEventListener('click', () => this.focusTown(Number(li.dataset.town))));
    this.drawChart();
  }
  private rulerHtml(): string {
    if (!this.rulerMode && this.rulerA === null) return '';
    const { L, esc } = this.o;
    const a = this.rulerA !== null ? this.townById.get(this.rulerA) : undefined;
    const b = this.rulerB !== null ? this.townById.get(this.rulerB) : undefined;
    let body = '';
    if (!a) body = `<p class="muted small">${esc(L('mapRulerPickA'))}</p>`;
    else if (!b) body = `<p class="small"><b>A:</b> ${esc(a.name)} (${a.ix}|${a.iy})<br><span class="muted">${esc(L('mapRulerPickB'))}</span></p>`;
    else {
      const sample = mapTownTravel(a, b, 'attack_ship', this.speeds, this.mods);
      const dist = sample?.sameIsland ? L('mapRulerSame', { u: fmtHms(sample.uncertainty) }) : L('mapRulerDist', { d: (sample?.distGrid ?? 0).toFixed(1) });
      const rows = RULER_UNIT_ORDER.filter((u) => this.speeds.units[u]).map((u) => {
        const est = mapTownTravel(a, b, u, this.speeds, this.mods)!;
        const name = this.o.units?.[u] ?? u;
        const tr = est.viaTransport ? ` <span class="muted small">(${esc(this.o.units?.[est.viaTransport] ?? est.viaTransport)})</span>` : '';
        return `<tr><td>${unitIcon(u, name, 18)} ${esc(name)}${tr}</td><td class="mono"><b>${fmtHms(est.seconds)}</b></td></tr>`;
      }).join('');
      body = `<p class="small"><b>${esc(a.name)}</b> → <b>${esc(b.name)}</b> <span class="muted">(${esc(dist)})</span></p>
        <div class="map-mods">${this.modsHtml()}</div>
        <div class="map-utbl"><table><tbody>${rows}</tbody></table></div>`;
    }
    return `<section class="det map-tool"><h3>📏 ${esc(L('mapRuler'))} <span>${a && b ? `<button class="x" data-rswap title="${esc(L('mapRulerSwap'))}">⇄</button>` : ''}<button class="x" data-rclear title="${esc(L('mapRulerClear'))}">×</button></span></h3>${body}</section>`;
  }

  private modsHtml(): string {
    const { L, esc } = this.o, m = this.mods;
    return `<label class="chk"><input type="checkbox" data-mod="meteorology"${m.meteorology ? ' checked' : ''}> ${esc(L('mapMeteorology'))}</label>
      <label class="chk"><input type="checkbox" data-mod="cartography"${m.cartography ? ' checked' : ''}> ${esc(L('mapCartography'))}</label>
      <label class="chk"><input type="checkbox" data-mod="lighthouse"${m.lighthouse ? ' checked' : ''}> ${esc(L('mapLighthouse'))}</label>
      <label class="chk"><input type="checkbox" data-mod="fast"${m.transport === 'small_transporter' ? ' checked' : ''}> ${esc(L('mapFastTrans'))}</label>
      <label class="small">${esc(L('mapBoost'))} <input type="number" min="0" max="200" step="5" data-boost value="${m.boost ?? 0}" style="width:4.2em"></label>`;
  }

  private rangeHtml(): string {
    const { L, esc } = this.o;
    const myTowns = this.o.me ? this.towns.filter((tw) => tw.p === this.o.me).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const orig = this.rangeOrigin !== null ? this.townById.get(this.rangeOrigin) : undefined;
    const rad = orig ? mapRangeRadius(this.rangeUnit, this.rangeMin * 60, this.speeds, this.mods) : 0;
    let inAll = 0, inEnemy = 0;
    if (orig && rad > 0) {
      const r2 = rad * rad;
      this.townGrid.each(orig.x - rad - 1, orig.y - rad - 1, orig.x + rad + 1, orig.y + rad + 1, (i) => {
        const tw = this.towns[i];
        if (tw.id === orig.id || (tw.x - orig.x) ** 2 + (tw.y - orig.y) ** 2 > r2) return;
        inAll++;
        if (this.sideOfTown(tw) === 'enemy') inEnemy++;
      });
    }
    const unitOpts = RULER_UNIT_ORDER.filter((u) => this.speeds.units[u]).map((u) => `<option value="${u}"${u === this.rangeUnit ? ' selected' : ''}>${esc(this.o.units?.[u] ?? u)}</option>`).join('');
    const mySel = myTowns.length ? `<select data-rng-my><option value="">${esc(L('mapRangeOrigin'))}…</option>${myTowns.map((t) => `<option value="${t.id}"${t.id === this.rangeOrigin ? ' selected' : ''}>${esc(t.name)} (${t.ix}|${t.iy})</option>`).join('')}</select>` : '';
    return `<details class="det map-tool"${orig || this.rangePick ? ' open' : ''}><summary>🎯 ${esc(L('mapRange'))}</summary>
      <div class="map-rng">
        ${mySel}
        <div class="map-act"><button class="gbtn small${this.rangePick ? ' on' : ''}" data-rng-pick>${esc(L('mapRangePick'))}</button>${orig ? `<button class="gbtn small" data-rng-clr>✕</button>` : ''}</div>
        ${orig ? `<p class="small"><b>${esc(orig.name)}</b> (${orig.ix}|${orig.iy})</p>` : ''}
        <label class="small">${esc(L('mapRangeUnit'))} <select data-rng-unit>${unitOpts}</select></label>
        <label class="small">${esc(L('mapRangeTime'))} <input type="number" min="1" max="2880" step="5" data-rng-min value="${this.rangeMin}" style="width:5em"></label>
        <div class="map-act">${[15, 30, 60, 120, 240].map((m) => `<button class="gbtn small${this.rangeMin === m ? ' on' : ''}" data-rng-pre="${m}">${m < 60 ? `${m}m` : `${m / 60}h`}</button>`).join('')}</div>
        ${orig && this.rulerA === null ? `<div class="map-mods">${this.modsHtml()}</div>` : ''}
        ${orig ? `<p class="small">${rad > 0 ? esc(L('mapRangeIn', { n: inAll, e: inEnemy })) : esc(L('mapRangeNone'))}</p>` : ''}
      </div></details>`;
  }

  private bindTools() {
    this.side.querySelector('[data-rswap]')?.addEventListener('click', () => { [this.rulerA, this.rulerB] = [this.rulerB, this.rulerA]; this.sideKey = ''; this.draw(); });
    this.side.querySelector('[data-rclear]')?.addEventListener('click', () => { this.rulerA = this.rulerB = null; this.rulerMode = false; this.root.querySelector('[data-ruler]')?.classList.remove('on'); this.sideKey = ''; this.draw(); });
    this.side.querySelectorAll<HTMLElement>('[data-from-ruler]').forEach((b) => b.addEventListener('click', () => {
      this.rulerA = Number(b.dataset.fromRuler); this.rulerB = null; this.rulerMode = true;
      this.root.querySelector('[data-ruler]')?.classList.add('on'); this.sideKey = ''; this.draw();
    }));
    this.side.querySelectorAll<HTMLElement>('[data-from-range]').forEach((b) => b.addEventListener('click', () => {
      this.rangeOrigin = Number(b.dataset.fromRange); this.rangePick = false; this.sideKey = ''; this.draw();
    }));
    this.side.querySelectorAll<HTMLInputElement>('[data-mod]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.mod;
      if (k === 'fast') this.mods.transport = cb.checked ? 'small_transporter' : 'big_transporter';
      else if (k === 'meteorology' || k === 'cartography' || k === 'lighthouse') this.mods[k] = cb.checked;
      this.sideKey = ''; this.draw();
    }));
    this.side.querySelector<HTMLInputElement>('[data-boost]')?.addEventListener('change', (e) => {
      this.mods.boost = Math.max(0, Math.min(200, Number((e.target as HTMLInputElement).value) || 0)); this.sideKey = ''; this.draw();
    });
    this.side.querySelector<HTMLSelectElement>('[data-rng-my]')?.addEventListener('change', (e) => {
      this.rangeOrigin = Number((e.target as HTMLSelectElement).value) || null; this.rangePick = false; this.sideKey = ''; this.draw();
    });
    this.side.querySelector('[data-rng-pick]')?.addEventListener('click', () => { this.rangePick = !this.rangePick; this.sideKey = ''; this.draw(); });
    this.side.querySelector('[data-rng-clr]')?.addEventListener('click', () => { this.rangeOrigin = null; this.rangePick = false; this.sideKey = ''; this.draw(); });
    this.side.querySelector<HTMLSelectElement>('[data-rng-unit]')?.addEventListener('change', (e) => { this.rangeUnit = (e.target as HTMLSelectElement).value; this.sideKey = ''; this.draw(); });
    this.side.querySelector<HTMLInputElement>('[data-rng-min]')?.addEventListener('change', (e) => { this.rangeMin = Math.max(1, Math.min(2880, Number((e.target as HTMLInputElement).value) || 60)); this.sideKey = ''; this.draw(); });
    this.side.querySelectorAll<HTMLElement>('[data-rng-pre]').forEach((b) => b.addEventListener('click', () => { this.rangeMin = Number(b.dataset.rngPre); this.sideKey = ''; this.draw(); }));
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
    const cw = Math.round(r.width * dpr), chh = Math.round(r.height * dpr);
    if (cv.width !== cw) cv.width = cw;
    if (cv.height !== chh) cv.height = chh;
    const c = cv.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
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
  /** Search suggestions: oceans ("45", "ocean 45"), coords ("450|530"), alliances, players, towns. */
  private suggestions(q: string): { kind: 'a' | 'p' | 't' | 'o' | 'xy'; id: number; label: string; sub: string }[] {
    const out: { kind: 'a' | 'p' | 't' | 'o' | 'xy'; id: number; label: string; sub: string; rank: number }[] = [];
    const sq = parseMapQuery(q);
    if (sq?.kind === 'ocean') {
      let cnt = 0; for (const tw of this.towns) if (oceanOf(tw.ix, tw.iy) === sq.ocean) cnt++;
      if (cnt > 0 || (sq.ocean >= 10 && sq.ocean <= 99)) out.push({ kind: 'o', id: sq.ocean, label: this.o.L('oceanN', { n: String(sq.ocean).padStart(2, '0') }), sub: `${cnt} 🏛`, rank: -2 });
    } else if (sq?.kind === 'xy') {
      out.push({ kind: 'xy', id: sq.ix * 10000 + sq.iy, label: `${sq.ix}|${sq.iy}`, sub: this.o.L('oceanN', { n: String(oceanOf(sq.ix, sq.iy)).padStart(2, '0') }), rank: -2 });
    }
    const norm = (x: string) => x.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const s = norm(q.trim());
    if (s.length < 2 && !out.length) return [];
    if (s.length >= 2) {
      const score = (n: string) => { const l = norm(n); return l === s ? 0 : l.startsWith(s) ? 1 : l.includes(s) ? 2 : -1; };
      for (const [id, a] of this.alliances) { const r = score(a.name); if (r >= 0) out.push({ kind: 'a', id, label: a.name, sub: `${a.towns} 🏛`, rank: r * 3 }); }
      for (const [id, p] of this.players) { const r = score(p.name); if (r >= 0) out.push({ kind: 'p', id, label: p.name, sub: this.alliances.get(p.a)?.name ?? '', rank: r * 3 + 1 }); }
      if (out.length < 30) for (const tw of this.towns) { const r = score(tw.name); if (r >= 0) out.push({ kind: 't', id: tw.id, label: tw.name, sub: `${tw.ix}|${tw.iy} · O${String(oceanOf(tw.ix, tw.iy)).padStart(2, '0')}`, rank: r * 3 + 2 }); if (out.length > 200) break; }
    }
    return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).slice(0, 10);
  }
  private pick(kind: 'a' | 'p' | 't' | 'o' | 'xy', id: number) {
    this.sugg.hidden = true;
    const clr = this.root.querySelector<HTMLElement>('[data-hl-clear]');
    if (kind === 't') { if (clr) clr.hidden = false; return this.focusTown(id); }
    if (kind === 'o') {
      this.highlight = { kind: 'o', id }; if (clr) clr.hidden = false;
      const ox = Math.floor(id / 10) * 100 + 50, oy = (id % 10) * 100 + 50;
      this.view.cx = ox; this.view.cy = oy; this.view.scale = Math.max(1, Math.min(12, Math.min(this.w, this.h) / 112));
      return this.draw();
    }
    if (kind === 'xy') {
      const ix = Math.floor(id / 10000), iy = id % 10000;
      this.highlight = { kind: 'xy', id, x: ix + 0.5, y: iy + 0.5 }; if (clr) clr.hidden = false;
      this.view.cx = ix + 0.5; this.view.cy = iy + 0.5; this.view.scale = Math.max(this.view.scale, 18);
      return this.draw();
    }
    this.highlight = { kind, id }; if (clr) clr.hidden = false;
    this.centerOn((tw) => (kind === 'a' ? this.allianceOf(tw.p) === id : tw.p === id));
  }
  private hit(sx: number, sy: number): Town | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const rad = 12 / this.view.scale;
    let best: Town | null = null, bd = 12 * 12;
    this.townGrid.each(wx - rad, wy - rad, wx + rad, wy + rad, (i) => { const tw = this.towns[i]; const [x, y] = this.toScreen(tw.x, tw.y); const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bd) { bd = d; best = tw; } });
    return best;
  }
  private hitArrow(sx: number, sy: number): LiveCommand | null {
    if (!this.showCmds || !this.arrowSegs.length) return null;
    for (let i = this.arrowSegs.length - 1; i >= 0; i--) {
      const a = this.arrowSegs[i];
      let px = a.x1, py = a.y1;
      for (let k = 1; k <= 6; k++) {
        const t = k / 6, q = 1 - t;
        const nx = q * q * a.x1 + 2 * q * t * a.cx + t * t * a.x2, ny = q * q * a.y1 + 2 * q * t * a.cy + t * t * a.y2;
        const dx = nx - px, dy = ny - py, l2 = dx * dx + dy * dy;
        const u = l2 ? Math.max(0, Math.min(1, ((sx - px) * dx + (sy - py) * dy) / l2)) : 0;
        if (Math.hypot(sx - px - u * dx, sy - py - u * dy) < 8) return a.cmd;
        px = nx; py = ny;
      }
    }
    return null;
  }
  private showArrowTip(cmd: LiveCommand, x: number, y: number) {
    const { esc } = this.o;
    const left = fmtHms(cmd.arrival - Date.now() / 1000);
    this.tipHtml(`<b>${esc(cmd.type)}</b> · ${left}<br>${esc(cmd.src.town)} (${esc(cmd.src.player)}) → ${esc(cmd.trg.town)} (${esc(cmd.trg.player)})`, x, y);
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
      const icon = { a: '🛡', p: '👤', t: '🏛', o: '🌊', xy: '📍' } as const;
      this.sugg.innerHTML = res.map((r) => `<li data-k="${r.kind}" data-id="${r.id}"><span>${icon[r.kind]} ${this.o.esc(r.label)}</span><span class="muted">${this.o.esc(r.sub)}</span></li>`).join('');
      this.sugg.hidden = !res.length;
      if (!input.value.trim()) { this.highlight = null; this.root.querySelector<HTMLElement>('[data-hl-clear]')!.hidden = true; this.draw(); }
    }, 120); });
    let activeIdx = -1;
    input.addEventListener('keydown', (e) => {
      const items = [...this.sugg.querySelectorAll<HTMLElement>('li')];
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); activeIdx = (activeIdx + 1) % items.length; items.forEach((li, i) => li.classList.toggle('on', i === activeIdx)); return; }
      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length; items.forEach((li, i) => li.classList.toggle('on', i === activeIdx)); return; }
      if (e.key === 'Enter') {
        const li = items[activeIdx];
        if (li) { input.value = li.querySelector('span')!.textContent!.slice(2).trim(); this.pick(li.dataset.k as 'a' | 'p' | 't' | 'o' | 'xy', Number(li.dataset.id)); activeIdx = -1; return; }
        const f = this.suggestions(input.value)[0]; if (f) this.pick(f.kind, f.id);
      }
      if (e.key === 'Escape') { this.sugg.hidden = true; activeIdx = -1; }
    });
    this.sugg.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest<HTMLElement>('li'); if (li) { input.value = li.querySelector('span')!.textContent!.slice(2).trim(); this.pick(li.dataset.k as 'a' | 'p' | 't' | 'o' | 'xy', Number(li.dataset.id)); } });
    this.root.querySelector('[data-ruler]')!.addEventListener('click', (e) => {
      this.rulerMode = !this.rulerMode;
      (e.currentTarget as HTMLElement).classList.toggle('on', this.rulerMode);
      if (this.rulerMode && this.selected && this.rulerA === null) this.rulerA = this.selected;
      if (this.rulerMode) this.root.querySelector('.mapwrap')!.classList.add('side-open');
      this.sideKey = ''; this.draw();
    });
    this.root.querySelector('[data-hl-clear]')!.addEventListener('click', (e) => {
      this.highlight = null; input.value = ''; (e.currentTarget as HTMLElement).hidden = true; this.draw();
    });
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
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (!hover) return; const ex = this.hoverExtra?.(hover.x, hover.y); if (ex) return this.tipHtml(ex, hover.x, hover.y); const tw = this.hit(hover.x, hover.y); if (tw) return this.showTip(tw, hover.x, hover.y); const ac = this.hitArrow(hover.x, hover.y); if (ac) return this.showArrowTip(ac, hover.x, hover.y); this.tip.style.display = 'none'; });
    });
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved && this.pointers.size === 1) {
        const tw = this.hit(e.offsetX, e.offsetY);
        if (tw && this.rangePick) { this.rangeOrigin = tw.id; this.rangePick = false; this.sideKey = ''; this.root.querySelector('.mapwrap')!.classList.add('side-open'); this.draw(); }
        else if (tw && this.rulerMode) {
          if (this.rulerA === null || this.rulerA === tw.id) this.rulerA = tw.id;
          else this.rulerB = tw.id;
          this.sideKey = ''; this.root.querySelector('.mapwrap')!.classList.add('side-open'); this.draw();
        } else { this.selected = tw ? tw.id : null; this.sideKey = ''; if (tw) this.root.querySelector('.mapwrap')!.classList.add('side-open'); this.draw(); }
      }
      this.pointers.delete(e.pointerId); if (this.pointers.size < 2) pinch = null; if (!this.pointers.size) drag = null;
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { hover = null; this.tip.style.display = 'none'; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  }
  private stop() { clearInterval(this.playing); this.playing = undefined; this.playBtn.textContent = `▶ ${this.o.L('play')}`; }
}
