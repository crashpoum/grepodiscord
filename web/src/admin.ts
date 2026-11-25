/**
 * /admin: the private admin panel. Every action goes to POST /api/admin/action and is checked server-side
 * (admin or owner, per action) and written to the audit log; this file only renders and collects input.
 */
import type { AdminSettings, TabId, Who } from '../../src/admin/settings.js';
import type { IncomingType } from '../../src/web/syncFeeds.js';
import { ageText, fmtAt, type ScreenOpts } from './ui.js';

type Post = (path: string, body: unknown) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;
interface Named { id: number; name: string }
interface Health { state: string; lastPollAt: number | null; lastOkAt: number | null; nextPollAt: number | null; intervalSec: number; allTeams: { key: string; name: string; commands: number }[]; error: string | null; failures: number; watched: string | null; budgetUsed: number }
export interface AdminState {
  me: { userId: string; owner: boolean; admin: boolean }; ownerConfigured: boolean; guild: { id: string; lang: 'en' | 'el'; world: string | null }; settings: AdminSettings;
  admins: { userId: string; name: string | null; addedBy: string; addedAt: number }[]; owners: { userId: string; name: string | null }[];
  grants: { id: number; kind: 'user' | 'role'; targetId: string; scope: TabId; expiresAt: number | null; active: boolean; name: string | null }[];
  channels: { id: string; name: string }[]; roles: { id: string; name: string; color: string }[];
  claims: { userId: string; userName: string | null; playerId: number; player: string | null; createdAt: number; source: string }[];
  links: { userId: string; name: string | null; playerId: number; player: string | null; at: number }[];
  suggestions: { userId: string; member: string; playerId: number; player: string }[]; membersListed: boolean;
  sides: { own: Named[]; pacts: Named[]; enemies: Named[] }; alliances: (Named & { points: number })[];
  sync: { userId: string; name: string | null; playerId: number | null; player: string | null; createdAt: number; last: Record<string, number> }[];
  live: Health | null; audit: { id: number; userId: string; userName: string | null; action: string; detail: string; at: number }[];
  announcements: { id: number; channelId: string; text: string; postAt: number; status: string; error: string | null }[];
  guests: { id: string; label: string; createdAt: number; expiresAt: number; revoked: boolean }[];
  status: { uptimeSec: number; worldRefreshedAt: number | null; errors: { at: number; msg: string }[]; discord: boolean; publicUrl: string | null; serverNow: number };
}

const SECTIONS = ['Status', 'Alerts', 'Access', 'Linking', 'Sides', 'Live', 'Drawing', 'Sync', 'Trackers', 'Lang', 'Announce', 'Guests', 'Planner', 'Backup', 'Admins', 'Audit'] as const;
const ICON: Record<(typeof SECTIONS)[number], string> = { Status: '🩺', Alerts: '🚨', Access: '👁️', Linking: '🔗', Sides: '🤝', Live: '📡', Drawing: '✏️', Sync: '🔄', Trackers: '📌', Lang: '🌐', Announce: '📣', Guests: '🎟️', Planner: '🎯', Backup: '💾', Admins: '🛡️', Audit: '📜' };
const ALERT_TYPES: IncomingType[] = ['attack', 'conquest', 'revolt', 'spy', 'support', 'other'];

/** Uptime as "3d 4h" / "4h 12m" / "12m" (no words, same in both languages). */
export function upText(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export class AdminScreen {
  private st: AdminState | null = null;
  private msg = '';
  private guestUrl = '';
  private armed = '';
  constructor(private el: HTMLElement, private o: ScreenOpts & { get: <T>(p: string) => Promise<T>; post: Post }) {
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
    void this.load();
  }
  destroy() { this.el.innerHTML = ''; }
  tick() { /* static page */ }

  async load() {
    try { this.st = await this.o.get<AdminState>('/api/admin/state'); this.render(); }
    catch (e) { this.el.innerHTML = `<div class="err">${this.o.esc(e instanceof Error ? e.message : String(e))}</div>`; }
  }
  /** Run one admin action, show the result, reload the state (the server is the only source of truth). */
  private async act(action: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    const { L } = this.o;
    const r = await this.o.post('/api/admin/action', { action, ...body }).catch((e: Error) => ({ ok: false, status: 0, body: { error: e.message } as Record<string, unknown> }));
    const err = String(r.body.error ?? '');
    this.msg = r.ok ? `✅ ${L('admSaved')}` : `⚠️ ${L('admFailed', { e: err === 'ownerOnly' ? L('admOwnerOnly') : err || `HTTP ${r.status}` })}`;
    const sc = this.el.querySelector('.adm-body')?.scrollTop ?? 0;
    await this.load();
    const b = this.el.querySelector('.adm-body'); if (b) b.scrollTop = sc;
    return r.ok ? r.body : null;
  }
  private saveSettings(part: Partial<AdminSettings>) { return this.act('settings.save', { settings: part }); }

  private val(id: string): string { return (this.el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`)?.value ?? '').trim(); }
  private checked(sel: string): string[] { return [...this.el.querySelectorAll<HTMLInputElement>(`${sel}:checked`)].map((i) => i.value); }

  private async onClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!t) return;
    e.preventDefault();
    const a = t.dataset.a!, d = t.dataset;
    // Destructive buttons need a second click.
    if (t.classList.contains('danger') && this.armed !== a + (d.id ?? d.user ?? '')) { this.armed = a + (d.id ?? d.user ?? ''); t.textContent = this.o.L('admConfirm'); return; }
    this.armed = '';
    const s = this.st!;
    switch (a) {
      case 'nav': this.el.querySelector(`#adm-${d.sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
      case 'reload': this.msg = ''; return void this.load();
      case 'restart': return void this.act('live.restart');
      case 'saveAlerts': return void this.saveSettings({ alerts: { channelId: this.val('al-ch') || null, roleId: this.val('al-role') || null, minSize: Number(this.val('al-min')) || 0, types: this.checked('.al-type') as IncomingType[] } });
      case 'saveAccess': {
        const vis = {} as AdminSettings['visibility'];
        for (const tab of ['troops', 'alerts', 'ops'] as TabId[]) vis[tab] = { who: this.val(`vis-${tab}`) as Who, roles: this.checked(`.vis-r-${tab}`) };
        return void this.saveSettings({ visibility: vis });
      }
      case 'grantAdd': {
        const kind = this.val('gr-kind'), target = kind === 'role' ? this.val('gr-role') : this.val('gr-user');
        const preset = this.val('gr-preset'), until = preset === 'custom' ? Date.parse(this.val('gr-until')) : undefined;
        return void this.act('grants.add', { kind, targetId: target, scope: this.val('gr-scope'), preset, until });
      }
      case 'grantDel': return void this.act('grants.remove', { id: Number(d.id) });
      case 'saveLinking': return void this.saveSettings({ linking: { adminChannelId: this.val('ln-ch') || null, unconfirmed: this.val('ln-unc') as 'full' | 'basic', allowAnyAlliance: this.checked('#ln-any').length > 0 } });
      case 'claimOk': return void this.act('claims.approve', { userId: d.user });
      case 'claimNo': return void this.act('claims.reject', { userId: d.user });
      case 'bulk': {
        const items = this.checked('.sg').map((x) => { const [userId, playerId] = x.split(':'); return { userId, playerId: Number(playerId) }; });
        if (items.length) return void this.act('claims.bulk', { items });
        return;
      }
      case 'assign': return void this.act('claims.assign', { userId: this.val('as-user'), player: this.val('as-player') });
      case 'unlink': return void this.act('links.remove', { userId: d.user });
      case 'side': return void this.act('sides.set', { allianceId: d.id ?? this.val('sd-al'), side: d.side });
      case 'saveColors': return void this.saveSettings({ colors: { own: this.colorVal('own'), ally: this.colorVal('ally'), enemy: this.colorVal('enemy') } });
      case 'saveLive': return void this.saveSettings({ live: { pollSeconds: this.val('lv-sec') ? Number(this.val('lv-sec')) : null, teams: this.checked('.lv-team') } });
      case 'saveDrawing': return void this.saveSettings({ drawing: { who: this.val('dr-who') as Who, roles: this.checked('.dr-r'), defaultHours: Number(this.val('dr-exp')) } });
      case 'clearMarks': return void this.act('marks.clear');
      case 'saveSync': return void this.saveSettings({ sync: { requireLink: this.checked('#sy-req').length > 0 } });
      case 'revokeData': return void this.act('sync.revokeData', { userId: d.user });
      case 'revokeKey': return void this.act('sync.revokeKey', { userId: d.user });
      case 'saveTrackers': return void this.saveSettings({ trackers: {
        board: { on: this.checked('#tr-board-on').length > 0, channelId: this.val('tr-board-ch') || null },
        conquests: { on: this.checked('#tr-conq-on').length > 0, channelId: this.val('tr-conq-ch') || null },
        ghosts: { on: this.checked('#tr-gh-on').length > 0, channelId: this.val('tr-gh-ch') || null, radius: Number(this.val('tr-gh-r')) || 15 } } });
      case 'lang': return void this.act('lang.set', { lang: d.lang });
      case 'announce': {
        const at = this.val('an-at');
        return void this.act('announce.post', { channelId: this.val('an-ch'), text: this.val('an-text'), at: at ? Date.parse(at) : undefined });
      }
      case 'annCancel': return void this.act('announce.cancel', { id: Number(d.id) });
      case 'guest': {
        const r = await this.act('guest.create', { label: this.val('gu-label'), hours: Number(this.val('gu-hours')) });
        if (r?.url) { this.guestUrl = String(r.url); this.render(); }
        return;
      }
      case 'guestDel': return void this.act('guest.revoke', { id: d.id });
      case 'savePlanner': return void this.saveSettings({ planner: { windowMin: Number(this.val('pl-win')) || 5, timezone: this.val('pl-tz') || 'Europe/Athens' } });
      case 'backup': return void this.download();
      case 'adminAdd': return void this.act('admins.add', { userId: this.val('ad-user') });
      case 'adminDel': return void this.act('admins.remove', { userId: d.user });
    }
    void s;
  }
  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'rs-file' && t.files?.[0]) {
      void t.files[0].text().then(async (txt) => {
        let data: unknown; try { data = JSON.parse(txt); } catch { this.msg = `⚠️ ${this.o.L('admFailed', { e: 'JSON' })}`; return this.render(); }
        const r = await this.act('backup.restore', { data });
        if (r) { this.msg = `✅ ${this.o.L('admRestoreDone', { n: Number(r.rows ?? 0) })}`; this.render(); }
      });
    }
    if (t.id === 'gr-kind' || t.id === 'gr-preset') this.render(true);
  }
  private colorVal(k: string): string | null { return this.checked(`#co-${k}-def`).length ? null : this.val(`co-${k}`) || null; }
  private async download() {
    const r = await this.o.get<Record<string, unknown>>('/api/admin/backup').catch((e: Error) => { this.msg = `⚠️ ${e.message}`; this.render(); return null; });
    if (!r) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 1)], { type: 'application/json' }));
    a.download = `grepocord-backup-${this.st?.guild.id ?? 'guild'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ------------------------------------------------------------ render
  private render(keepInputs = false) {
    const s = this.st; if (!s) return;
    const { L, esc } = this.o;
    // Re-rendering for a select change keeps what was typed.
    const typed = keepInputs ? new Map([...this.el.querySelectorAll<HTMLInputElement>('input[id],select[id],textarea[id]')].map((i) => [i.id, i.type === 'checkbox' ? String(i.checked) : i.value])) : null;
    const sc = this.el.querySelector('.adm-body')?.scrollTop ?? 0;
    const label = (sec: string) => L(`admSec${sec}` as 'admSecStatus');
    this.el.innerHTML = `<div class="adm"><nav class="adm-nav">${SECTIONS.map((x) => `<a href="#" data-a="nav" data-sec="${x}">${ICON[x]} <span>${esc(label(x))}</span></a>`).join('')}</nav>
      <div class="adm-body"><div class="adm-top"><h2>⚙️ ${esc(L('admTitle'))}</h2><span class="adm-msg">${esc(this.msg)}</span><button class="btn small ghost" data-a="reload">${esc(L('admReload'))}</button></div>
      ${s.ownerConfigured ? '' : `<div class="sx-warn">${esc(L('admNoOwner'))}</div>`}
      ${SECTIONS.map((x) => `<section class="adm-sec" id="adm-${x}"><h3>${ICON[x]} ${esc(label(x))}</h3>${this.sec(x, s)}</section>`).join('')}</div></div>`;
    if (typed) for (const [id, v] of typed) { const i = this.el.querySelector<HTMLInputElement>(`#${id}`); if (!i) continue; if (i.type === 'checkbox') i.checked = v === 'true'; else if (i.type !== 'file') i.value = v; }
    if (typed) { const g = this.el.querySelector('#gr-ublock'), r = this.el.querySelector('#gr-rblock'), c = this.el.querySelector('#gr-cblock'); const k = this.val('gr-kind'); g?.classList.toggle('hide', k === 'role'); r?.classList.toggle('hide', k !== 'role'); c?.classList.toggle('hide', this.val('gr-preset') !== 'custom'); }
    const b = this.el.querySelector('.adm-body'); if (b) b.scrollTop = sc;
  }

  private sec(x: (typeof SECTIONS)[number], s: AdminState): string {
    const { L, esc, lang } = this.o;
    const now = s.status.serverNow;
    const when = (ms: number | null) => (ms ? esc(fmtAt(ms / 1000, lang, undefined, now / 1000)) : esc(L('agoNever')));
    const ago = (ms: number | null) => (ms ? esc(L('updatedAgo', { t: ageText(now - ms, L) })) : esc(L('agoNever')));
    const chSel = (id: string, cur: string | null) => `<select id="${id}"><option value="">${esc(L('admChannelNone'))}</option>${s.channels.map((c) => `<option value="${c.id}"${c.id === cur ? ' selected' : ''}>#${esc(c.name)}</option>`).join('')}</select>`;
    const roleChecks = (cls: string, cur: string[]) => s.roles.length ? `<div class="adm-checks">${s.roles.map((r) => `<label class="chk"><input type="checkbox" class="${cls}" value="${r.id}"${cur.includes(r.id) ? ' checked' : ''}><span style="color:${esc(r.color)}">@${esc(r.name)}</span></label>`).join('')}</div>` : `<span class="muted small">${esc(L('admNone'))}</span>`;
    const whoSel = (id: string, cur: Who, adminsLabel: 'admWhoAdmins' = 'admWhoAdmins') => `<select id="${id}">${(['all', 'roles', 'admins'] as Who[]).map((w) => `<option value="${w}"${w === cur ? ' selected' : ''}>${esc(L(w === 'all' ? 'admWhoAll' : w === 'roles' ? 'admWhoRoles' : adminsLabel))}</option>`).join('')}</select>`;
    const save = (a: string) => `<div class="adm-act"><button class="btn small" data-a="${a}">${esc(L('admSave'))}</button></div>`;
    const userName = (u: string, n: string | null) => `${n ? `<b>${esc(n)}</b> ` : ''}<span class="muted small mono">${esc(u)}</span>`;
    const st = s.settings;
    switch (x) {
      case 'Status': {
        const h = s.live;
        return `<div class="adm-grid">
          <div><span class="muted small">${esc(L('admUptime'))}</span><b>${esc(upText(s.status.uptimeSec))}</b></div>
          <div><span class="muted small">${esc(L('admWorldRefresh'))}</span><b>${ago(s.status.worldRefreshedAt)}</b></div>
          <div><span class="muted small">${esc(L('admLiveState'))}</span><b class="st-${esc(h?.state ?? 'idle')}">${esc(h?.state ?? 'idle')}${h?.error ? ` · ${esc(h.error)}` : ''}</b></div>
          <div><span class="muted small">${esc(L('admLastOk'))}</span><b>${ago(h?.lastOkAt ?? null)}</b></div>
          <div><span class="muted small">${esc(L('admNextPoll'))}</span><b>${when(h?.nextPollAt ?? null)} · ${h?.intervalSec ?? '-'}s</b></div>
          <div><span class="muted small">${esc(L('admBudget'))}</span><b>${h?.budgetUsed ?? 0}</b></div></div>
          ${s.status.discord ? '' : `<div class="sx-warn">${esc(L('admDiscordOff'))}</div>`}
          <div class="adm-act"><button class="btn small" data-a="restart">🔁 ${esc(L('admRestartPoll'))}</button></div>
          <details${s.status.errors.length ? '' : ' disabled'}><summary>${esc(L('admRecentErrors'))} (${s.status.errors.length})</summary><ul class="adm-log">${s.status.errors.map((e) => `<li><span class="muted small">${when(e.at)}</span> ${esc(e.msg)}</li>`).join('')}</ul></details>`;
      }
      case 'Alerts': return `<div class="adm-form"><label>${esc(L('admAlertsChannel'))}${chSel('al-ch', st.alerts.channelId)}</label>
        <label>${esc(L('admAlertsRole'))}<select id="al-role"><option value="">${esc(L('admRoleNone'))}</option>${s.roles.map((r) => `<option value="${r.id}"${r.id === st.alerts.roleId ? ' selected' : ''}>@${esc(r.name)}</option>`).join('')}</select></label>
        <label>${esc(L('admAlertsMin'))}<input id="al-min" type="number" min="0" step="10" value="${st.alerts.minSize}"></label>
        <div><span class="lbl">${esc(L('admAlertsTypes'))}</span><div class="adm-checks">${ALERT_TYPES.map((t) => `<label class="chk"><input type="checkbox" class="al-type" value="${t}"${st.alerts.types.includes(t) ? ' checked' : ''}>${esc(L(`type${t[0].toUpperCase()}${t.slice(1)}` as 'typeAttack'))}</label>`).join('')}</div></div></div>${save('saveAlerts')}`;
      case 'Access': {
        const vis = (['troops', 'alerts', 'ops'] as TabId[]).map((tab) => `<div class="adm-vis"><b>${esc(L(tab === 'troops' ? 'admVisTroops' : tab === 'alerts' ? 'admVisAlerts' : 'admVisOps'))}</b>${whoSel(`vis-${tab}`, st.visibility[tab].who)}${roleChecks(`vis-r-${tab}`, st.visibility[tab].roles)}</div>`).join('');
        const grants = s.grants.length ? `<table class="adm-t"><tbody>${s.grants.map((g) => `<tr class="${g.active ? '' : 'off'}"><td>${g.kind === 'role' ? '@' : '👤'} ${g.name ? esc(g.name) : `<span class="mono">${esc(g.targetId)}</span>`}</td><td>${esc(L(g.scope === 'troops' ? 'tabTroops' : g.scope === 'alerts' ? 'tabAlerts' : 'tabOps'))}</td>
          <td>${g.expiresAt === null ? esc(L('admGrantForever')) : g.active ? esc(L('admGrantUntil', { t: fmtAt(g.expiresAt / 1000, lang, undefined, now / 1000) })) : esc(L('admGrantExpired'))}</td><td><button class="btn small ghost" data-a="grantDel" data-id="${g.id}">${esc(L('admRevoke'))}</button></td></tr>`).join('')}</tbody></table>` : `<p class="muted small">${esc(L('admNone'))}</p>`;
        return `${vis}${save('saveAccess')}<h4>${esc(L('admGrants'))}</h4><p class="muted small">${esc(L('admGrantHint'))}</p>${grants}
          <div class="adm-inline"><select id="gr-kind"><option value="user">${esc(L('admGrantKindUser'))}</option><option value="role">${esc(L('admGrantKindRole'))}</option></select>
          <span id="gr-ublock"><input id="gr-user" placeholder="${esc(L('admUserId'))}" list="adm-members"></span>
          <span id="gr-rblock" class="hide"><select id="gr-role">${s.roles.map((r) => `<option value="${r.id}">@${esc(r.name)}</option>`).join('')}</select></span>
          <select id="gr-scope"><option value="ops">${esc(L('tabOps'))}</option><option value="alerts">${esc(L('tabAlerts'))}</option><option value="troops">${esc(L('tabTroops'))}</option></select>
          <select id="gr-preset"><option value="1d">${esc(L('admGrant1d'))}</option><option value="1h">${esc(L('admGrant1h'))}</option><option value="1w">${esc(L('admGrant1w'))}</option><option value="perm">${esc(L('admGrantPerm'))}</option><option value="custom">${esc(L('admGrantCustom'))}</option></select>
          <span id="gr-cblock" class="hide"><input id="gr-until" type="datetime-local"></span><button class="btn small" data-a="grantAdd">${esc(L('admAdd'))}</button></div>
          <datalist id="adm-members">${[...s.links.map((l) => [l.userId, l.name ?? l.player ?? '']), ...s.suggestions.map((m) => [m.userId, m.member])].map(([u, n]) => `<option value="${esc(u)}">${esc(n)}</option>`).join('')}</datalist>`;
      }
      case 'Linking': {
        const claims = s.claims.length ? s.claims.map((c) => `<div class="adm-claim">👤 ${userName(c.userId, c.userName)} → <b>${esc(c.player ?? `#${c.playerId}`)}</b> <span class="muted small">${when(c.createdAt)}</span>
          <button class="btn small" data-a="claimOk" data-user="${c.userId}">✅ ${esc(L('admApprove'))}</button><button class="btn small ghost" data-a="claimNo" data-user="${c.userId}">✖ ${esc(L('admReject'))}</button></div>`).join('') : `<p class="muted small">${esc(L('admNone'))}</p>`;
        const sugg = s.suggestions.length ? `<div class="adm-sugg">${s.suggestions.map((m) => `<label class="chk"><input type="checkbox" class="sg" value="${m.userId}:${m.playerId}" checked>${esc(m.member)} → <b>${esc(m.player)}</b></label>`).join('')}</div><div class="adm-act"><button class="btn small" data-a="bulk">${esc(L('admConfirmSel'))}</button></div>` : `<p class="muted small">${esc(L('admNone'))}</p>`;
        const links = s.links.length ? `<table class="adm-t"><tbody>${s.links.map((l) => `<tr><td>${userName(l.userId, l.name)}</td><td><b>${esc(l.player ?? `#${l.playerId}`)}</b></td><td class="muted small">${when(l.at)}</td><td><button class="btn small ghost danger" data-a="unlink" data-user="${l.userId}">${esc(L('admUnlink'))}</button></td></tr>`).join('')}</tbody></table>` : `<p class="muted small">${esc(L('admNone'))}</p>`;
        return `<div class="adm-form"><label>${esc(L('admLinkChannel'))}${chSel('ln-ch', st.linking.adminChannelId)}</label>
          <label>${esc(L('admUnconfirmed'))}<select id="ln-unc"><option value="full"${st.linking.unconfirmed === 'full' ? ' selected' : ''}>${esc(L('admUnconfFull'))}</option><option value="basic"${st.linking.unconfirmed === 'basic' ? ' selected' : ''}>${esc(L('admUnconfBasic'))}</option></select></label>
          <label class="chk"><input type="checkbox" id="ln-any"${st.linking.allowAnyAlliance ? ' checked' : ''}>${esc(L('admAnyAlliance'))}</label></div>${save('saveLinking')}
          <h4>${esc(L('admClaims'))} (${s.claims.length})</h4>${claims}
          <h4>${esc(L('admSuggest'))}</h4><p class="muted small">${esc(L('admSuggestHint'))}${s.membersListed ? '' : ' ' + esc(L('admSuggestSeen'))}</p>${sugg}
          <h4>${esc(L('admAssign'))}</h4><div class="adm-inline"><input id="as-user" placeholder="${esc(L('admUserId'))}" list="adm-members"><input id="as-player" placeholder="${esc(L('admPlayerId'))}"><button class="btn small" data-a="assign">${esc(L('admAdd'))}</button></div>
          <h4>${esc(L('admLinked'))} (${s.links.length})</h4>${links}`;
      }
      case 'Sides': {
        const list = (k: 'own' | 'pacts' | 'enemies', label: 'admOwn' | 'admPacts' | 'admEnemies') => `<div class="adm-side s-${k}"><b>${esc(L(label))}</b>${s.sides[k].length ? s.sides[k].map((a) => `<span class="sx-chip">${esc(a.name)} <a href="#" data-a="side" data-side="none" data-id="${a.id}" title="${esc(L('admSetNone'))}">✕</a></span>`).join('') : `<span class="muted small">${esc(L('admNone'))}</span>`}</div>`;
        const co = (k: 'own' | 'ally' | 'enemy', label: 'admColorOwn' | 'admColorAlly' | 'admColorEnemy', def: string) => `<label class="adm-color">${esc(L(label))}<input type="color" id="co-${k}" value="${st.colors[k] ?? def}"><label class="chk small"><input type="checkbox" id="co-${k}-def"${st.colors[k] ? '' : ' checked'}>${esc(L('admColorDefault'))}</label></label>`;
        return `${list('own', 'admOwn')}${list('pacts', 'admPacts')}${list('enemies', 'admEnemies')}
          <div class="adm-inline"><input id="sd-al" list="adm-alliances" placeholder="${esc(L('admPickAlliance'))}">
          <button class="btn small" data-a="side" data-side="own">${esc(L('admSetOwn'))}</button><button class="btn small" data-a="side" data-side="pact">${esc(L('admSetPact'))}</button><button class="btn small" data-a="side" data-side="enemy">${esc(L('admSetEnemy'))}</button></div>
          <datalist id="adm-alliances">${s.alliances.map((a) => `<option value="${esc(a.name)}"></option>`).join('')}</datalist>
          <h4>${esc(L('admColors'))}</h4><div class="adm-inline">${co('own', 'admColorOwn', '#3d8bff')}${co('ally', 'admColorAlly', '#22c7c7')}${co('enemy', 'admColorEnemy', '#ff3b3b')}</div>${save('saveColors')}`;
      }
      case 'Live': {
        const teams = s.live?.allTeams ?? [];
        return `<div class="adm-form"><label>${esc(L('admPoll', { n: s.live?.intervalSec ?? 5 }))}<input id="lv-sec" type="number" min="3" max="120" value="${st.live.pollSeconds ?? ''}"></label>
          <div><span class="lbl">${esc(L('admTeams'))}</span><div class="adm-checks">${teams.length ? teams.map((t) => `<label class="chk"><input type="checkbox" class="lv-team" value="${esc(t.key)}"${st.live.teams.includes(t.key) ? ' checked' : ''}>${esc(t.name)} <span class="muted small">(${t.commands})</span></label>`).join('') : `<span class="muted small">${esc(L('admNone'))}</span>`}</div></div></div>${save('saveLive')}`;
      }
      case 'Drawing': return `<div class="adm-form"><label>${esc(L('admDrawWho'))}${whoSel('dr-who', st.drawing.who)}</label>${roleChecks('dr-r', st.drawing.roles)}
        <label>${esc(L('admDrawExpiry'))}<select id="dr-exp">${[1, 6, 24, 168].map((h) => `<option value="${h}"${h === st.drawing.defaultHours ? ' selected' : ''}>${h === 168 ? esc(L('admGrant1w')) : h === 24 ? esc(L('admGrant1d')) : `${h} h`}</option>`).join('')}</select></label></div>
        <div class="adm-act"><button class="btn small" data-a="saveDrawing">${esc(L('admSave'))}</button><button class="btn small ghost danger" data-a="clearMarks">🧹 ${esc(L('admClearAll'))}</button></div>`;
      case 'Sync': {
        const t = (ms: number | undefined) => (ms ? ago(ms) : '—');
        return `<label class="chk"><input type="checkbox" id="sy-req"${st.sync.requireLink ? ' checked' : ''}>${esc(L('admRequireLink'))}</label>${save('saveSync')}
          <h4>${esc(L('admSyncWho'))} (${s.sync.length})</h4>${s.sync.length ? `<table class="adm-t"><thead><tr><th>${esc(L('admUser'))}</th><th>${esc(L('admLastTroops'))}</th><th>${esc(L('admLastIncoming'))}</th><th>${esc(L('admLastOps'))}</th><th></th></tr></thead><tbody>
          ${s.sync.map((x) => `<tr><td>${userName(x.userId, x.name)}${x.player ? `<br><span class="small">${esc(x.player)}</span>` : ''}</td><td class="small">${t(x.last.troops)}</td><td class="small">${t(x.last.incoming)}</td><td class="small">${t(x.last.ops)}</td>
          <td><button class="btn small ghost danger" data-a="revokeData" data-user="${x.userId}">${esc(L('admRevokeData'))}</button> <button class="btn small ghost danger" data-a="revokeKey" data-user="${x.userId}">${esc(L('admRevokeKey'))}</button></td></tr>`).join('')}</tbody></table>` : `<p class="muted small">${esc(L('admNone'))}</p>`}`;
      }
      case 'Trackers': {
        const tr = st.trackers;
        const row = (k: string, label: 'admTrBoard' | 'admTrConquests' | 'admTrGhosts', on: boolean, ch: string | null, extra = '') => `<div class="adm-tr"><label class="chk"><input type="checkbox" id="tr-${k}-on"${on ? ' checked' : ''}>${esc(L(label))}</label>${chSel(`tr-${k}-ch`, ch)}${extra}</div>`;
        return `${row('board', 'admTrBoard', tr.board.on, tr.board.channelId)}${row('conq', 'admTrConquests', tr.conquests.on, tr.conquests.channelId)}
          ${row('gh', 'admTrGhosts', tr.ghosts.on, tr.ghosts.channelId, `<label class="small">${esc(L('admTrRadius'))} <input id="tr-gh-r" type="number" min="1" max="60" value="${tr.ghosts.radius}" style="width:5em"></label>`)}${save('saveTrackers')}`;
      }
      case 'Lang': return `<p class="muted small">${esc(L('admLangHint'))}</p><div class="adm-act"><button class="btn small ${s.guild.lang === 'en' ? 'on' : 'ghost'}" data-a="lang" data-lang="en">English</button><button class="btn small ${s.guild.lang === 'el' ? 'on' : 'ghost'}" data-a="lang" data-lang="el">Ελληνικά</button></div>`;
      case 'Announce': {
        const stName: Record<string, 'admAnnScheduled' | 'admAnnSent' | 'admAnnFailed' | 'admAnnCancelled'> = { scheduled: 'admAnnScheduled', sent: 'admAnnSent', failed: 'admAnnFailed', cancelled: 'admAnnCancelled' };
        const ch = (id: string) => s.channels.find((c) => c.id === id)?.name ?? id;
        return `<div class="adm-form"><label>${esc(L('admChannel'))}${chSel('an-ch', null)}</label><label>${esc(L('admAnnText'))}<textarea id="an-text" rows="3" maxlength="2000"></textarea></label>
          <label>${esc(L('admAnnAt'))}<input id="an-at" type="datetime-local"></label></div><div class="adm-act"><button class="btn small" data-a="announce">📣 ${esc(L('admAnnPost'))}</button></div>
          ${s.announcements.length ? `<table class="adm-t"><tbody>${s.announcements.map((a) => `<tr><td class="small">${when(a.postAt)}</td><td class="small">#${esc(ch(a.channelId))}</td><td>${esc(a.text.slice(0, 90))}</td><td><span class="sx-badge ${a.status}">${esc(L(stName[a.status] ?? 'admAnnSent'))}</span>${a.error ? ` <span class="muted small">${esc(a.error)}</span>` : ''}</td>
          <td>${a.status === 'scheduled' ? `<button class="btn small ghost" data-a="annCancel" data-id="${a.id}">${esc(L('admAnnCancel'))}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}`;
      }
      case 'Guests': return `<p class="muted small">${esc(L('admGuestHint'))}</p><div class="adm-inline"><input id="gu-label" placeholder="${esc(L('admGuestLabel'))}" maxlength="40">
          <select id="gu-hours"><option value="1">${esc(L('admGrant1h'))}</option><option value="24" selected>${esc(L('admGrant1d'))}</option><option value="72">3 × ${esc(L('admGrant1d'))}</option><option value="168">${esc(L('admGrant1w'))}</option></select>
          <button class="btn small" data-a="guest">${esc(L('admGuestCreate'))}</button></div>
          ${this.guestUrl ? `<div class="adm-url"><span class="small">${esc(L('admGuestCopy'))}</span><input readonly value="${esc(this.guestUrl)}" onclick="this.select()"></div>` : ''}
          ${s.guests.length ? `<table class="adm-t"><tbody>${s.guests.map((g) => `<tr class="${g.revoked || g.expiresAt < now ? 'off' : ''}"><td>${esc(g.label)}</td><td class="small">${g.revoked ? esc(L('admGuestRevoked')) : esc(L('admGuestExpires', { t: fmtAt(g.expiresAt / 1000, lang, undefined, now / 1000) }))}</td>
          <td>${g.revoked || g.expiresAt < now ? '' : `<button class="btn small ghost" data-a="guestDel" data-id="${esc(g.id)}">${esc(L('admRevoke'))}</button>`}</td></tr>`).join('')}</tbody></table>` : ''}`;
      case 'Planner': return `<div class="adm-form"><label>${esc(L('admPlanWindow'))}<input id="pl-win" type="number" min="0" max="120" value="${st.planner.windowMin}"></label>
          <label>${esc(L('admPlanTz'))}<input id="pl-tz" value="${esc(st.planner.timezone)}" list="adm-tz"></label></div>
          <datalist id="adm-tz">${['Europe/Athens', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Istanbul', 'UTC', 'America/New_York', 'America/Sao_Paulo'].map((z) => `<option value="${z}">`).join('')}</datalist>${save('savePlanner')}`;
      case 'Backup': return `<p class="muted small">${esc(L('admBackupHint'))}</p><div class="adm-act"><button class="btn small" data-a="backup">💾 ${esc(L('admBackupDl'))}</button></div>
          <label class="small${s.me.owner ? '' : ' muted'}">${esc(L('admRestore'))} <input type="file" id="rs-file" accept="application/json,.json"${s.me.owner ? '' : ' disabled'}></label>`;
      case 'Admins': return `<p class="muted small">${esc(L('admAdminsHint'))}</p><ul class="adm-list">${s.owners.map((o) => `<li>👑 ${userName(o.userId, o.name)} <span class="sx-badge ok">${esc(L('admOwner'))}</span></li>`).join('')}
          ${s.admins.map((a) => `<li>🛡️ ${userName(a.userId, a.name)} <span class="muted small">${when(a.addedAt)}</span>${s.me.owner ? ` <button class="btn small ghost danger" data-a="adminDel" data-user="${a.userId}">${esc(L('admRemove'))}</button>` : ''}</li>`).join('')}</ul>
          ${s.me.owner ? `<div class="adm-inline"><input id="ad-user" placeholder="${esc(L('admUserId'))}" list="adm-members"><button class="btn small" data-a="adminAdd">${esc(L('admAdd'))}</button></div>` : `<p class="muted small">${esc(L('admOwnerOnly'))}</p>`}`;
      case 'Audit': return s.audit.length ? `<ul class="adm-log">${s.audit.map((a) => `<li><span class="muted small">${when(a.at)}</span> <b>${esc(a.userName ?? a.userId)}</b> <code>${esc(a.action)}</code> <span class="muted small">${esc(a.detail)}</span></li>`).join('')}</ul>` : `<p class="muted small">${esc(L('admAuditEmpty'))}</p>`;
    }
  }
}
