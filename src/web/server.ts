/**
 * Web app server (node:http, no framework): the Discord Activity and the browser dashboard are the same pages.
 *
 *   GET  /, /live, /map     single-page app (bundle in compiled/public)
 *   POST /api/token         Activity OAuth: code -> access_token (+ our session), membership checked
 *   GET  /login, /oauth/*   browser dashboard Discord login (same Activity app credentials)
 *   GET  /api/me|live|map   data, `Authorization: Bearer <session>` (session from /api/token, OAuth or a signed /live link)
 *   GET  /terms, /privacy   pages Discord asks for when verifying the Activity app
 *
 * It listens on WEB_PORT inside the container only; the cloudflared sidecar publishes it (see SETUP-ACTIVITY.md).
 */
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../services.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { t, type Lang } from '../i18n.js';
import { guildSides } from '../bot/insights.js';
import { unitName } from '../bot/warPoster.js';
import { UNIT_EN } from '../planner.js';
import { classifyError, logError } from '../bot/errors.js';
import { LiveHub } from './live.js';
import { buildMapPayload } from './mapData.js';
import { authorizeUrl, bearer, check, discordGet, exchangeCode, issueSession, keyId, OAuthError, readCookie, sessionCookie, sign, verify, webSecret, type DiscordGuild, type DiscordUser, type WebSession } from './auth.js';
import { termsPage, privacyPage, messagePage, pickerPage } from './pages.js';

export interface BotGuilds { has(id: string): boolean; name(id: string): string | null }
export interface WebDeps { ctx: Ctx; guilds: BotGuilds; secret: string; staticDir?: string | null; fetchImpl?: typeof fetch; hub?: LiveHub; now?: () => number }

type AuthFail = 'none' | 'bad' | 'expired' | 'guild';
const AUTH_KEY = { none: 'web.err.login', bad: 'web.err.badLink', expired: 'web.err.auth', guild: 'web.err.notMember' } as const;

const STATIC: Record<string, string> = { '/app.js': 'application/javascript; charset=utf-8', '/app.css': 'text/css; charset=utf-8', '/app.js.map': 'application/json' };
const FRAME_ANCESTORS = "'self' https://discord.com https://*.discord.com https://*.discordsays.com";

export function findStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const d of [process.env.WEB_STATIC_DIR, path.join(here, '../public'), path.join(here, '../../compiled/public')]) {
    if (d && existsSync(path.join(d, 'index.html'))) return d;
  }
  return null;
}

type Res = http.ServerResponse;
function send(res: Res, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors ${FRAME_ANCESTORS}`,
    ...extra,
  });
  res.end(body);
}
const json = (res: Res, status: number, v: unknown, req?: http.IncomingMessage) => {
  const raw = Buffer.from(JSON.stringify(v));
  if (req && raw.length > 4096 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    send(res, status, gzipSync(raw), 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' });
  } else send(res, status, raw, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
};
const html = (res: Res, status: number, body: string) => send(res, status, body, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
const redirect = (res: Res, to: string) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); };

async function readBody(req: http.IncomingMessage, max = 8192): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > max) throw new Error('body too large'); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Tiny per-IP limiter for the auth endpoints (CF-Connecting-IP when behind the tunnel). */
class IpLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private now: () => number) {}
  ok(ip: string) {
    const n = this.now();
    const arr = (this.hits.get(ip) ?? []).filter((x) => n - x < 60_000);
    arr.push(n);
    this.hits.set(ip, arr);
    if (this.hits.size > 5000) this.hits.clear();
    return arr.length <= this.max;
  }
}

export function createWebApp(deps: WebDeps) {
  const { ctx, guilds, secret } = deps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hub = deps.hub ?? new LiveHub(ctx, async (g, w) => guildSides(ctx, g, await ctx.worlds.ensure(w)).ours);
  const staticDir = deps.staticDir === undefined ? findStaticDir() : deps.staticDir;
  const limiter = new IpLimiter(20, now);
  const mapCache = new Map<string, { key: unknown; at: number; body: Buffer; gz: Buffer }>();
  const oauthReady = () => !!(config.activityClientId && config.activityClientSecret);
  const langOf = (g: string | null): Lang => (g ? ctx.store.getGuild(g, config.defaultLang).lang : config.defaultLang);
  const redirectUri = () => `${config.publicUrl}/oauth/callback`;
  /** A guild the web app may serve: the bot is in it and it has a world. */
  const usable = (g: string) => guilds.has(g) && !!ctx.store.getGuild(g).world;

  /** Session from `Authorization: Bearer` (Activity) or the session cookie (browser), with the reason when refused. */
  function session(req: http.IncomingMessage): { s: WebSession } | { why: AuthFail } {
    const b = bearer(req.headers.authorization);
    const tok = b ?? readCookie(req.headers.cookie);
    const r = check<WebSession>(tok, secret, now());
    if (!r.ok) {
      if (r.why !== 'none') log.warn(`web: ${b ? 'bearer' : 'cookie'} session refused (${r.why}${r.exp ? `, expired ${new Date(r.exp).toISOString()}` : ''}); this process signs with key ${keyId(secret)}`);
      return { why: r.why };
    }
    if (!guilds.has(r.v.g)) { log.warn(`web: session for guild ${r.v.g} refused: the bot is not in that server (or not connected yet)`); return { why: 'guild' }; }
    return { s: r.v };
  }
  const secureCookie = (req: http.IncomingMessage) => config.publicUrl.startsWith('https://') || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  /** Store the session in a cookie and send the browser to the clean page URL (no token left in the address bar). */
  const login = (req: http.IncomingMessage, res: Res, token: string, exp: number, tab: string) => {
    res.writeHead(302, { Location: `/${tab === 'map' ? 'map' : 'live'}`, 'Set-Cookie': sessionCookie(token, (exp - now()) / 1000, secureCookie(req)), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  };

  function indexHtml(): string | null {
    if (!staticDir) return null;
    // Cache-bust the bundle per build so browsers (and Discord's proxy) never mix old and new files.
    const v = Math.floor(statSync(path.join(staticDir, 'index.html')).mtimeMs).toString(36);
    return readFileSync(path.join(staticDir, 'index.html'), 'utf8').replace(/"\/(app\.(?:js|css))"/g, `"/$1?v=${v}"`);
  }

  async function oauthUser(code: string, redirect: string | null) {
    const token = await exchangeCode(code, redirect, fetchImpl);
    const [user, gl] = await Promise.all([discordGet<DiscordUser>('/users/@me', token, fetchImpl), discordGet<DiscordGuild[]>('/users/@me/guilds', token, fetchImpl)]);
    return { token, user, guildIds: gl.map((g) => g.id) };
  }

  async function mapPayload(s: WebSession, req: http.IncomingMessage, res: Res) {
    const world = ctx.store.getGuild(s.g).world;
    if (!world) return json(res, 409, { error: t(langOf(s.g), 'web.err.notSetup') });
    const snap = await ctx.worlds.ensure(world);
    const key = `${s.g}|${world}`;
    let c = mapCache.get(key);
    if (!c || c.key !== snap || now() - c.at > 5 * 60_000) {
      const sides = guildSides(ctx, s.g, snap);
      const top = [...snap.alliances.values()].sort((a, b) => b.points - a.points).slice(0, 12).map((a) => a.id);
      const ids = [...new Set([...sides.ours, ...sides.enemies, ...top])];
      const body = Buffer.from(JSON.stringify(buildMapPayload(snap, sides, { now: now(), history: ctx.store.allianceTownsHistory(world, ids) })));
      c = { key: snap, at: now(), body, gz: gzipSync(body) };
      mapCache.set(key, c);
      if (mapCache.size > 200) mapCache.delete(mapCache.keys().next().value!);
    }
    // `me` is per user: sent by /api/me instead so the cached body stays shared per guild.
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) send(res, 200, c.gz, 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' });
    else send(res, 200, c.body, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
  }

  async function route(req: http.IncomingMessage, res: Res) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?');
    const lang0 = config.defaultLang;

    if (req.method === 'GET' && (p === '/' || p === '/live' || p === '/map')) {
      const page = indexHtml();
      if (!page) return html(res, 503, messagePage(lang0, 'Web bundle missing: run `npm run build`.'));
      return html(res, 200, page);
    }
    if (req.method === 'GET' && p === '/config.js') {
      const cfg = { clientId: config.activityClientId, oauth: oauthReady() && !!config.publicUrl, lang: lang0 };
      return send(res, 200, `window.__GC=${JSON.stringify(cfg).replace(/</g, '\\u003c')};`, 'application/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && STATIC[p] && staticDir) {
      const f = path.join(staticDir, p.slice(1));
      if (existsSync(f)) return send(res, 200, readFileSync(f), STATIC[p], { 'Cache-Control': 'public, max-age=300' });
    }
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/terms') return html(res, 200, termsPage(config.privacyContact));
    if (p === '/privacy') return html(res, 200, privacyPage(config.privacyContact));

    // ---- Activity: exchange the code from discordSdk.commands.authorize()
    if (req.method === 'POST' && p === '/api/token') {
      if (!limiter.ok(ip)) return json(res, 429, { error: 'rate limited' });
      const body = (await readBody(req)) as { code?: unknown; guild_id?: unknown };
      const g = typeof body.guild_id === 'string' && /^\d{5,25}$/.test(body.guild_id) ? body.guild_id : null;
      const lang = langOf(g);
      if (!oauthReady()) return json(res, 503, { error: t(lang, 'web.err.noOAuth') });
      if (typeof body.code !== 'string' || body.code.length > 200) return json(res, 400, { error: t(lang, 'web.err.oauth') });
      let u;
      try { u = await oauthUser(body.code, null); } catch (e) { log.warn(`web: activity token exchange failed: ${(e as Error).message}`); return json(res, 401, { error: t(lang, 'web.err.oauth') }); }
      if (!g) return json(res, 400, { access_token: u.token, error: t(lang, 'web.err.noGuild') });
      if (!u.guildIds.includes(g) || !guilds.has(g)) return json(res, 403, { access_token: u.token, error: t(lang, 'web.err.notMember') });
      return json(res, 200, { access_token: u.token, session: issueSession(secret, { u: u.user.id, g, n: u.user.global_name || u.user.username, k: 'activity' }, undefined, now()) });
    }

    // ---- Browser dashboard login
    if (req.method === 'GET' && p === '/login') {
      if (!oauthReady() || !config.publicUrl) return html(res, 503, messagePage(lang0, t(lang0, 'web.err.noOAuth')));
      const next = url.searchParams.get('next') === 'map' ? 'map' : 'live';
      const state = sign({ n: next, r: randomBytes(8).toString('hex'), exp: now() + 10 * 60_000 }, secret);
      return redirect(res, authorizeUrl(state, redirectUri()));
    }
    if (req.method === 'GET' && p === '/oauth/callback') {
      if (!limiter.ok(ip)) return html(res, 429, messagePage(lang0, 'Too many requests'));
      const st = verify<{ n: string; exp: number }>(url.searchParams.get('state'), secret, now());
      const code = url.searchParams.get('code');
      if (!st || !code || !oauthReady()) return html(res, 400, messagePage(lang0, t(lang0, 'web.err.oauth')));
      let u;
      try { u = await oauthUser(code, redirectUri()); } catch (e) { log.warn(`web: dashboard login failed: ${(e as Error).message}`); return html(res, 401, messagePage(lang0, t(lang0, 'web.err.oauth'))); }
      const ok = u.guildIds.filter(usable);
      const name = u.user.global_name || u.user.username;
      if (!ok.length) return html(res, 403, messagePage(lang0, t(lang0, 'web.err.notMember')));
      if (ok.length === 1) { const tok = issueSession(secret, { u: u.user.id, g: ok[0], n: name, k: 'oauth' }, undefined, now()); return login(req, res, tok, verify<WebSession>(tok, secret, now())!.exp, st.n); }
      const pick = sign({ u: u.user.id, gs: ok, n: st.n, nm: name, exp: now() + 10 * 60_000 }, secret);
      return html(res, 200, pickerPage(lang0, ok.map((g) => ({ id: g, name: guilds.name(g) ?? g, href: `/oauth/pick?g=${g}&t=${encodeURIComponent(pick)}` }))));
    }
    if (req.method === 'GET' && p === '/oauth/pick') {
      const pk = verify<{ u: string; gs: string[]; n: string; nm: string; exp: number }>(url.searchParams.get('t'), secret, now());
      const g = url.searchParams.get('g') ?? '';
      if (!pk || !pk.gs.includes(g)) return html(res, 400, messagePage(lang0, t(lang0, 'web.err.auth')));
      const tok = issueSession(secret, { u: pk.u, g, n: pk.nm, k: 'oauth' }, undefined, now());
      return login(req, res, tok, verify<WebSession>(tok, secret, now())!.exp, pk.n);
    }

    // ---- Personal link from /live or /map: token in the query -> session cookie -> clean URL
    const go = /^\/go\/(live|map)$/.exec(p);
    if (req.method === 'GET' && go) {
      const r = check<WebSession>(url.searchParams.get('t'), secret, now());
      if (!r.ok) {
        log.warn(`web: personal link refused (${r.why}); this process signs with key ${keyId(secret)}`);
        return html(res, 401, messagePage(lang0, t(lang0, AUTH_KEY[r.why])));
      }
      if (!guilds.has(r.v.g)) return html(res, 403, messagePage(lang0, t(langOf(r.v.g), 'web.err.notMember')));
      return login(req, res, url.searchParams.get('t')!, r.v.exp, go[1]);
    }
    if (req.method === 'GET' && p === '/logout') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie('', 0, secureCookie(req)), 'Cache-Control': 'no-store' });
      return void res.end();
    }

    // ---- Data API
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method' });
      const sr = session(req);
      if (!('s' in sr)) return json(res, 401, { error: t(lang0, AUTH_KEY[sr.why]), reason: sr.why });
      const s = sr.s;
      const lang = langOf(s.g);
      if (p === '/api/me') {
        const gc = ctx.store.getGuild(s.g, config.defaultLang);
        const link = ctx.store.getLink(s.g, s.u);
        return json(res, 200, { user: s.n ?? null, guildId: s.g, guild: guilds.name(s.g), world: gc.world, lang: gc.lang, me: link && link.world === gc.world ? link.playerId : null, exp: s.exp,
          units: gc.world ? Object.fromEntries(Object.keys(UNIT_EN).map((u) => [u, unitName(u, gc.lang, gc.world!)])) : {}, error: gc.world ? null : t(lang, 'web.err.notSetup') });
      }
      if (p === '/api/live') return json(res, 200, await hub.view(s.g, lang), req);
      if (p === '/api/map') return mapPayload(s, req, res);
      return json(res, 404, { error: 'not found' });
    }
    return html(res, 404, messagePage(lang0, '404'));
  }

  const handler = (req: http.IncomingMessage, res: Res) => {
    route(req, res).catch((e) => {
      const c = classifyError(e);
      logError(`web ${req.method} ${(req.url ?? '').split('?')[0]}`, e, c);
      if (!res.headersSent) json(res, e instanceof OAuthError ? 401 : 500, { error: t(config.defaultLang, c.key, c.vars) });
      else res.end();
    });
  };
  return { handler, hub };
}

export function startWebServer(ctx: Ctx, guilds: BotGuilds) {
  const secret = webSecret(ctx.store);
  const app = createWebApp({ ctx, guilds, secret });
  const server = http.createServer(app.handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(config.webPort, '0.0.0.0', () => {
    log.info(`web: signing key ${keyId(secret)}${config.webSecret.length >= 16 ? ' (WEB_SECRET)' : ' (generated, stored in the DB)'}`);
    log.info(`web: live window on :${config.webPort}${config.publicUrl ? ` (public ${config.publicUrl})` : ''}; Activity app ${config.activityClientId ? 'configured' : 'not configured'}${findStaticDir() ? '' : ' — WARNING: web bundle missing'}`);
  });
  server.on('error', (e) => log.error('web server error', e));
  return { secret, close: () => { app.hub.stop(); server.close(); } };
}

/**
 * Signed personal dashboard link for /live and /map. The token is in the QUERY of /go/<tab>: the server swaps it for an
 * HttpOnly cookie and redirects to the clean URL. (A #fragment is not reliably kept by Discord's link buttons.)
 */
export function dashboardLink(secret: string, guildId: string, userId: string, name: string, tab: 'live' | 'map', hours: number, at = Date.now()): string | null {
  if (!config.publicUrl) return null;
  return `${config.publicUrl}/go/${tab}?t=${issueSession(secret, { u: userId, g: guildId, n: name, k: 'link' }, hours, at)}`;
}
