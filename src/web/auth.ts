/**
 * Web sessions and Discord OAuth for the live window.
 * Tokens are `base64url(json).base64url(hmac-sha256)`; they carry the user, the guild and an expiry and are sent as
 * `Authorization: Bearer` (cookies are unreliable inside the Activity iframe). Nothing secret is ever put in them.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import type { Store } from '../db.js';

export interface WebSession { u: string; g: string; exp: number; n?: string; k?: 'link' | 'oauth' | 'activity' }

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

export function verify<T extends { exp: number }>(token: string | null | undefined, secret: string, now = Date.now()): T | null {
  if (!token || token.length > 2048) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    return typeof p.exp === 'number' && p.exp > now ? p : null;
  } catch { return null; }
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
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !j.access_token) throw new OAuthError(`token exchange failed: HTTP ${res.status} ${j.error ?? ''}`.trim());
  return j.access_token;
}

export async function discordGet<T>(path: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new OAuthError(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function authorizeUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({ client_id: config.activityClientId, response_type: 'code', scope: 'identify guilds', redirect_uri: redirectUri, state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${q}`;
}
