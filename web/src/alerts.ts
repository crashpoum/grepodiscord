/**
 * Alerts tab: incoming commands members chose to share from their own game view, grouped per player
 * (target town, attacker, landing time + countdown, the client's prediction). Rendering only on data/filter change;
 * the 1 s timer just updates countdowns.
 */
import type { IncomingCmd, IncomingType } from '../../src/web/syncFeeds.js';
import { injectSprite, loadOfficialIcons } from './icons.js';
import { STALE_MS, ageText, fmtAt, predHtml, tickCountdowns, typeChip, fmtCd, type FeedView, type ScreenOpts } from './ui.js';

const HOSTILE: IncomingType[] = ['attack', 'conquest', 'revolt', 'spy'];

export class AlertsScreen {
  private data: FeedView<IncomingCmd> | null = null;
  private skew = 0;
  private type: 'all' | 'hostile' | IncomingType = 'all';
  private q = '';
  private list: HTMLElement;
  constructor(private el: HTMLElement, private o: ScreenOpts) {
    injectSprite();
    const { L, esc } = o;
    el.innerHTML = `<div class="sx"><div class="sx-head"><div><h2>🚨 ${esc(L('alertsTitle'))}</h2><p class="muted small">${esc(L('alertsHint'))}</p></div>
      <div class="sx-tools"><select id="ax-type"><option value="all">${esc(L('alertsFilterAll'))}</option><option value="hostile">${esc(L('alertsFilterHostile'))}</option>
      ${(['attack', 'conquest', 'revolt', 'spy', 'support'] as IncomingType[]).map((t) => `<option value="${t}">${esc(L(`type${t[0].toUpperCase()}${t.slice(1)}` as 'typeAttack'))}</option>`).join('')}</select>
      <input id="ax-q" type="search" placeholder="${esc(L('alertsSearch'))}"></div></div><div class="sx-list" id="ax-list"></div></div>`;
    this.list = el.querySelector('#ax-list')!;
    el.querySelector<HTMLSelectElement>('#ax-type')!.addEventListener('change', (e) => { this.type = (e.target as HTMLSelectElement).value as typeof this.type; this.render(); });
    el.querySelector<HTMLInputElement>('#ax-q')!.addEventListener('input', (e) => { this.q = (e.target as HTMLInputElement).value.trim().toLowerCase(); this.render(); });
    void loadOfficialIcons().then((ok) => { if (ok) this.render(); });
  }
  setData(d: FeedView<IncomingCmd>) { this.data = d; this.skew = d.serverNow - Date.now(); this.render(); }
  private now() { return (Date.now() + this.skew) / 1000; }
  private keep(c: IncomingCmd, nowS: number) {
    if (c.arrival < nowS - 5) return false;
    if (this.type === 'hostile' ? !HOSTILE.includes(c.type) : this.type !== 'all' && c.type !== this.type) return false;
    if (!this.q) return true;
    return [c.town_n, c.from_player, c.from_alliance, c.from_town_n].some((s) => s && s.toLowerCase().includes(this.q));
  }
  render() {
    const { L, esc, lang, units } = this.o;
    const d = this.data;
    if (!d) return;
    if (!d.players.length) { this.list.innerHTML = `<div class="sx-empty">${esc(L('alertsEmpty'))}</div>`; return; }
    const nowS = this.now();
    const blocks = d.players.map((p) => ({ p, cmds: p.items.filter((c) => this.keep(c, nowS)).sort((a, b) => a.arrival - b.arrival) }))
      .sort((a, b) => (a.cmds[0]?.arrival ?? Infinity) - (b.cmds[0]?.arrival ?? Infinity));
    this.list.innerHTML = blocks.map(({ p, cmds }) => {
      const age = d.serverNow - p.recvAt, stale = age > STALE_MS;
      const head = `<div class="sx-ph"><b>${esc(p.playerName)}</b>${p.mine ? ` <span class="sx-you">${esc(L('youBadge'))}</span>` : ''}
        <span class="sx-badge ${stale ? 'stale' : 'ok'}">${esc(stale ? L('stale') : L('online'))}</span><span class="muted small">${esc(L('updatedAgo', { t: ageText(age, L) }))}</span>
        <span class="sx-count">${esc(L('alertsCount', { n: cmds.length }))}</span></div>`;
      if (!cmds.length) return `<section class="sx-pl${stale ? ' is-stale' : ''}">${head}<div class="muted small sx-none">${esc(L('alertsNone'))}</div></section>`;
      return `<section class="sx-pl${stale ? ' is-stale' : ''}">${head}<div class="sx-rows">${cmds.map((c) => `<div class="sx-row t-${c.type}">
        ${typeChip(c.type, L, esc)}
        <div class="sx-main"><div class="sx-line"><span class="muted small">${esc(L('alertsTarget'))}</span> <b>${esc(c.town_n)}</b></div>
          <div class="sx-line"><span class="muted small">${esc(L('alertsFrom'))}</span> ${c.from_player ? `<b>${esc(c.from_player)}</b>` : `<i class="muted">${esc(L('alertsUnknown'))}</i>`}${c.from_alliance ? ` <span class="sx-al">[${esc(c.from_alliance)}]</span>` : ''}${c.from_town_n ? ` <span class="muted">· ${esc(c.from_town_n)}</span>` : ''}</div>
          ${predHtml(c.pred, units, L, esc)}</div>
        <div class="sx-when"><span class="sx-cd" data-end="${c.arrival}">${fmtCd(c.arrival - nowS)}</span><span class="muted small">${esc(L('alertsLands'))} ${esc(fmtAt(c.arrival, lang, undefined, nowS))}</span></div>
      </div>`).join('')}</div></section>`;
    }).join('');
    tickCountdowns(this.list, nowS);
  }
  tick() { if (this.data) tickCountdowns(this.list, this.now()); }
  destroy() { this.el.innerHTML = ''; }
}
