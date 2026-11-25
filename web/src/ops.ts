/**
 * Ops tab: what members planned in their own client. Three columns per status (Scheduled / Sent / Failed),
 * filterable per player, times in the guild's planner timezone. Display only: the server never sends anything.
 */
import { groupOps, opClashes, type OpStatus, type SyncOp } from '../../src/web/syncFeeds.js';
import { injectSprite, loadOfficialIcons } from './icons.js';
import { STALE_MS, ageText, fmtAt, fmtCd, tickCountdowns, unitsAny, type FeedView, type ScreenOpts } from './ui.js';

type Op = SyncOp & { player: string; mine: boolean };

export class OpsScreen {
  private data: FeedView<SyncOp> | null = null;
  private skew = 0;
  private player = '';
  private body: HTMLElement;
  constructor(private el: HTMLElement, private o: ScreenOpts) {
    injectSprite();
    el.innerHTML = `<div class="sx"><div class="sx-head"><div><h2>🎯 ${o.esc(o.L('opsTitle'))}</h2><p class="muted small">${o.esc(o.L('opsHint'))}</p><p class="muted small" id="op-tz"></p></div>
      <div class="sx-tools"><select id="op-player"></select></div></div><div id="op-body"></div></div>`;
    this.body = el.querySelector('#op-body')!;
    el.querySelector<HTMLSelectElement>('#op-player')!.addEventListener('change', (e) => { this.player = (e.target as HTMLSelectElement).value; this.render(); });
    void loadOfficialIcons().then((ok) => { if (ok) this.render(); });
  }
  setData(d: FeedView<SyncOp>) { this.data = d; this.skew = d.serverNow - Date.now(); this.render(); }
  private now() { return (Date.now() + this.skew) / 1000; }
  render() {
    const { L, esc, lang, units } = this.o;
    const d = this.data;
    if (!d) return;
    const tz = d.planner?.timezone;
    this.el.querySelector('#op-tz')!.textContent = d.planner ? L('opsWindow', { n: d.planner.windowMin, tz: d.planner.timezone }) : '';
    const sel = this.el.querySelector<HTMLSelectElement>('#op-player')!;
    const opts = `<option value="">${esc(L('opsAllPlayers'))}</option>` + d.players.map((p) => `<option value="${p.playerId}"${String(p.playerId) === this.player ? ' selected' : ''}>${esc(p.playerName)} (${p.items.length})${d.serverNow - p.recvAt > STALE_MS ? ' · ' + esc(L('stale')) : ''}</option>`).join('');
    if (sel.innerHTML !== opts) sel.innerHTML = opts;
    if (!d.players.length) { this.body.innerHTML = `<div class="sx-empty">${esc(L('opsEmpty'))}</div>`; return; }
    const all: Op[] = d.players.filter((p) => !this.player || String(p.playerId) === this.player).flatMap((p) => p.items.map((x) => ({ ...x, player: p.playerName, mine: p.mine })));
    const g = groupOps(all) as Record<OpStatus, Op[]>;
    const clashes = opClashes(all);
    const clashIds = new Set(clashes.flat());
    const nowS = this.now();
    const at = (s: number) => esc(fmtAt(s, lang, tz, nowS));
    const row = (x: Op) => {
      let when = '';
      if (x.status === 'scheduled') when = `<span class="sx-cd" data-end="${x.send_at}">${fmtCd(x.send_at - nowS)}</span><span class="muted small">${esc(L('opsSendAt'))} ${at(x.send_at)}</span>${x.arrive_at ? `<span class="muted small">${esc(L('opsArrives'))} ${at(x.arrive_at)}</span>` : ''}`;
      else if (x.status === 'sent') {
        const late = x.arrival && x.arrive_at ? x.arrival - x.arrive_at : 0;
        when = `<span class="small">${esc(L('opsSentAt'))} <b>${at(x.sent_at ?? x.send_at)}</b></span>${x.arrival ? `<span class="small">${esc(L('opsArrival'))} <b>${at(x.arrival)}</b></span>` : ''}${x.arrive_at ? `<span class="muted small">${esc(L('opsPlanned'))} ${at(x.arrive_at)}${late > 0 ? ` · <span class="sx-late">${esc(L('opsLate', { s: fmtCd(late) }))}</span>` : ''}</span>` : ''}`;
      } else when = `<span class="muted small">${esc(L('opsSendAt'))} ${at(x.send_at)}</span><span class="sx-reason">${esc(x.reason || '—')}</span>`;
      return `<div class="sx-op k-${x.kind}${clashIds.has(x.id) ? ' clash' : ''}">
        <div class="sx-op-top"><span class="sx-type t-${x.kind === 'support' ? 'support' : 'attack'}">${x.kind === 'support' ? '🛡️' : '⚔️'} <b>${esc(L(x.kind === 'support' ? 'opsSupport' : 'opsAttack'))}</b></span><span class="sx-opp">${esc(x.player)}</span></div>
        <div class="sx-line"><b>${esc(x.from_town_n)}</b> → <b>${esc(x.target_town_n)}</b>${x.target_player ? ` <span class="muted">(${esc(x.target_player)})</span>` : ''}</div>
        ${x.units ? `<div class="sx-line">${unitsAny(x.units, units, esc, 18)}</div>` : ''}
        <div class="sx-when2">${when}</div></div>`;
    };
    const col = (s: OpStatus, k: 'opsScheduled' | 'opsSent' | 'opsFailed') => `<section class="sx-col s-${s}"><h3>${esc(L(k))} <span class="sx-count">${g[s].length}</span></h3>${g[s].length ? g[s].map(row).join('') : `<div class="muted small sx-none">${esc(L('opsNone'))}</div>`}</section>`;
    const warn = clashes.map(([a]) => { const x = all.find((o) => o.id === a)!; return `<div class="sx-warn">⚠️ ${esc(L('opsClash', { town: x.target_town_n }))}</div>`; }).join('');
    const ages = d.players.filter((p) => !this.player || String(p.playerId) === this.player).map((p) => `<span class="sx-chip${d.serverNow - p.recvAt > STALE_MS ? ' stale' : ''}">${esc(p.playerName)} · ${esc(ageText(d.serverNow - p.recvAt, L))}</span>`).join('');
    this.body.innerHTML = `${warn}<div class="sx-ages">${ages}</div><div class="sx-cols">${col('scheduled', 'opsScheduled')}${col('sent', 'opsSent')}${col('failed', 'opsFailed')}</div>`;
    tickCountdowns(this.body, nowS);
  }
  tick() { if (this.data) tickCountdowns(this.body, this.now()); }
  destroy() { this.el.innerHTML = ''; }
}
