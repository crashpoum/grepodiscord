/**
 * GrepoData account tokens (City Indexer intel).
 *
 * GrepoData issues ReallySimpleJWT tokens: an access token valid 24 h and a refresh token valid 90 days
 * that ROTATES on every refresh (POST /auth/refresh, form field `refresh_token`). With a refresh token the
 * bot can keep itself logged in indefinitely (as long as it refreshes at least once every 90 days, which
 * it does daily). Without one, the admin is alerted before the access token expires.
 *
 * Tokens are secrets: they live only in the DB / env and in request headers, never in logs or URLs.
 */
import type { GdAuthTokens, GrepoDataClient } from './data/grepodata.js';
import { GrepoDataError } from './data/grepodata.js';
import type { GdTokenRow, Store } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

export interface JwtClaims { exp?: number; iat?: number; uid?: number | string; username?: string; mail?: string; ref?: boolean; account_is_linked?: boolean; mail_is_confirmed?: boolean }

const H = 3_600_000;
/** Refresh when the access token has less than this left. */
export const REFRESH_BEFORE_MS = 2 * H;
/** Warn the admin when this much is left and no automatic renewal is possible. */
export const WARN_BEFORE_MS = 6 * H;

/** Decode (NOT verify) a JWT payload. Returns null for anything that is not a 3-part base64url JWT. */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return json && typeof json === 'object' ? (json as JwtClaims) : null;
  } catch { return null; }
}

/** Expiry in ms since epoch, or null if unknown. */
export function jwtExpMs(token: string): number | null {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/** Cheap shape check so we never send garbage to GrepoData (401s count towards their fail2ban). */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.trim()) && decodeJwt(token) !== null;
}

/** Alert stages stored in gd_tokens.alert_stage. */
export const ALERT = { none: 0, expiringSoon: 1, expired: 2, refreshFailed: 3 } as const;

export type TokenAction =
  | { kind: 'none' }
  | { kind: 'refresh' }
  | { kind: 'login' }
  | { kind: 'alert'; stage: (typeof ALERT)['expiringSoon'] | (typeof ALERT)['expired'] };

/**
 * Decide what to do with a stored token now. Pure, unit-tested.
 * - renewable (refresh token not expired, or login configured) and close to expiry → refresh/login
 * - otherwise alert once at "expiring soon" and once at "expired"
 */
export function planTokenAction(row: Pick<GdTokenRow, 'accessExp' | 'refreshToken' | 'refreshExp' | 'alertStage'>, now: number, canLogin: boolean): TokenAction {
  const left = row.accessExp == null ? Infinity : row.accessExp - now;
  const refreshUsable = !!row.refreshToken && (row.refreshExp == null || row.refreshExp > now) && row.alertStage !== ALERT.refreshFailed;
  if (left <= REFRESH_BEFORE_MS) {
    if (refreshUsable) return { kind: 'refresh' };
    if (canLogin && row.alertStage !== ALERT.refreshFailed) return { kind: 'login' };
  }
  // Renewal will happen in the refresh window: no "expiring soon" DM needed.
  if (left > 0 && (refreshUsable || (canLogin && row.alertStage !== ALERT.refreshFailed))) return { kind: 'none' };
  if (left <= 0) return row.alertStage < ALERT.expired ? { kind: 'alert', stage: ALERT.expired } : { kind: 'none' };
  if (left <= WARN_BEFORE_MS && row.alertStage < ALERT.expiringSoon) return { kind: 'alert', stage: ALERT.expiringSoon };
  return { kind: 'none' };
}

export type IntelAccess =
  | { ok: true; token: string; ephemeral: boolean }
  | { ok: false; reason: 'no-token' | 'expired' };

/** Intel may only be shown inside the guild that owns the token; public only in its intel channel. */
export function intelAccess(row: GdTokenRow | null, channelId: string, now: number): IntelAccess {
  if (!row) return { ok: false, reason: 'no-token' };
  if (row.accessExp != null && row.accessExp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, token: row.accessToken, ephemeral: !(row.intelChannelId && row.intelChannelId === channelId) };
}

function tokensToRow(tokens: GdAuthTokens) {
  return {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token || null,
    accessExp: jwtExpMs(tokens.access_token), refreshExp: tokens.refresh_token ? jwtExpMs(tokens.refresh_token) : null,
  };
}

/** Store a token (pair) for a guild after a local sanity check. */
export function saveToken(store: Store, guildId: string, access: string, refresh: string | null, adminUserId: string | null, source: 'command' | 'env') {
  store.setGdToken({ guildId, accessToken: access.trim(), refreshToken: refresh?.trim() || null, accessExp: jwtExpMs(access), refreshExp: refresh ? jwtExpMs(refresh) : null, adminUserId, source });
}

/**
 * Seed the env token (GREPODATA_TOKEN / GREPODATA_REFRESH_TOKEN) into the DB for GREPODATA_GUILD_ID.
 * A token set later with /grepodata token, or a rotated refresh, is newer and wins: the env value is
 * only (re)applied when it differs from what was last seeded and is not older than the stored one.
 */
export function seedEnvToken(store: Store, now = Date.now()): string | null {
  const access = config.grepodataToken.trim();
  const guildId = config.grepodataGuildId;
  if (!access && !config.grepodataRefreshToken && !config.grepodataLogin) return null;
  if (!guildId) { log.warn('GREPODATA_TOKEN set but neither GREPODATA_GUILD_ID nor DEV_GUILD_ID: intel disabled (it must be bound to one server).'); return null; }
  const existing = store.getGdToken(guildId);
  const envIat = decodeJwt(access)?.iat ?? 0;
  const storedIat = existing ? decodeJwt(existing.accessToken)?.iat ?? 0 : -1;
  if (access && looksLikeJwt(access) && (!existing || (existing.accessToken !== access && envIat > storedIat))) {
    saveToken(store, guildId, access, config.grepodataRefreshToken || null, config.grepodataAdminId || null, 'env');
    log.info(`GrepoData token from env bound to guild ${guildId} (expires ${new Date(jwtExpMs(access) ?? now).toISOString()})`);
  } else if (!existing && (config.grepodataRefreshToken || config.grepodataLogin)) {
    // No usable access token yet: store a placeholder that is already expired so the scheduler renews it immediately.
    store.setGdToken({ guildId, accessToken: '', refreshToken: config.grepodataRefreshToken || null, accessExp: 0, refreshExp: config.grepodataRefreshToken ? jwtExpMs(config.grepodataRefreshToken) : null, adminUserId: config.grepodataAdminId || null, source: 'env' });
  }
  return guildId;
}

export type RenewResult = 'refreshed' | 'logged-in' | 'failed' | 'skipped';

/** Try to renew one guild's token via refresh token, falling back to login (env credentials, env guild only). */
export async function renewToken(store: Store, gd: GrepoDataClient, row: GdTokenRow, how: 'refresh' | 'login'): Promise<RenewResult> {
  try {
    let tokens: GdAuthTokens;
    if (how === 'refresh' && row.refreshToken) tokens = await gd.refreshTokens(row.refreshToken);
    else if (how === 'login' && config.grepodataLogin && config.grepodataPassword && row.guildId === config.grepodataGuildId) tokens = await gd.login(config.grepodataLogin, config.grepodataPassword);
    else return 'skipped';
    if (!tokens?.access_token || !looksLikeJwt(tokens.access_token)) throw new GrepoDataError('no access_token in response');
    const t = tokensToRow(tokens);
    store.setGdToken({ guildId: row.guildId, ...t, refreshToken: t.refreshToken ?? row.refreshToken, refreshExp: t.refreshToken ? t.refreshExp : row.refreshExp, adminUserId: row.adminUserId, source: row.source });
    log.info(`GrepoData token for guild ${row.guildId} renewed via ${how} (expires ${t.accessExp ? new Date(t.accessExp).toISOString() : '?'})`);
    return how === 'refresh' ? 'refreshed' : 'logged-in';
  } catch (e) {
    const status = e instanceof GrepoDataError ? e.status : undefined;
    // Never loop on auth failures (fail2ban): mark as failed so we stop trying until an admin sets a new token.
    if (status && status >= 400 && status < 500) store.setGdAlert(row.guildId, ALERT.refreshFailed, `HTTP ${status}`);
    log.warn(`GrepoData token renewal (${how}) for guild ${row.guildId} failed: ${status ? `HTTP ${status}` : String(e).slice(0, 120)}`);
    return 'failed';
  }
}
