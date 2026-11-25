/**
 * Web sessions and Discord OAuth for the live window.
 * Tokens are `base64url(json).base64url(hmac-sha256)`; they carry the user, the guild and an expiry and are sent as
 * `Authorization: Bearer` (cookies are unreliable inside the Activity iframe). Nothing secret is ever put in them.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { Store } from '../db.js';

/** `k: 'guest'` = read-only expiring guest link (live + map only), `j` = its id (revocable). */
export interface WebSession { u: string; g: string; exp: number; n?: string; k?: 'link' | 'oauth' | 'activity' | 'guest'; j?: string }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** WEB_SECRET, or a random secret generated once and kept in the DB (survives restarts, never logged). */
export function webSecret(store: Store, envSecret = config.webSecret): string {
  if (envSecret.length >= 16) return envSecret;
  const have = store.getSetting('_global', 'web.secret');
  if (have) return have;
  const s = randomBytes(32).toString('base64url');
  store.setSetting('_global', 'web.secret', s);
  return s;
}

export function sign(payload: object, secret: string): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
}

export type VerifyFail = 'none' | 'bad' | 'expired';
/** Like verify() but says why a token was refused (missing, bad signature/format, or expired). */
export function check<T extends { exp: number }>(token: string | null | undefined, secret: string, now = Date.now()): { ok: true; v: T } | { ok: false; why: VerifyFail; exp?: number } {
  if (!token) return { ok: false, why: 'none' };
  if (token.length > 2048) return { ok: false, why: 'bad' };
  const [body, mac] = token.split('.');
  if (!body || !mac) return { ok: false, why: 'bad' };
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: 'bad' };
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof p.exp !== 'number') return { ok: false, why: 'bad' };
    return p.exp > now ? { ok: true, v: p } : { ok: false, why: 'expired', exp: p.exp };
  } catch { return { ok: false, why: 'bad' }; }
}

export function verify<T extends { exp: number }>(token: string | null | undefined, secret: string, now = Date.now()): T | null {
  const r = check<T>(token, secret, now);
  return r.ok ? r.v : null;
}

/** Short, non-reversible fingerprint of the signing key, logged so two processes with different keys are easy to spot. */
export const keyId = (secret: string) => createHmac('sha256', 'grepocord-key-id').update(secret).digest('hex').slice(0, 8);

export const COOKIE = 'gc_session';
export function readCookie(header: string | undefined, name = COOKIE): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
/** Session cookie: HttpOnly, SameSite=Lax, Secure when the public side is https (behind the tunnel the bot itself only sees http). */
export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${secure ? '; Secure' : ''}`;
}

export const SESSION_HOURS = 12;
export const LINK_HOURS = 12;

export function issueSession(secret: string, s: Omit<WebSession, 'exp'>, hours = SESSION_HOURS, now = Date.now()): string {
  return sign({ ...s, exp: now + hours * 3600_000 }, secret);
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- Discord OAuth (Activity app credentials)
const API = 'https://discord.com/api/v10';
export interface DiscordUser { id: string; username: string; global_name?: string | null }
export interface DiscordGuild { id: string; name: string }
export class OAuthError extends Error {}

export async function exchangeCode(code: string, redirectUri: string | null, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!config.activityClientId || !config.activityClientSecret) throw new OAuthError('not configured');
  const body = new URLSearchParams({ client_id: config.activityClientId, client_secret: config.activityClientSecret, grant_type: 'authorization_code', code });
  if (redirectUri) body.set('redirect_uri', redirectUri);
  const res = await fetchImpl(`${API}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    const hint = j.error === 'invalid_client' ? ' (check ACTIVITY_CLIENT_SECRET: reset it in the portal and update .env)'
      : j.error === 'invalid_grant' ? ' (code already used/expired or redirect_uri differs from the portal)' : '';
    throw new OAuthError(`token exchange failed: HTTP ${res.status} ${j.error ?? ''} ${j.error_description ?? ''}`.replace(/\s+/g, ' ').trim() + hint);
  }
  return j.access_token;
}

export async function discordGet<T>(path: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OAuthError(`Discord GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function authorizeUrl(state: string, redirectUri: string): string {
  // Exactly as Discord documents it: scopes separated by %20 (URLSearchParams would write "+"), redirect_uri
  // percent-encoded and identical to the one sent to /oauth2/token. No `prompt=none`: the consent screen is shown and
  // then redirects (prompt=none only works once the user has already authorized these scopes).
  const enc = encodeURIComponent;
  return `https://discord.com/oauth2/authorize?response_type=code&client_id=${enc(config.activityClientId)}&scope=identify%20guilds&redirect_uri=${enc(redirectUri)}&state=${enc(state)}`;
}
