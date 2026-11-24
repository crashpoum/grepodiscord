/**
 * GrepoCord web app: the same code runs inside the Discord Activity (detected by the `frame_id` query param Discord
 * adds) and as a plain browser dashboard (session from a signed /live|/map link or Discord login).
 */
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { wt, type WebKey, type WebLang } from '../../src/web/strings.js';
import type { LiveView, LiveCommand, MapPayload } from '../../src/web/types.js';
import { MapView } from './map.js';

declare global { interface Window { __GC?: { clientId: string; oauth: boolean; lang: WebLang } } }
interface Me { user: string | null; guildId: string; guild: string | null; world: string | null; lang: WebLang; me: number | null; exp: number; units: Record<string, string>; error: string | null }

const cfg = window.__GC ?? { clientId: '', oauth: false, lang: 'en' as WebLang };
const app = document.getElementById('app')!;
let lang: WebLang = cfg.lang;
const L = (k: WebKey, v: Record<string, string | number> = {}) => wt(lang, k, v);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SKEY = 'gc_session';
let session: string | null = null;
const inActivity = new URLSearchParams(location.search).has('frame_id');
let tab: 'live' | 'map' = location.pathname.startsWith('/map') ? 'map' : 'live';

class AuthError extends Error { constructor(msg: string, public reason = 'expired') { super(msg); } }
async function api<T>(path: string): Promise<T> {
  // Activity: Bearer token. Browser: the HttpOnly session cookie set by /go/<tab> or the Discord login (sent automatically).
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: session ? { Authorization: `Bearer ${session}` } : {} });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (res.status === 401) throw new AuthError(body.error || L('expired'), body.reason);
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function screen(html: string) { app.innerHTML = `<div class="center">${html}</div>`; }
function loginScreen(msg: string) {
  screen(`<p>${esc(msg)}</p>${cfg.oauth && !inActivity ? `<a class="btn" href="/login?next=${tab}">${esc(L('login'))}</a>` : ''}
    <p class="muted"><a href="/terms">${esc(L('terms'))}</a> · <a href="/privacy">${esc(L('privacy'))}</a></p>`);
}

async function activityAuth(): Promise<void> {
  const sdk = new DiscordSDK(cfg.clientId);
  await sdk.ready();
  if (sdk.customId === 'map' || sdk.customId === 'live') tab = sdk.customId;
  const locale = (navigator.language || '').toLowerCase();
  if (locale.startsWith('el')) lang = 'el';
  screen(`<p class="muted">${esc(L('signingIn'))}</p>`);
  const { code } = await sdk.commands.authorize({ client_id: cfg.clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify', 'guilds'] });
  const res = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, guild_id: sdk.guildId }) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; session?: string; error?: string };
  if (body.access_token) await sdk.commands.authenticate({ access_token: body.access_token }).catch(() => undefined);
  if (!res.ok || !body.session) throw new AuthError(body.error || L('expired'));
  session = body.session;
}

/** Legacy links carried the token in the #fragment; current links use /go/<tab>?t= and a cookie. */
function browserAuth() {
  const m = /(?:^#|&)s=([^&]+)/.exec(location.hash);
  if (m) {
    session = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(SKEY, session); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname); // drop the token from the address bar
  } else {
    try { session = sessionStorage.getItem(SKEY); } catch { session = null; }
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
}

// ---------------------------------------------------------------- shell
let me: Me;
let liveTimer: number | undefined;
let tickTimer: number | undefined;
let mapView: MapView | null = null;
let lastLive: LiveView | null = null;
let liveFilter: 'all' | 'in' | 'out' = 'all';

function renderShell() {
  app.innerHTML = `<div id="shell"><header>
    <span class="brand">🏛️ GrepoCord</span>
    <nav class="tabs"><button class="btn small ${tab === 'live' ? 'on' : 'ghost'}" data-tab="live">📡 ${esc(L('tabLive'))}</button>
    <button class="btn small ${tab === 'map' ? 'on' : 'ghost'}" data-tab="map">🗺️ ${esc(L('tabMap'))}</button></nav>
    <span class="meta">${esc(me.guild ?? '')} · ${esc(me.world ?? '-')}${me.user ? ` · ${esc(me.user)}` : ''}${inActivity ? '' : ` · <a href="#" id="logout">${esc(L('logout'))}</a>`}</span>
  </header><main id="view"></main></div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab as 'live' | 'map')));
  document.getElementById('logout')?.addEventListener('click', (e) => { e.preventDefault(); try { sessionStorage.removeItem(SKEY); } catch { /* */ } session = null; location.href = '/logout'; });
}

function switchTab(t: 'live' | 'map') {
  tab = t;
  if (!inActivity) history.replaceState(null, '', `/${t}`);
  mapView?.destroy(); mapView = null;
  renderShell();
  if (t === 'live') void startLive(); else void startMap();
}

function fail(e: unknown) {
  if (e instanceof AuthError) {
    try { sessionStorage.removeItem(SKEY); } catch { /* */ }
    return loginScreen(e.reason === 'none' ? L('needLogin') : e.message);
  }
  const v = document.getElementById('view');
  const html = `<div class="err">${esc(L('error', { msg: e instanceof Error ? e.message : String(e) }))} <button class="btn small" id="retry">${esc(L('retry'))}</button></div>`;
  if (v) { v.innerHTML = html; document.getElementById('retry')?.addEventListener('click', () => switchTab(tab)); } else screen(html);
}

// ---------------------------------------------------------------- live
const fmtTime = (s: number) => new Date(s * 1000).toLocaleTimeString(lang === 'el' ? 'el-GR' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtIn(s: number) {
  const d = Math.max(0, Math.round(s - Date.now() / 1000));
  if (d <= 0) return L('justNow');
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), ss = d % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
const unitsText = (u: [string, number][]) => u.map(([k, n]) => `${n} ${me.units[k] ?? k.replace(/_/g, ' ')}`).join(', ');
function typeText(c: LiveCommand) {
  const t = c.type.toLowerCase();
  if (t.includes('support')) return `🛡️ ${L('typeSupport')}`;
  if (t.includes('revolt')) return `🔥 ${L('typeRevolt')}`;
  if (t.includes('attack') || t.includes('takeover') || t.includes('conquer')) return `⚔️ ${L('typeAttack')}`;
  return `📜 ${esc(c.type || L('typeOther'))}`;
}
const end = (e: LiveCommand['src']) => `<b>${esc(e.town || '?')}</b><br><span class="muted">${esc(e.player)}${e.alliance ? ` [${esc(e.alliance)}]` : ''}</span>`;

function renderLive() {
  const v = document.getElementById('view');
  const d = lastLive;
  if (!v || !d) return;
  const now = Date.now() / 1000;
  const rows = d.commands.filter((c) => liveFilter === 'all' || c.side === liveFilter);
  const nIn = d.commands.filter((c) => c.side === 'in').length, nOut = d.commands.filter((c) => c.side === 'out').length;
  const ago = d.updatedAt ? L('updated', { s: Math.max(0, Math.round((Date.now() - d.updatedAt) / 1000)) }) : L('updatedNever');
  v.innerHTML = `${d.error ? `<div class="err">${esc(d.error)}</div>` : ''}
  <div class="grid"><section class="card">
    <h2>⚔️ ${esc(L('incoming'))} <span class="count">${nIn}</span> · ${esc(L('outgoing'))} <span class="count">${nOut}</span>
      <span class="muted" style="margin-left:auto;font-weight:400;font-size:12px">${esc(ago)} · ${esc(L('nextIn', { s: d.pollSeconds }))}</span></h2>
    <div class="filters">${(['all', 'in', 'out'] as const).map((f) => `<button class="btn small ${liveFilter === f ? 'on' : 'ghost'}" data-f="${f}">${esc(L(f === 'all' ? 'filterAll' : f === 'in' ? 'filterIn' : 'filterOut'))}</button>`).join('')}</div>
    ${rows.length ? `<table><thead><tr><th>${esc(L('colArrival'))}</th><th>${esc(L('colIn'))}</th><th>${esc(L('colType'))}</th><th>${esc(L('colFrom'))}</th><th>${esc(L('colTo'))}</th><th>${esc(L('colUnits'))}</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="${c.side}${c.arrival - now < 600 && c.side === 'in' ? ' soon' : ''}"><td>${fmtTime(c.arrival)}</td><td data-arr="${c.arrival}">${fmtIn(c.arrival)}</td>
        <td>${typeText(c)}${c.ret ? `<span class="tag">${esc(L('returning'))}</span>` : ''}${c.planned ? `<span class="tag">${esc(L('planned'))}</span>` : ''}</td>
        <td>${end(c.src)}</td><td>${end(c.trg)}</td><td class="units">${esc(unitsText(c.units))}${c.by ? `<br>${esc(L('colBy'))}: ${esc(c.by)}` : ''}</td></tr>`).join('')}
      </tbody></table>` : `<p class="muted">${esc(L('noCommands'))}</p>`}
  </section>
  <aside style="display:flex;flex-direction:column;gap:12px">
    <section class="card"><h2>👥 ${esc(L('teams'))}</h2>${d.teams.length ? `<ul class="list">${d.teams.map((x) => `<li>${esc(x.name)} <span class="muted">· ${x.players}</span></li>`).join('')}</ul>` : `<p class="muted">${esc(L('noTeams'))}</p>`}
      ${d.stats ? `<p class="muted">${esc(L('stats', d.stats))}</p>` : ''}</section>
    <section class="card"><h2>🕵️ ${esc(L('latestIntel'))}</h2>${d.intel.length ? `<ul class="list">${d.intel.map((x) => `<li><b>${esc(x.town)}</b> <span class="muted">${esc(x.player)}${x.alliance ? ` [${esc(x.alliance)}]` : ''} · ${esc(x.date)}</span>${x.units.length ? `<div class="units">${esc(unitsText(x.units))}</div>` : ''}</li>`).join('')}</ul>` : `<p class="muted">${esc(L('noIntel'))}</p>`}</section>
    ${d.conquests.length ? `<section class="card"><h2>🏳️ ${esc(L('recentConquests'))}</h2><ul class="list">${d.conquests.map((x) => `<li><b>${esc(x.town)}</b> <span class="muted">${esc(x.player)}${x.alliance ? ` [${esc(x.alliance)}]` : ''}${x.by ? ` ← ${esc(x.by)}` : ''} · ${esc(x.date)}</span></li>`).join('')}</ul></section>` : ''}
  </aside></div>`;
  v.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((b) => b.addEventListener('click', () => { liveFilter = b.dataset.f as typeof liveFilter; renderLive(); }));
}

async function pollLive() {
  try { lastLive = await api<LiveView>('/api/live'); if (tab === 'live') renderLive(); mapView?.setCommands(lastLive.commands); } catch (e) { if (tab === 'live' || e instanceof AuthError) fail(e); }
}

async function startLive() {
  document.getElementById('view')!.innerHTML = `<div class="center muted">${esc(L('loading'))}</div>`;
  await pollLive();
}

// ---------------------------------------------------------------- map
async function startMap() {
  const v = document.getElementById('view')!;
  v.innerHTML = `<div class="center muted">${esc(L('loading'))}</div>`;
  try {
    const data = await api<MapPayload>('/api/map');
    v.innerHTML = '';
    v.style.overflow = 'hidden';
    mapView = new MapView(v, data, { L, esc, lang, me: me.me, onWantCommands: (on) => { if (on) void pollLive(); } });
    if (lastLive) mapView.setCommands(lastLive.commands);
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    if (inActivity) {
      if (!cfg.clientId) return loginScreen(L('needLogin'));
      await activityAuth();
    } else {
      browserAuth(); // no token here is fine: the session cookie is checked by /api/me
    }
    me = await api<Me>('/api/me');
    lang = me.lang === 'el' ? 'el' : 'en';
    document.documentElement.lang = lang;
    document.title = L('title');
    renderShell();
    if (me.error) { document.getElementById('view')!.innerHTML = `<div class="err">${esc(me.error)}</div>`; return; }
    switchTab(tab);
    // Server-side cache refreshes every ~20 s; asking it every 10 s costs no GrepoData requests.
    liveTimer = window.setInterval(() => { if (tab === 'live' || mapView?.wantsCommands()) void pollLive(); }, 10_000);
    tickTimer = window.setInterval(() => {
      document.querySelectorAll<HTMLElement>('[data-arr]').forEach((el) => { el.textContent = fmtIn(Number(el.dataset.arr)); });
    }, 1000);
    window.addEventListener('beforeunload', () => { clearInterval(liveTimer); clearInterval(tickTimer); });
  } catch (e) { fail(e); }
}

void boot();
