/**
 * Web app server (node:http, no framework): the Discord Activity and the browser dashboard are the same pages.
 *
 *   GET  /, /live, /map, /troops  single-page app (bundle in compiled/public)
 *   POST/DELETE /api/gg/troops  GrepoGod troop sync (Bearer key, CORS for *.grepolis.com)
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
import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from '../services.js';
import { config } from '../config.js';
import { watchActivityApp } from './activityCheck.js';
import { log } from '../log.js';
import { t, type Lang } from '../i18n.js';
import { guildSides } from '../bot/insights.js';
import { IslandCache } from './islands.js';
import { GpCdn } from './gpcdn.js';
import { MarksService, type MarksResult } from './marks.js';
import { GgService, ggCorsHeaders, ggSend, readGgBody } from './ggTroops.js';
import { mapSides } from './mapData.js';
import { unitName } from '../bot/warPoster.js';
import { UNIT_EN } from '../planner.js';
import { classifyError, logError } from '../bot/errors.js';
import { LiveHub } from './live.js';
import { buildMapPayload } from './mapData.js';
import { authorizeUrl, bearer, check, discordGet, exchangeCode, issueSession, keyId, OAuthError, readCookie, sessionCookie, sign, verify, webSecret, type DiscordGuild, type DiscordUser, type WebSession } from './auth.js';
import { termsPage, privacyPage, messagePage, pickerPage } from './pages.js';

export type Presence = 'yes' | 'no' | 'unknown';
/**
 * What the web app needs from the Discord client. `has` is the (cheap) gateway cache; `check` and `member` ask Discord's
 * REST API (no privileged intent needed) and answer 'unknown' when they cannot tell (e.g. not connected yet), in which
 * case the signed token is trusted: the bot itself signed it for that guild and user.
 */
export interface BotGuilds {
  has(id: string): boolean;
  name(id: string): string | null;
  check?(id: string): Promise<Presence>;
  member?(guildId: string, userId: string): Promise<Presence>;
  /** Whether the user may manage the server (Manage Server permission): may clear everyone's map drawings. */
  manager?(guildId: string, userId: string): Promise<boolean>;
  diag?(): string;
}
export interface WebDeps { ctx: Ctx; guilds: BotGuilds; secret: string; staticDir?: string | null; fetchImpl?: typeof fetch; hub?: LiveHub; islands?: IslandCache; gpcdn?: GpCdn; marks?: MarksService; gg?: GgService; now?: () => number }

type AuthFail = 'none' | 'bad' | 'expired' | 'guild';
const AUTH_KEY = { none: 'web.err.login', bad: 'web.err.badLink', expired: 'web.err.auth', guild: 'web.err.botGone' } as const;

/** Static bundle files, read once per build (mtime) and kept gzipped in memory (a few tens of KB). */
const staticCache = new Map<string, { mtime: number; raw: Buffer; gz: Buffer; etag: string }>();
function staticFile(f: string) {
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs;
  let c = staticCache.get(f);
  if (!c || c.mtime !== mtime) {
    const raw = readFileSync(f);
    c = { mtime, raw, gz: gzipSync(raw, { level: 9 }), etag: `"s${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"` };
    staticCache.set(f, c);
    if (staticCache.size > 50) staticCache.delete(staticCache.keys().next().value!);
  }
  return c;
}
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
  // eslint-disable-next-line prefer-const
  let hub: LiveHub;
  /** Own + allies + enemies for the map and the live in/out split (see mapSides for the fallbacks). */
  const sidesOf = (g: string, snap: Awaited<ReturnType<typeof ctx.worlds.ensure>>) => {
    const explicit = ctx.store.getWarSides(g, snap.world);
    const live = hub?.liveSides(g) ?? { own: [], attackers: [] };
    return mapSides(snap, {
      explicitOurs: explicit.ours, explicitEnemies: explicit.enemies, now: Math.floor(now() / 1000),
      linkedPlayers: ctx.store.linksForGuild(g).filter((l) => l.world === snap.world).map((l) => l.playerId),
      roleAlliances: [...ctx.store.getAllianceRoles(g).keys()], liveOwn: live.own, liveAttackers: live.attackers,
    });
  };
  hub = deps.hub ?? new LiveHub(ctx, async (g, w) => { const sd = sidesOf(g, await ctx.worlds.ensure(w)); return [...sd.ours, ...sd.allies]; });
  const islands = deps.islands ?? new IslandCache(fetchImpl, now);
  const gpcdn = deps.gpcdn ?? new GpCdn(fetchImpl, now);
  const marks = deps.marks ?? new MarksService(ctx.store, (g, u) => guilds.manager?.(g, u) ?? Promise.resolve(false), now);
  const gg = deps.gg ?? new GgService(ctx.store, now);
  const staticDir = deps.staticDir === undefined ? findStaticDir() : deps.staticDir;
  const limiter = new IpLimiter(20, now);
  const mapCache = new Map<string, { key: unknown; at: number; body: Buffer; gz: Buffer; etag: string; sides: string }>();
  const oauthReady = () => !!(config.activityClientId && config.activityClientSecret);
  const langOf = (g: string | null): Lang => (g ? ctx.store.getGuild(g, config.defaultLang).lang : config.defaultLang);
  const redirectUri = () => `${config.publicUrl}/oauth/callback`;
  const loginOk = () => oauthReady() && !!config.publicUrl;
  const page = (lang: Lang, msg: string, hint = true) => messagePage(lang, msg, { login: loginOk(), hint });

  // Is the bot in this guild? Diagnostics only: a signed token is trusted as is. The bot can answer slash commands in a
  // server it is not a member of (app installed with only `applications.commands`, or as a user app), so "not in the
  // gateway cache" or even "Unknown Guild" must not lock people out. Logged so the setup issue is visible.
  const presence = new Map<string, { at: number; v: Presence }>();
  async function botIn(g: string): Promise<boolean> {
    if (guilds.has(g)) return true;
    const c = presence.get(g);
    let v: Presence = c && now() - c.at < 5 * 60_000 ? c.v : 'unknown';
    if (!c || now() - c.at >= 5 * 60_000) {
      v = guilds.check ? await guilds.check(g).catch(() => 'unknown' as Presence) : 'unknown';
      presence.set(g, { at: now(), v });
      log.warn(`web: guild ${g} not in the gateway cache (${guilds.diag?.() ?? 'no diag'}); Discord REST says: ${v}`);
    }
    if (v === 'no') log.warn(`web: the bot user is not a member of guild ${g} (commands still work if the app was added with only "applications.commands"); re-invite it with the "bot" scope for alerts and posts`);
    return true;
  }
  /** A guild the web app may serve: it was set up with the bot (has a world). */
  const usable = async (g: string) => !!ctx.store.getGuild(g).world && (await botIn(g));
  /** Page after a refused personal link: say why and to get a fresh link; never send a link user to Discord login. */
  const linkPage = (lang: Lang, msg: string) => messagePage(lang, msg, { login: false, hint: true });
  const oauthDetail = (e: unknown) => (e instanceof OAuthError ? e.message : 'unexpected error').replace(/[^\w .:/()"'-]/g, '').slice(0, 200);

  /** Session from `Authorization: Bearer` (Activity) or the session cookie (browser), with the reason when refused. */
  async function session(req: http.IncomingMessage): Promise<{ s: WebSession } | { why: AuthFail }> {
    const b = bearer(req.headers.authorization);
    const tok = b ?? readCookie(req.headers.cookie);
    const r = check<WebSession>(tok, secret, now());
    if (!r.ok) {
      if (r.why !== 'none') log.warn(`web: ${b ? 'bearer' : 'cookie'} session refused (${r.why}${r.exp ? `, expired ${new Date(r.exp).toISOString()}` : ''}); this process signs with key ${keyId(secret)}`);
      return { why: r.why };
    }
    return { s: r.v };
  }
  const secureCookie = (req: http.IncomingMessage) => config.publicUrl.startsWith('https://') || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  /** Store the session in a cookie and send the browser to the clean page URL (no token left in the address bar). */
  const login = (req: http.IncomingMessage, res: Res, token: string, exp: number, tab: string) => {
    res.writeHead(302, { Location: `/${tab === 'map' || tab === 'troops' ? tab : 'live'}`, 'Set-Cookie': sessionCookie(token, (exp - now()) / 1000, secureCookie(req)), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
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
    const sides = sidesOf(s.g, snap);
    const sk = JSON.stringify(sides);
    if (!c || c.key !== snap || c.sides !== sk || now() - c.at > 5 * 60_000) {
      const top = [...snap.alliances.values()].sort((a, b) => b.points - a.points).slice(0, 12).map((a) => a.id);
      const ids = [...new Set([...sides.ours, ...sides.allies, ...sides.enemies, ...top])];
      const body = Buffer.from(JSON.stringify(buildMapPayload(snap, sides, { now: now(), history: ctx.store.allianceTownsHistory(world, ids) })));
      c = { key: snap, at: now(), body, gz: gzipSync(body, { level: 9 }), etag: `"m${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`, sides: sk };
      mapCache.set(key, c);
      if (mapCache.size > 200) mapCache.delete(mapCache.keys().next().value!);
    }
    // `me` is per user: sent by /api/me instead so the cached body stays shared per guild.
    // ETag + revalidation: an unchanged map costs a 304 (no body); it changes with the world data or the sides.
    const cacheHdr = { 'Cache-Control': 'private, no-cache', ETag: c.etag, Vary: 'Accept-Encoding, Authorization, Cookie' };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, cacheHdr); return void res.end(); }
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) send(res, 200, c.gz, 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', ...cacheHdr });
    else send(res, 200, c.body, 'application/json; charset=utf-8', cacheHdr);
  }

  /** Binary island layer (see islands.ts); static for a day, so the browser may keep it for an hour and then revalidate. */
  async function islandsPayload(s: WebSession, req: http.IncomingMessage, res: Res) {
    const world = ctx.store.getGuild(s.g).world;
    if (!world) return json(res, 409, { error: t(langOf(s.g), 'web.err.notSetup') });
    const b = await islands.get(await ctx.worlds.ensure(world));
    if (!b) return json(res, 503, { error: 'islands unavailable' });
    const hdr = { 'Cache-Control': 'private, max-age=3600', ETag: b.etag, Vary: 'Accept-Encoding, Authorization, Cookie' };
    if (req.headers['if-none-match'] === b.etag) { res.writeHead(304, hdr); return void res.end(); }
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) send(res, 200, b.gz, 'application/octet-stream', { 'Content-Encoding': 'gzip', ...hdr });
    else send(res, 200, b.raw, 'application/octet-stream', hdr);
  }

  async function route(req: http.IncomingMessage, res: Res) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?');
    const lang0 = config.defaultLang;

    if (req.method === 'GET' && (p === '/' || p === '/live' || p === '/map' || p === '/troops')) {
      const page = indexHtml();
      if (!page) return html(res, 503, messagePage(lang0, 'Web bundle missing: run `npm run build`.'));
      return html(res, 200, page);
    }
    if (req.method === 'GET' && p === '/config.js') {
      const cfg = { clientId: config.activityClientId, oauth: oauthReady() && !!config.publicUrl, lang: lang0 };
      return send(res, 200, `window.__GC=${JSON.stringify(cfg).replace(/</g, '\\u003c')};`, 'application/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    const sm = req.method === 'GET' && staticDir ? /^\/((?:app|chunk-[\w-]+)\.(js|css|js\.map))$/.exec(p) : null;
    if (sm) {
      const f = staticFile(path.join(staticDir!, sm[1]));
      if (f) {
        // Versioned (?v=) or content-hashed chunk names never change: cache for a year. Pre-gzipped in memory.
        const immutable = url.searchParams.has('v') || sm[1].startsWith('chunk-');
        const hdr: Record<string, string> = { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300', ETag: f.etag, Vary: 'Accept-Encoding' };
        if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, hdr); return void res.end(); }
        const type = sm[2] === 'css' ? 'text/css; charset=utf-8' : sm[2] === 'js' ? 'application/javascript; charset=utf-8' : 'application/json';
        if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return send(res, 200, f.gz, type, { ...hdr, 'Content-Encoding': 'gzip' });
        return send(res, 200, f.raw, type, hdr);
      }
    }
    // Official Grepolis icons (whitelisted, fetched + cached server-side; see gpcdn.ts). Public: plain images, no data.
    const gm = req.method === 'GET' ? /^\/gpcdn\/(units|cmds)\.(?:jpg|png)$/.exec(p) : null;
    if (gm) {
      const a = await gpcdn.get(gm[1] as 'units' | 'cmds');
      if (!a) return send(res, 503, 'unavailable', 'text/plain', { 'Cache-Control': 'no-store' });
      const hdr = { 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=604800, immutable' : 'public, max-age=86400', ETag: a.etag };
      if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, hdr); return void res.end(); }
      return send(res, 200, a.body, a.type, hdr);
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
      if (!u.guildIds.includes(g)) return json(res, 403, { access_token: u.token, error: t(lang, 'web.err.notMember') });
      await botIn(g);
      return json(res, 200, { access_token: u.token, session: issueSession(secret, { u: u.user.id, g, n: u.user.global_name || u.user.username, k: 'activity' }, undefined, now()) });
    }

    // ---- Browser dashboard login
    if (req.method === 'GET' && p === '/login') {
      if (!loginOk()) return html(res, 503, page(lang0, t(lang0, 'web.err.noOAuth')));
      const next = url.searchParams.get('next') === 'map' ? 'map' : 'live';
      const state = sign({ n: next, r: randomBytes(8).toString('hex'), exp: now() + 10 * 60_000 }, secret);
      log.info(`web: Discord login started (client ${config.activityClientId}, redirect_uri ${redirectUri()})`);
      return redirect(res, authorizeUrl(state, redirectUri()));
    }
    if (req.method === 'GET' && p === '/oauth/callback') {
      if (!limiter.ok(ip)) return html(res, 429, messagePage(lang0, 'Too many requests'));
      const fail = (status: number, why: string) => {
        log.warn(`web: Discord login failed: ${why}`);
        return html(res, status, messagePage(lang0, `${t(lang0, 'web.err.oauth')} (${why})`, { login: loginOk(), hint: true }));
      };
      const derr = url.searchParams.get('error');
      if (derr) return fail(400, `Discord: ${oauthDetail(new OAuthError(`${derr} ${url.searchParams.get('error_description') ?? ''}`.trim()))}`);
      const st = check<{ n: string; exp: number }>(url.searchParams.get('state'), secret, now());
      const code = url.searchParams.get('code');
      if (!oauthReady()) return fail(503, 'ACTIVITY_CLIENT_ID / ACTIVITY_CLIENT_SECRET not set');
      if (!st.ok) return fail(400, `state ${st.why === 'expired' ? 'expired (took over 10 minutes), start again' : st.why === 'none' ? 'missing' : 'not signed by this bot'}`);
      if (!code) return fail(400, 'no code from Discord');
      let u;
      try { u = await oauthUser(code, redirectUri()); } catch (e) { return fail(401, oauthDetail(e)); }
      const ok: string[] = [];
      for (const g of u.guildIds) if (await usable(g)) ok.push(g);
      log.info(`web: Discord login for user ${u.user.id}: ${u.guildIds.length} server(s) from Discord, set up with the bot: ${ok.length ? ok.join(', ') : 'none'}`);
      const name = u.user.global_name || u.user.username;
      if (!ok.length) { log.warn(`web: Discord login for ${u.user.id}: none of their ${u.guildIds.length} server(s) is set up with the bot`); return html(res, 403, page(lang0, t(lang0, 'web.err.notMember'))); }
      if (ok.length === 1) { const tok = issueSession(secret, { u: u.user.id, g: ok[0], n: name, k: 'oauth' }, undefined, now()); return login(req, res, tok, verify<WebSession>(tok, secret, now())!.exp, st.v.n); }
      const pick = sign({ u: u.user.id, gs: ok, n: st.v.n, nm: name, exp: now() + 10 * 60_000 }, secret);
      return html(res, 200, pickerPage(lang0, ok.map((g) => ({ id: g, name: guilds.name(g) ?? g, href: `/oauth/pick?g=${g}&t=${encodeURIComponent(pick)}` }))));
    }
    if (req.method === 'GET' && p === '/oauth/pick') {
      const pk = verify<{ u: string; gs: string[]; n: string; nm: string; exp: number }>(url.searchParams.get('t'), secret, now());
      const g = url.searchParams.get('g') ?? '';
      if (!pk || !pk.gs.includes(g)) return html(res, 400, page(lang0, t(lang0, 'web.err.auth')));
      const tok = issueSession(secret, { u: pk.u, g, n: pk.nm, k: 'oauth' }, undefined, now());
      return login(req, res, tok, verify<WebSession>(tok, secret, now())!.exp, pk.n);
    }

    // ---- Personal link from /live or /map: token in the query -> session cookie -> clean URL
    const go = /^\/go\/(live|map|troops)$/.exec(p);
    if (req.method === 'GET' && go) {
      const r = check<WebSession>(url.searchParams.get('t'), secret, now());
      if (!r.ok) {
        log.warn(`web: personal link refused (${r.why}); this process signs with key ${keyId(secret)}`);
        return html(res, 401, linkPage(lang0, t(lang0, AUTH_KEY[r.why])));
      }
      // Trust the signature (the bot signed it for this guild + user at command time); only refuse when Discord
      // positively says the bot left the server or the user is no longer a member.
      const gl = langOf(r.v.g);
      await botIn(r.v.g);
      const m = guilds.member ? await guilds.member(r.v.g, r.v.u).catch(() => 'unknown' as Presence) : 'unknown';
      if (m === 'no') { log.warn(`web: link for user ${r.v.u} refused: no longer a member of ${r.v.g}`); return html(res, 403, linkPage(gl, t(gl, 'web.err.left'))); }
      return login(req, res, url.searchParams.get('t')!, r.v.exp, go[1]);
    }
    if (req.method === 'GET' && p === '/logout') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie('', 0, secureCookie(req)), 'Cache-Control': 'no-store' });
      return void res.end();
    }

    // ---- GrepoGod troop sync (Bearer key, not a Discord session). CORS for grepolis.com origins only.
    if (p === '/api/gg/troops' && req.method !== 'GET') {
      const cors = ggCorsHeaders(typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
      if (req.method === 'OPTIONS') { res.writeHead(cors.allow ? 204 : 403, cors.headers); return void res.end(); }
      if (!cors.allow) return ggSend(res, 403, { error: 'origin' }, cors.headers);
      const key = bearer(req.headers.authorization);
      if (req.method === 'POST') {
        const raw = await readGgBody(req);
        if (!raw.ok) return ggSend(res, raw.status, { error: raw.status === 413 ? 'tooLarge' : 'invalid' }, cors.headers);
        const r = gg.post(key, raw.body);
        return ggSend(res, r.status, r.body, cors.headers);
      }
      if (req.method === 'DELETE') {
        const r = gg.remove(key);
        return ggSend(res, r.status, r.body, cors.headers);
      }
      return ggSend(res, 405, { error: 'method' }, cors.headers);
    }

    // ---- Data API
    if (p.startsWith('/api/')) {
      const isMarksWrite = req.method === 'POST' && /^\/api\/marks(?:\/delete|\/clear)?$/.test(p);
      if (req.method !== 'GET' && !isMarksWrite) return json(res, 405, { error: 'method' });
      // Writes need a custom header: a cross-site form/page can't send it without a CORS preflight we never grant (CSRF).
      if (isMarksWrite && req.headers['x-gc'] !== '1') return json(res, 403, { error: 'missing header' });
      const sr = await session(req);
      if (!('s' in sr)) return json(res, 401, { error: t(lang0, sr.why === 'none' && !loginOk() ? 'web.freshLink' : AUTH_KEY[sr.why]), reason: sr.why });
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
      if (p === '/api/marks' || p.startsWith('/api/marks/')) {
        const world = ctx.store.getGuild(s.g, config.defaultLang).world;
        if (!world) return json(res, 409, { error: t(lang, 'web.marks.noWorld') });
        const out = (r: MarksResult) => ('err' in r ? json(res, r.status, { error: t(lang, r.err, r.vars ?? {}) }) : json(res, r.status, r.body));
        if (req.method === 'GET' && p === '/api/marks') {
          const since = url.searchParams.has('rev') ? Number(url.searchParams.get('rev')) : undefined;
          const v = await marks.view(s.g, world, s.u, since);
          if (!v) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return void res.end(); }
          return json(res, 200, v);
        }
        let body: Record<string, unknown>;
        try { body = (await readBody(req, 32_768)) as Record<string, unknown>; } catch { return json(res, 413, { error: t(lang, 'web.marks.invalid') }); }
        if (p === '/api/marks') return out(marks.create(s.g, world, s.u, s.n ?? '', body));
        if (p === '/api/marks/delete') return out(await marks.remove(s.g, world, s.u, body.id));
        if (p === '/api/marks/clear') return out(await marks.clear(s.g, world, s.u, body.all === true));
      }
      if (p === '/api/gg/troops' && req.method === 'GET') {
        const world = ctx.store.getGuild(s.g, config.defaultLang).world;
        if (!world) return json(res, 409, { error: t(lang, 'web.err.notSetup') });
        return json(res, 200, gg.view(s.g, world, s.u), req);
      }
      if (p === '/api/islands') return islandsPayload(s, req, res);
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
  return { handler, hub, marks };
}

export function startWebServer(ctx: Ctx, guilds: BotGuilds) {
  const secret = webSecret(ctx.store);
  const app = createWebApp({ ctx, guilds, secret });
  app.marks.start(); // hourly-ish purge of expired map drawings
  const stopWatch = config.activityClientId ? watchActivityApp() : () => undefined;
  const server = http.createServer(app.handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(config.webPort, '0.0.0.0', () => {
    log.info(`web: signing key ${keyId(secret)}${config.webSecret.length >= 16 ? ' (WEB_SECRET)' : ' (generated, stored in the DB)'}`);
    log.info(`web: live window on :${config.webPort}${config.publicUrl ? ` (public ${config.publicUrl})` : ''}; Activity app ${config.activityClientId ? 'configured' : 'not configured'}${findStaticDir() ? '' : ' — WARNING: web bundle missing'}`);
  });
  server.on('error', (e) => log.error('web server error', e));
  return { secret, close: () => { stopWatch(); app.hub.stop(); app.marks.stop(); server.close(); } };
}

/**
 * Signed personal dashboard link for /live and /map. The token is in the QUERY of /go/<tab>: the server swaps it for an
 * HttpOnly cookie and redirects to the clean URL. (A #fragment is not reliably kept by Discord's link buttons.)
 */
export function dashboardLink(secret: string, guildId: string, userId: string, name: string, tab: 'live' | 'map' | 'troops', hours: number, at = Date.now()): string | null {
  if (!config.publicUrl) return null;
  return `${config.publicUrl}/go/${tab}?t=${issueSession(secret, { u: userId, g: guildId, n: name, k: 'link' }, hours, at)}`;
}
