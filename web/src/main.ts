/**
 * GrepoCord web app: the same code runs inside the Discord Activity (detected by the `frame_id` query param Discord
 * adds) and as a plain browser dashboard (session from a signed /live|/map link or Discord login).
 */
import { wt, type WebKey, type WebLang } from '../../src/web/strings.js';
import type { LiveView, LiveCommand, MapPayload } from '../../src/web/types.js';
import { MapView } from './map.js';
import { LiveScreen } from './liveView.js';
import { DrawLayer } from './draw.js';

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
let drawLayer: DrawLayer | null = null;
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
  drawLayer?.destroy(); drawLayer = null; mapView?.destroy(); mapView = null;
  liveScreen?.destroy(); liveScreen = null;
  renderShell();
  if (t === 'live') void startLive(); else void startMap();
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
    mapView?.setCommands(lastLive.commands);
  } catch (e) { if (tab === 'live' || e instanceof AuthError) fail(e); }
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
    mapView = new MapView(v, data, { L, esc, lang, me: me.me, islands, onWantCommands: (on) => { if (on) void pollLive(); } });
    drawLayer?.destroy();
    drawLayer = new DrawLayer(mapView, v.querySelector('.mapmain')!, { L, esc, get: (p) => apiRes(p, 'no-store'), post: apiPost });
    (window as unknown as { __gcDraw?: DrawLayer }).__gcDraw = drawLayer;
    if (!lastLive) void pollLive();
    if (lastLive) mapView.setCommands(lastLive.commands);
  } catch (e) { fail(e); }
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
    renderShell();
    if (me.error) { document.getElementById('view')!.innerHTML = `<div class="err">${esc(me.error)}</div>`; return; }
    switchTab(tab);
    // Poll the bot's shared cache at the server's own GrepoData interval (5 s by default); nothing while hidden.
    const loop = () => {
      liveTimer = window.setTimeout(async () => {
        if (!document.hidden && (tab === 'live' || mapView?.wantsCommands())) await pollLive();
        loop();
      }, pollMs);
    };
    loop();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && tab === 'live') void pollLive(); });
    // ONE 1 s timer for every countdown/clock on screen.
    tickTimer = window.setInterval(() => { if (document.hidden) return; liveScreen?.tick(); if (tab === 'map') drawLayer?.maybePoll(); }, 1000);
    window.addEventListener('beforeunload', () => { clearTimeout(liveTimer); clearInterval(tickTimer); });
  } catch (e) { fail(e); }
}

void boot();
