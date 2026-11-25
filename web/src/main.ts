/**
 * GrepoCord web app: the same code runs inside the Discord Activity (detected by the `frame_id` query param Discord
 * adds) and as a plain browser dashboard (session from a signed /live|/map link or Discord login).
 */
import { wt, type WebKey, type WebLang } from '../../src/web/strings.js';
import type { LiveView, LiveCommand, MapPayload } from '../../src/web/types.js';
import { MapView } from './map.js';
import { LiveScreen } from './liveView.js';
import { DrawLayer } from './draw.js';
import { TroopsScreen, type TroopsView } from './troops.js';
import { AlertsScreen } from './alerts.js';
import { OpsScreen } from './ops.js';
import { AdminScreen } from './admin.js';
import { MiniScreen } from './mini.js';
import { SIDE_COLOR } from './geo.js';
import type { FeedView } from './ui.js';
import type { IncomingCmd, SyncOp } from '../../src/web/syncFeeds.js';
import type { TownPanel } from '../../src/web/townPanel.js';

declare global { interface Window { __GC?: { clientId: string; oauth: boolean; lang: WebLang } } }
interface Me { user: string | null; guildId: string; guild: string | null; world: string | null; lang: WebLang; me: number | null; exp: number; units: Record<string, string>; error: string | null;
  tabs?: { troops: boolean; alerts: boolean; ops: boolean; admin: boolean; guest: boolean; owner?: boolean; draw?: boolean; link?: string }; colors?: { own: string | null; ally: string | null; enemy: string | null }; planner?: { windowMin: number; timezone: string } }

const cfg = window.__GC ?? { clientId: '', oauth: false, lang: 'en' as WebLang };
const app = document.getElementById('app')!;
let lang: WebLang = cfg.lang;
const L = (k: WebKey, v: Record<string, string | number> = {}) => wt(lang, k, v);
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SKEY = 'gc_session';
let session: string | null = null;
const inActivity = new URLSearchParams(location.search).has('frame_id');
type Tab = 'live' | 'map' | 'troops' | 'alerts' | 'ops' | 'admin' | 'mini';
const ALL_TABS: Tab[] = ['live', 'map', 'troops', 'alerts', 'ops', 'admin', 'mini'];
const TAB_ICON: Record<Tab, string> = { live: '📡', map: '🗺️', troops: '🛡️', alerts: '🚨', ops: '🎯', admin: '⚙️', mini: '📱' };
const TAB_KEY: Record<Tab, WebKey> = { live: 'tabLive', map: 'tabMap', troops: 'tabTroops', alerts: 'tabAlerts', ops: 'tabOps', admin: 'tabAdmin', mini: 'tabMini' };
const pathTab = location.pathname.split('/')[1] as Tab;
let tab: Tab = ALL_TABS.includes(pathTab) ? pathTab : 'live';
/** Phones opening the plain dashboard get the mini view first (the full view is one tap away). */
const narrow = () => window.matchMedia?.('(max-width: 600px)').matches ?? false;

class AuthError extends Error { constructor(msg: string, public reason = 'expired') { super(msg); } }
async function apiRes(path: string, cache: RequestCache): Promise<Response> {
  // Activity: Bearer token. Browser: the HttpOnly session cookie set by /go/<tab> or the Discord login (sent automatically).
  const res = await fetch(path, { credentials: 'same-origin', cache, headers: session ? { Authorization: `Bearer ${session}` } : {} });
  if (res.status === 401) { const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string }; throw new AuthError(body.error || L('expired'), body.reason); }
  return res;
}
/** JSON POST for the map drawings (custom header = CSRF guard; Bearer inside the Activity, cookie in the browser). */
async function apiPost(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-GC': '1', ...(session ? { Authorization: `Bearer ${session}` } : {}) } });
  const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) throw new AuthError(String(b.error || L('expired')), String(b.reason ?? 'expired'));
  return { ok: res.ok, status: res.status, body: b };
}
/** `cache`: live data is always fresh (no-store); the map revalidates with its ETag (no-cache → 304 when unchanged). */
async function api<T>(path: string, cache: RequestCache = 'no-store'): Promise<T> {
  const res = await apiRes(path, cache);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (res.status === 401) throw new AuthError(body.error || L('expired'), body.reason);
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function screen(html: string) { app.innerHTML = `<div class="center">${html}</div>`; }
/** `offerLogin` only when there is no session at all: a refused personal link needs a fresh link, not Discord login. */
function loginScreen(msg: string, offerLogin = false) {
  screen(`<p>${esc(msg)}</p>${offerLogin && cfg.oauth && !inActivity ? `<a class="btn" href="/login?next=${tab}">${esc(L('login'))}</a>` : ''}
    <p class="muted"><a href="/terms">${esc(L('terms'))}</a> · <a href="/privacy">${esc(L('privacy'))}</a></p>`);
}

async function activityAuth(): Promise<void> {
  // The Discord SDK (~100 KB) is only downloaded inside the Activity, as a separate chunk.
  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  const sdk = new DiscordSDK(cfg.clientId);
  await sdk.ready();
  if (ALL_TABS.includes(sdk.customId as Tab)) tab = sdk.customId as Tab;
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
let drawLayer: DrawLayer | null = null;
let lastLive: LiveView | null = null;
let liveFilter: 'all' | 'in' | 'out' = 'all';
let feedAt = 0;

function renderShell() {
  app.innerHTML = `<div id="shell"><header>
    <span class="brand">🏛️ GrepoCord</span>
    <nav class="tabs">${tabs().map((t) => `<button class="btn small ${tab === t ? 'on' : 'ghost'}" data-tab="${t}" title="${esc(L(TAB_KEY[t]))}">${TAB_ICON[t]} <span>${esc(L(TAB_KEY[t]))}</span></button>`).join('')}</nav>
    ${tab === 'live' ? `<button class="btn small ghost" id="refresh" title="${esc(L('refreshNow'))}">🔄</button>` : ''}
    <span class="meta">${esc(me.guild ?? '')} · ${esc(me.world ?? '-')}${me.user ? ` · ${esc(me.user)}` : ''}${inActivity ? '' : ` · <a href="#" id="logout">${esc(L('logout'))}</a>`}</span>
  </header><main id="view"></main></div>`;
  document.getElementById('refresh')?.addEventListener('click', () => void manualRefresh());
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab as Tab)));
  document.getElementById('logout')?.addEventListener('click', (e) => { e.preventDefault(); try { sessionStorage.removeItem(SKEY); } catch { /* */ } session = null; location.href = '/logout'; });
}

function tabs(): Tab[] {
  const t = me?.tabs;
  if (!t) return ['live', 'map', 'troops'];
  if (t.guest) return ['live', 'map'];
  return ALL_TABS.filter((x) => x === 'live' || x === 'map' || x === 'mini' || t[x as 'troops' | 'alerts' | 'ops' | 'admin']);
}

/** POST /api/live/refresh (server-side 10 s cooldown), then read the fresh snapshot. */
async function manualRefresh() {
  const b = document.getElementById('refresh') as HTMLButtonElement | null;
  if (b) { b.disabled = true; b.textContent = '⏳'; }
  try {
    const r = await apiPost('/api/live/refresh', {});
    if (!r.ok) toast(String(r.body.error ?? `HTTP ${r.status}`));
    else { await new Promise((ok) => setTimeout(ok, 1500)); await pollLive(); }
  } catch (e) { fail(e); }
  finally { setTimeout(() => { const x = document.getElementById('refresh') as HTMLButtonElement | null; if (x) { x.disabled = false; x.textContent = '🔄'; } }, 2000); }
}
function toast(msg: string) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function switchTab(t: Tab) {
  if (!tabs().includes(t)) t = 'live';
  tab = t;
  if (!inActivity) history.replaceState(null, '', `/${t}`);
  drawLayer?.destroy(); drawLayer = null; mapView?.destroy(); mapView = null;
  liveScreen?.destroy(); liveScreen = null;
  troopsScreen?.destroy(); troopsScreen = null;
  feedScreen?.destroy(); feedScreen = null;
  adminScreen?.destroy(); adminScreen = null;
  miniScreen?.destroy(); miniScreen = null;
  renderShell();
  if (t === 'live') void startLive(); else if (t === 'map') void startMap(); else if (t === 'troops') void startTroops();
  else if (t === 'alerts' || t === 'ops') void startFeed(t); else if (t === 'admin') startAdmin(); else void startMini();
}

function fail(e: unknown) {
  if (e instanceof AuthError) {
    try { sessionStorage.removeItem(SKEY); } catch { /* */ }
    return e.reason === 'none' ? loginScreen(L(cfg.oauth ? 'needLogin' : 'needLink'), true) : loginScreen(`${e.message} ${L('needLink')}`);
  }
  const v = document.getElementById('view');
  const html = `<div class="err">${esc(L('error', { msg: e instanceof Error ? e.message : String(e) }))} <button class="btn small" id="retry">${esc(L('retry'))}</button></div>`;
  if (v) { v.innerHTML = html; document.getElementById('retry')?.addEventListener('click', () => switchTab(tab)); } else screen(html);
}

// ---------------------------------------------------------------- live
let liveScreen: LiveScreen | null = null;
let pollMs = 5000;
async function pollLive() {
  try {
    lastLive = await api<LiveView>('/api/live');
    // Ask as often as the server polls GrepoData (its cache is shared, so this costs no GrepoData requests).
    pollMs = lastLive.status?.state === 'warming' ? 1500 : Math.max(3000, Math.min(60_000, (lastLive.status?.intervalSec ?? lastLive.pollSeconds ?? 5) * 1000));
    if (tab === 'live' && liveScreen) { liveScreen.markReceived(); liveScreen.setData(lastLive); }
    if (tab === 'mini' && miniScreen) miniScreen.setData(lastLive);
    mapView?.setCommands(lastLive.commands);
  } catch (e) { if (tab === 'live' || tab === 'mini' || e instanceof AuthError) fail(e); }
}

async function startLive() {
  const v = document.getElementById('view')!;
  v.style.overflow = 'hidden';
  liveScreen = new LiveScreen(v, { L, esc, lang, units: me.units, user: me.user, world: me.world });
  (window as unknown as { __gcLive?: LiveScreen }).__gcLive = liveScreen;
  if (lastLive) liveScreen.setData(lastLive);
  await pollLive();
}

// ---------------------------------------------------------------- map
async function startMap() {
  const v = document.getElementById('view')!;
  v.innerHTML = `<div class="center muted">${esc(L('loading'))}</div>`;
  try {
    const [data, islands] = await Promise.all([
      api<MapPayload>('/api/map', 'no-cache'),
      apiRes('/api/islands', 'default').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    ]);
    v.innerHTML = '';
    v.style.overflow = 'hidden';
    mapView = new MapView(v, data, { L, esc, lang, me: me.me, islands, units: me.units, onWantCommands: (on) => { if (on) void pollLive(); },
      townInfo: me.tabs?.guest ? undefined : (id) => api<TownPanel>(`/api/town?id=${id}`).catch(() => null) });
    drawLayer?.destroy();
    drawLayer = new DrawLayer(mapView, v.querySelector('.mapmain')!, { L, esc, get: (p) => apiRes(p, 'no-store'), post: apiPost });
    (window as unknown as { __gcDraw?: DrawLayer }).__gcDraw = drawLayer;
    (window as unknown as { __gcMap?: MapView }).__gcMap = mapView;
    if (!lastLive) void pollLive();
    if (lastLive) mapView.setCommands(lastLive.commands);
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- troops
let troopsScreen: TroopsScreen | null = null;
async function pollTroops() {
  if (tab !== 'troops' || !troopsScreen) return;
  try {
    const d = await api<TroopsView>('/api/gg/troops');
    troopsScreen.markReceived(); troopsScreen.setData(d);
  } catch (e) { fail(e); }
}
async function startTroops() {
  const v = document.getElementById('view')!;
  v.style.overflow = 'hidden';
  troopsScreen = new TroopsScreen(v, { L, esc, lang, units: me.units });
  (window as unknown as { __gcTroops?: TroopsScreen }).__gcTroops = troopsScreen;
  await pollTroops();
}

// ---------------------------------------------------------------- alerts / ops / admin / mini
let feedScreen: AlertsScreen | OpsScreen | null = null;
let adminScreen: AdminScreen | null = null;
let miniScreen: MiniScreen | null = null;
async function pollFeed() {
  if ((tab !== 'alerts' && tab !== 'ops') || !feedScreen) return;
  try {
    if (feedScreen instanceof AlertsScreen) feedScreen.setData(await api<FeedView<IncomingCmd>>('/api/sync/incoming'));
    else feedScreen.setData(await api<FeedView<SyncOp>>('/api/sync/ops'));
  } catch (e) { fail(e); }
}
async function startFeed(t: 'alerts' | 'ops') {
  const v = document.getElementById('view')!;
  v.style.overflow = 'auto';
  const o = { L, esc, lang, units: me.units };
  feedScreen = t === 'alerts' ? new AlertsScreen(v, o) : new OpsScreen(v, o);
  (window as unknown as { __gcFeed?: unknown }).__gcFeed = feedScreen;
  await pollFeed();
}
function startAdmin() {
  const v = document.getElementById('view')!;
  v.style.overflow = 'hidden';
  adminScreen = new AdminScreen(v, { L, esc, lang, units: me.units, get: <T,>(p: string) => api<T>(p), post: apiPost });
}
async function startMini() {
  const v = document.getElementById('view')!;
  v.style.overflow = 'auto';
  miniScreen = new MiniScreen(v, { L, esc, lang, units: me.units, onRefresh: () => void manualRefresh(), onFull: () => switchTab('live') });
  if (lastLive) miniScreen.setData(lastLive);
  await pollLive();
}
/** Admin-chosen map colors (empty = defaults). */
function applyColors() {
  const c = me.colors;
  if (!c) return;
  if (c.own) SIDE_COLOR.own = c.own;
  if (c.ally) SIDE_COLOR.ally = c.ally;
  if (c.enemy) SIDE_COLOR.enemy = c.enemy;
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    if (inActivity) {
      if (!cfg.clientId) return loginScreen(L('needLink'));
      await activityAuth();
    } else {
      browserAuth(); // no token here is fine: the session cookie is checked by /api/me
    }
    me = await api<Me>('/api/me');
    lang = me.lang === 'el' ? 'el' : 'en';
    document.documentElement.lang = lang;
    document.title = L('title');
    applyColors();
    if (!inActivity && location.pathname === '/' && narrow() && tabs().includes('mini')) tab = 'mini';
    renderShell();
    if (me.error) { document.getElementById('view')!.innerHTML = `<div class="err">${esc(me.error)}</div>`; return; }
    switchTab(tab);
    // Poll the bot's shared cache at the server's own GrepoData interval (5 s by default); nothing while hidden.
    const loop = () => {
      liveTimer = window.setTimeout(async () => {
        if (!document.hidden && (tab === 'live' || tab === 'mini' || mapView?.wantsCommands())) await pollLive();
        if (!document.hidden && tab === 'troops') await pollTroops();
        // Synced feeds change at most every 15 s per player: poll them at a calm 10 s.
        if (!document.hidden && (tab === 'alerts' || tab === 'ops') && Date.now() - feedAt > 9500) { feedAt = Date.now(); await pollFeed(); }
        loop();
      }, pollMs);
    };
    loop();
    document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (tab === 'live' || tab === 'mini') void pollLive(); if (tab === 'troops') void pollTroops(); if (tab === 'alerts' || tab === 'ops') void pollFeed(); });
    // ONE 1 s timer for every countdown/clock on screen.
    tickTimer = window.setInterval(() => { if (document.hidden) return; liveScreen?.tick(); troopsScreen?.tick(); feedScreen?.tick(); miniScreen?.tick(); if (tab === 'map') drawLayer?.maybePoll(); }, 1000);
    window.addEventListener('beforeunload', () => { clearTimeout(liveTimer); clearInterval(tickTimer); });
  } catch (e) { fail(e); }
}

void boot();
