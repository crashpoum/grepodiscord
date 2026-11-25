/**
 * Mobile mini live view: the next arrivals only (incoming to us / our own), big countdowns, one tap to refresh.
 * Reuses the /api/live data the full view gets; nothing extra is polled.
 */
import type { LiveCommand, LiveView } from '../../src/web/types.js';
import { HOSTILE } from '../../src/web/cmdKind.js';
import { infoOf } from './liveView.js';
import { injectSprite, loadOfficialIcons, typeIcon } from './icons.js';
import { ageText, fmtAt, fmtCd, tickCountdowns, type ScreenOpts } from './ui.js';

const MAX = 12;

export class MiniScreen {
  private data: LiveView | null = null;
  private skew = 0;
  private body: HTMLElement;
  constructor(private el: HTMLElement, private o: ScreenOpts & { onRefresh: () => void; onFull: () => void }) {
    injectSprite();
    const { L, esc } = o;
    el.innerHTML = `<div class="mini"><div class="mini-top"><b>⏱️ ${esc(L('miniTitle'))}</b><span class="muted small" id="mn-age"></span>
      <button class="btn small" id="mn-ref">🔄 ${esc(L('refreshNow'))}</button><button class="btn small ghost" id="mn-full">${esc(L('miniFull'))}</button></div><div id="mn-body"></div></div>`;
    this.body = el.querySelector('#mn-body')!;
    el.querySelector('#mn-ref')!.addEventListener('click', () => o.onRefresh());
    el.querySelector('#mn-full')!.addEventListener('click', () => o.onFull());
    void loadOfficialIcons().then((ok) => { if (ok) this.render(); });
  }
  setData(v: LiveView) { this.data = v; this.skew = (v.status?.serverNow ?? Date.now()) - Date.now(); this.render(); }
  private now() { return (Date.now() + this.skew) / 1000; }
  render() {
    const { L, esc, lang } = this.o;
    const v = this.data;
    if (!v) return;
    const nowS = this.now();
    const live = v.commands.filter((c) => !c.deleted && !c.ret && c.arrival > nowS).sort((a, b) => a.arrival - b.arrival);
    const inc = live.filter((c) => c.side === 'in' && HOSTILE.has(infoOf(c, nowS).kind)).slice(0, MAX);
    const out = live.filter((c) => c.side === 'out').slice(0, MAX);
    const row = (c: LiveCommand, incoming: boolean) => {
      const d = infoOf(c, nowS);
      const who = incoming ? c.src : c.trg;
      return `<div class="mini-row${incoming ? ' in' : ' out'}">${typeIcon(d.kind, d.kind, 26, d.icon)}
        <div class="mini-main"><b>${esc(incoming ? c.trg.town : c.trg.town)}</b><span class="muted small">${esc(incoming ? who.player : c.src.town)}${who.alliance && incoming ? ` [${esc(who.alliance)}]` : ''}</span></div>
        <div class="mini-when"><span class="sx-cd" data-end="${c.arrival}">${fmtCd(c.arrival - nowS)}</span><span class="muted small">${esc(fmtAt(c.arrival, lang, undefined, nowS))}</span></div></div>`;
    };
    const sec = (title: string, list: LiveCommand[], incoming: boolean) => `<section class="mini-sec"><h3>${esc(title)} <span class="sx-count">${list.length}</span></h3>${list.length ? list.map((c) => row(c, incoming)).join('') : `<div class="muted small sx-none">${esc(L('miniNone'))}</div>`}</section>`;
    this.body.innerHTML = sec(L('miniIncoming'), inc, true) + sec(L('miniOutgoing'), out, false);
    const age = this.el.querySelector('#mn-age')!;
    age.textContent = v.updatedAt ? L('updatedAgo', { t: ageText(Date.now() + this.skew - v.updatedAt, L) }) : '';
    tickCountdowns(this.body, nowS);
  }
  tick() {
    if (!this.data) return;
    tickCountdowns(this.body, this.now());
    const v = this.data;
    if (v.updatedAt) this.el.querySelector('#mn-age')!.textContent = this.o.L('updatedAgo', { t: ageText(Date.now() + this.skew - v.updatedAt, this.o.L) });
  }
  destroy() { this.el.innerHTML = ''; }
}
