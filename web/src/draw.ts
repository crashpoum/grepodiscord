/**
 * Strategy markup overlay for the world map: freehand, line, arrow, ellipse, rectangle and text notes, shared live with
 * everyone viewing the same guild + world. Performance:
 * - its own canvas above the map: adding/removing a shape repaints only this layer, never the static map tiles;
 * - shapes are stored in world coordinates and re-projected in the map's frame (map.afterPaint), culled by bounding box;
 * - freehand strokes are simplified with RDP before upload; polling is a cheap revision check driven by the app's 1 s timer.
 */
import { fitPoints, MARK_COLORS, MARK_LIMITS, MARK_WIDTHS, sanitizeText, type Mark, type MarkKind, type MarksView, type MarkTtl } from '../../src/web/marksCore.js';
import type { WebKey } from '../../src/web/strings.js';
import type { MapView } from './map.js';

export type Tool = MarkKind | 'move' | 'eraser';
interface Opts {
  L: (k: WebKey, v?: Record<string, string | number>) => string; esc: (s: unknown) => string;
  get: (path: string) => Promise<Response>;
  post: (path: string, body: unknown) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;
}
const TOOLS: [Tool, string, WebKey][] = [
  ['move', '✋', 'toolMove'], ['pen', '✎', 'toolPen'], ['line', '╱', 'toolLine'], ['arrow', '➚', 'toolArrow'],
  ['circle', '◯', 'toolCircle'], ['rect', '▭', 'toolRect'], ['text', 'T', 'toolText'], ['eraser', '⌫', 'toolEraser'],
];
const POLL_MS = 3000;

/** World-space bounding box of a shape (text gets a generous box; refined in screen space when hit-testing). */
export function markBox(m: Pick<Mark, 'kind' | 'pts'>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < m.pts.length; i += 2) { x0 = Math.min(x0, m.pts[i]); y0 = Math.min(y0, m.pts[i + 1]); x1 = Math.max(x1, m.pts[i]); y1 = Math.max(y1, m.pts[i + 1]); }
  return [x0, y0, x1, y1];
}
/** Distance from point to segment (screen px). */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
export function fmtLeft(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export class DrawLayer {
  readonly cv: HTMLCanvasElement;
  private c: CanvasRenderingContext2D;
  private bar: HTMLElement;
  private msgEl: HTMLElement;
  private marks: Mark[] = [];
  private boxes = new WeakMap<Mark, [number, number, number, number]>();
  private rev: number | undefined;
  private canClearAll = false;
  private visible = true;
  private open = false;
  tool: Tool = 'move';
  color: string = MARK_COLORS[0];
  width: number = MARK_WIDTHS[1];
  ttl: MarkTtl = '24h';
  private draft: { kind: MarkKind; pts: number[] } | null = null;
  private undoIds: number[] = [];
  private seq = 0;
  private raf = 0;
  private lastPoll = 0;
  private polling = false;
  private textBox: HTMLInputElement | null = null;
  private armed: { btn: HTMLElement; until: number } | null = null;
  readonly perf: number[] = [];

  constructor(private map: MapView, host: HTMLElement, private o: Opts) {
    const { L, esc } = o;
    this.cv = document.createElement('canvas');
    this.cv.className = 'drawlayer';
    this.c = this.cv.getContext('2d')!;
    host.querySelector('canvas')!.after(this.cv);
    this.bar = document.createElement('div');
    this.bar.className = 'drawbar';
    this.bar.innerHTML = `<button class="dtog" data-act="open" title="${esc(L('drawTitle'))}">✎</button><button class="dtog dvis on" data-act="vis" title="${esc(L('drawShow'))}">👁</button>
      <div class="dtools" hidden>
        ${TOOLS.map(([t, ic, k]) => `<button data-tool="${t}" title="${esc(L(k))}" aria-label="${esc(L(k))}"${t === 'move' ? ' class="on"' : ''}>${ic}</button>`).join('')}
        <hr><div class="dcolors">${MARK_COLORS.map((c) => `<button data-color="${c}" style="--c:${c}"${c === this.color ? ' class="on"' : ''} aria-label="${esc(L('drawColor'))} ${c}"></button>`).join('')}</div>
        <div class="dwidths">${MARK_WIDTHS.map((w) => `<button data-width="${w}" title="${esc(L('drawWidth'))}"${w === this.width ? ' class="on"' : ''}><i style="height:${w}px"></i></button>`).join('')}</div>
        <select data-ttl title="${esc(L('drawTtl'))}">${(['1h', '6h', '24h', '7d'] as MarkTtl[]).map((t) => `<option value="${t}"${t === this.ttl ? ' selected' : ''}>${esc(L(t === '1h' ? 'ttl1h' : t === '6h' ? 'ttl6h' : t === '24h' ? 'ttl24h' : 'ttl7d'))}</option>`).join('')}</select>
        <hr><button data-act="undo" title="${esc(L('drawUndo'))}">↶</button>
        <button data-act="mine" class="dwide" title="${esc(L('drawClearMine'))}">${esc(L('drawClearMine'))}</button>
        <button data-act="all" class="dwide danger" hidden title="${esc(L('drawClearAll'))}">${esc(L('drawClearAll'))}</button>
        <span class="dcount"></span>
      </div><div class="dmsg" hidden></div>`;
    host.appendChild(this.bar);
    this.msgEl = this.bar.querySelector('.dmsg')!;
    this.bind();
    map.afterPaint = () => this.paint();
    map.hoverExtra = (sx, sy) => this.hover(sx, sy);
    void this.poll(true);
  }

  // ------------------------------------------------------------ sync
  /** Called by the app's single 1 s timer: a revision check every 3 s (204 when nothing changed). */
  maybePoll(now = Date.now()) { if (!document.hidden && now - this.lastPoll >= POLL_MS) void this.poll(); }
  async poll(force = false) {
    if (this.polling) return;
    this.polling = true; this.lastPoll = Date.now();
    try {
      const res = await this.o.get(`/api/marks${!force && this.rev !== undefined ? `?rev=${this.rev}` : ''}`);
      if (res.status === 204 || !res.ok) return;
      const v = (await res.json()) as MarksView;
      this.rev = v.rev;
      const temp = this.marks.filter((m) => m.id < 0); // optimistic shapes still in flight
      this.marks = [...v.marks, ...temp];
      this.canClearAll = v.canClearAll;
      this.bar.querySelector<HTMLElement>('[data-act=all]')!.hidden = !v.canClearAll;
      this.undoIds = this.undoIds.filter((id) => this.marks.some((m) => m.id === id));
      this.updateCount();
      this.schedule();
    } catch { /* offline: try again on the next tick */ } finally { this.polling = false; }
  }
  setMarks(v: MarksView) { this.rev = v.rev; this.marks = v.marks; this.canClearAll = v.canClearAll; this.updateCount(); this.schedule(); }
  private updateCount() { this.bar.querySelector('.dcount')!.textContent = this.o.L('drawCount', { n: this.marks.length }); }
  private flash(msg: string) { this.msgEl.textContent = msg; this.msgEl.hidden = false; clearTimeout((this.msgEl as unknown as { t?: number }).t); (this.msgEl as unknown as { t?: number }).t = window.setTimeout(() => { this.msgEl.hidden = true; }, 4000); }

  private async create(kind: MarkKind, pts: number[], text = '') {
    const body = { kind, color: this.color, width: this.width, pts: pts.map((v) => Math.round(v * 100) / 100), text, ttl: this.ttl };
    const temp: Mark = { id: -(++this.seq), kind, color: this.color, width: this.width, pts: body.pts, text, author: this.o.L('drawYou'), mine: true, createdAt: Date.now(), expiresAt: Date.now() + 3600_000 };
    this.marks.push(temp); this.schedule();
    const r = await this.o.post('/api/marks', body).catch(() => ({ ok: false, status: 0, body: {} as Record<string, unknown> }));
    this.marks = this.marks.filter((m) => m !== temp);
    if (r.ok && r.body.mark) { const m = r.body.mark as Mark; this.marks.push(m); this.undoIds.push(m.id); }
    else this.flash(this.o.L('drawErr', { msg: String(r.body.error ?? r.status) }));
    this.updateCount(); this.schedule();
    this.lastPoll = Date.now() - POLL_MS + 800; // pick up the new revision (and others' edits) shortly
  }
  private async remove(id: number) {
    const r = await this.o.post('/api/marks/delete', { id });
    if (!r.ok) return this.flash(String(r.body.error ?? r.status));
    this.marks = this.marks.filter((m) => m.id !== id); this.undoIds = this.undoIds.filter((x) => x !== id);
    this.updateCount(); this.schedule(); this.lastPoll = 0;
  }
  private async clear(all: boolean) {
    const r = await this.o.post('/api/marks/clear', { all });
    if (!r.ok) return this.flash(String(r.body.error ?? r.status));
    this.marks = all ? [] : this.marks.filter((m) => !m.mine); this.undoIds = [];
    this.updateCount(); this.schedule(); this.lastPoll = 0;
  }

  // ------------------------------------------------------------ rendering (overlay only)
  private schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); }); }
  private box(m: Mark) { let b = this.boxes.get(m); if (!b) this.boxes.set(m, (b = markBox(m))); return b; }
  paint() {
    const t0 = performance.now();
    const map = this.map, dpr = map.dpr, cv = this.cv;
    const W = Math.max(1, Math.round(map.w * dpr)), H = Math.max(1, Math.round(map.h * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = this.c;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
    if (!this.visible) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 40 / map.scale;
    const [wx0, wy0] = map.toWorld(0, 0), [wx1, wy1] = map.toWorld(map.w, map.h);
    for (const m of this.marks) {
      const [a, b, cc, d] = this.box(m);
      if (m.kind !== 'text' && (cc < wx0 - pad || a > wx1 + pad || d < wy0 - pad || b > wy1 + pad)) continue;
      if (m.kind === 'text' && (m.pts[0] > wx1 + pad || m.pts[1] < wy0 - pad || m.pts[1] > wy1 + pad || m.pts[0] < wx0 - 400 / map.scale)) continue;
      this.drawShape(m.kind, m.pts, m.color, m.width, m.text, m.id < 0);
    }
    if (this.draft) this.drawShape(this.draft.kind, this.draft.pts, this.color, this.width, '', true);
    this.perf.push(performance.now() - t0);
    if (this.perf.length > 240) this.perf.shift();
  }
  private drawShape(kind: MarkKind, pts: number[], color: string, width: number, text: string, faint: boolean) {
    const c = this.c, map = this.map;
    c.globalAlpha = faint ? 0.6 : 1;
    if (kind === 'text') {
      const [x, y] = map.toScreen(pts[0], pts[1]);
      c.font = `600 ${12 + width}px system-ui, sans-serif`; c.textBaseline = 'middle';
      c.lineWidth = 4; c.strokeStyle = 'rgba(0,0,0,.8)'; c.lineJoin = 'round';
      c.strokeText(text, x, y); c.fillStyle = color; c.fillText(text, x, y);
      c.globalAlpha = 1; return;
    }
    const path = new Path2D();
    const s = (i: number) => map.toScreen(pts[i], pts[i + 1]);
    if (kind === 'pen') { const [x, y] = s(0); path.moveTo(x, y); for (let i = 2; i < pts.length; i += 2) { const [px, py] = s(i); path.lineTo(px, py); } }
    else {
      const [x1, y1] = s(0), [x2, y2] = s(2);
      if (kind === 'line' || kind === 'arrow') {
        path.moveTo(x1, y1); path.lineTo(x2, y2);
        if (kind === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1), hl = 8 + width * 2.4;
          path.moveTo(x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45)); path.lineTo(x2, y2); path.lineTo(x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45));
        }
      } else if (kind === 'rect') path.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else path.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2), 0, 0, Math.PI * 2);
    }
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = width + 2.5; c.stroke(path); // dark halo: readable on sea and islands
    c.strokeStyle = color; c.lineWidth = width; c.stroke(path);
    c.globalAlpha = 1;
  }

  // ------------------------------------------------------------ hit testing / hover
  /** Topmost shape under a screen point (within a few px of its outline). */
  hitAt(sx: number, sy: number): Mark | null {
    const map = this.map;
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const m = this.marks[k]; if (m.id < 0) continue;
      const tol = Math.max(6, m.width + 3);
      const p = (i: number) => map.toScreen(m.pts[i], m.pts[i + 1]);
      if (m.kind === 'text') {
        const [x, y] = p(0); this.c.font = `600 ${12 + m.width}px system-ui, sans-serif`;
        const w = this.c.measureText(m.text).width, h = 12 + m.width;
        if (sx >= x - 4 && sx <= x + w + 4 && Math.abs(sy - y) <= h / 2 + 4) return m;
        continue;
      }
      const [a, b, cc, d] = this.box(m); const [bx0, by0] = map.toScreen(a, b), [bx1, by1] = map.toScreen(cc, d);
      if (sx < bx0 - tol || sx > bx1 + tol || sy < by0 - tol || sy > by1 + tol) continue;
      let dist = Infinity;
      if (m.kind === 'pen') for (let i = 0; i + 2 < m.pts.length; i += 2) { const [x1, y1] = p(i), [x2, y2] = p(i + 2); dist = Math.min(dist, segDist(sx, sy, x1, y1, x2, y2)); }
      else {
        const [x1, y1] = p(0), [x2, y2] = p(2);
        if (m.kind === 'line' || m.kind === 'arrow') dist = segDist(sx, sy, x1, y1, x2, y2);
        else if (m.kind === 'rect') dist = Math.min(segDist(sx, sy, x1, y1, x2, y1), segDist(sx, sy, x2, y1, x2, y2), segDist(sx, sy, x2, y2, x1, y2), segDist(sx, sy, x1, y2, x1, y1));
        else { const rx = Math.max(1, Math.abs(x2 - x1) / 2), ry = Math.max(1, Math.abs(y2 - y1) / 2); const nx = (sx - (x1 + x2) / 2) / rx, ny = (sy - (y1 + y2) / 2) / ry; dist = Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry); }
      }
      if (dist <= tol) return m;
    }
    return null;
  }
  private hover(sx: number, sy: number): string | null {
    if (!this.visible || this.tool !== 'move') return null;
    const m = this.hitAt(sx, sy); if (!m) return null;
    const { L, esc } = this.o;
    return `<b>✎ ${esc(L('drawBy', { n: m.author }))}</b>${m.mine ? ` <span class="muted">(${esc(L('drawYou'))})</span>` : ''}${m.text ? `<br>${esc(m.text)}` : ''}<br><span class="muted">${esc(L('drawExpires', { t: fmtLeft(m.expiresAt - Date.now()) }))}</span>`;
  }

  // ------------------------------------------------------------ input
  setTool(t: Tool) {
    this.tool = t; this.closeText();
    this.bar.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.cv.classList.toggle('active', t !== 'move' && this.visible);
    this.cv.dataset.tool = t;
  }
  private closeText() { this.textBox?.remove(); this.textBox = null; }
  private openText(sx: number, sy: number, wx: number, wy: number) {
    this.closeText();
    const inp = document.createElement('input');
    inp.className = 'dtext'; inp.maxLength = MARK_LIMITS.text; inp.placeholder = this.o.L('textPrompt');
    inp.style.left = `${sx}px`; inp.style.top = `${sy - 14}px`; inp.style.color = this.color;
    this.cv.parentElement!.appendChild(inp); this.textBox = inp;
    setTimeout(() => inp.focus(), 0);
    const done = (save: boolean) => { const v = sanitizeText(inp.value); this.closeText(); if (save && v) void this.create('text', [wx, wy], v); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }
  private confirmTwice(btn: HTMLElement): boolean {
    if (this.armed?.btn === btn && Date.now() < this.armed.until) { this.armed = null; btn.classList.remove('armed'); return true; }
    this.armed = { btn, until: Date.now() + 3000 }; btn.classList.add('armed');
    this.flash(this.o.L('drawConfirm'));
    setTimeout(() => btn.classList.remove('armed'), 3000);
    return false;
  }
  private bind() {
    const bar = this.bar;
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!b) return;
      if (b.dataset.tool) return this.setTool(b.dataset.tool as Tool);
      if (b.dataset.color) { this.color = b.dataset.color; bar.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('on', x === b)); return; }
      if (b.dataset.width) { this.width = Number(b.dataset.width); bar.querySelectorAll('[data-width]').forEach((x) => x.classList.toggle('on', x === b)); return; }
      const act = b.dataset.act;
      if (act === 'open') { this.open = !this.open; bar.querySelector<HTMLElement>('.dtools')!.hidden = !this.open; b.classList.toggle('on', this.open); if (!this.open) this.setTool('move'); }
      else if (act === 'vis') { this.visible = !this.visible; b.classList.toggle('on', this.visible); if (!this.visible) this.setTool('move'); this.schedule(); }
      else if (act === 'undo') { const id = this.undoIds.pop(); if (id !== undefined) void this.remove(id); }
      else if (act === 'mine') { if (this.confirmTwice(b)) void this.clear(false); }
      else if (act === 'all') { if (this.canClearAll && this.confirmTwice(b)) void this.clear(true); }
    });
    bar.querySelector<HTMLSelectElement>('[data-ttl]')!.addEventListener('change', (e) => { this.ttl = (e.target as HTMLSelectElement).value as MarkTtl; });
    const cv = this.cv;
    let pid: number | null = null;
    cv.addEventListener('pointerdown', (e) => {
      if (this.tool === 'move' || pid !== null) return;
      const [wx, wy] = this.map.toWorld(e.offsetX, e.offsetY);
      if (this.tool === 'eraser') { const m = this.hitAt(e.offsetX, e.offsetY); if (m && (m.mine || this.canClearAll)) void this.remove(m.id); else if (m) this.flash(this.o.L('drawNotYours')); return; }
      if (this.tool === 'text') { this.openText(e.offsetX, e.offsetY, wx, wy); return; }
      cv.setPointerCapture(e.pointerId); pid = e.pointerId;
      this.draft = { kind: this.tool, pts: this.tool === 'pen' ? [wx, wy] : [wx, wy, wx, wy] };
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid || !this.draft) return;
      const [wx, wy] = this.map.toWorld(e.offsetX, e.offsetY);
      const d = this.draft;
      if (d.kind === 'pen') {
        const lx = d.pts[d.pts.length - 2], ly = d.pts[d.pts.length - 1];
        if (Math.hypot(wx - lx, wy - ly) * this.map.scale < 2) return;
        if (d.pts.length < 6000) d.pts.push(wx, wy);
      } else { d.pts[2] = wx; d.pts[3] = wy; }
      this.schedule();
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = null;
      const d = this.draft; this.draft = null;
      if (!d) return;
      const sc = this.map.scale;
      if (d.kind === 'pen') {
        if (d.pts.length < 4) { d.pts.push(d.pts[0] + 0.3 / sc, d.pts[1]); } // a tap = a dot
        void this.create('pen', fitPoints(d.pts, 1.2 / sc));
      } else if (Math.hypot(d.pts[2] - d.pts[0], d.pts[3] - d.pts[1]) * sc >= 5) void this.create(d.kind, d.pts);
      this.schedule();
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.map.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    window.addEventListener('keydown', this.onKey);
  }
  private onKey = (e: KeyboardEvent) => {
    if (this.textBox || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'Escape') this.setTool('move');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && this.open) { e.preventDefault(); const id = this.undoIds.pop(); if (id !== undefined) void this.remove(id); }
  };
  destroy() { window.removeEventListener('keydown', this.onKey); cancelAnimationFrame(this.raf); this.closeText(); this.map.afterPaint = null; this.map.hoverExtra = null; }
}
