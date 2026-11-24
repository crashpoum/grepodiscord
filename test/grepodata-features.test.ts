import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { Store } from '../src/db.js';
import { ALERT, decodeJwt, intelAccess, jwtExpMs, looksLikeJwt, planTokenAction, renewToken, saveToken, REFRESH_BEFORE_MS, WARN_BEFORE_MS } from '../src/gdAuth.js';
import { resolveDbPath } from '../src/dbPath.js';
import { localDateHour, localToEpoch, worldTz } from '../src/time.js';
import { pickHour } from '../src/gdServices.js';
import {
  browseIntelEmbed, changesEmbed, conquestHistoryEmbed, radarRows, rankingEmbed, scoreboardEmbed, townIntelEmbed, warsEmbed,
} from '../src/gdViews.js';

const H = 3_600_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Unsigned test JWT (the bot only decodes; GrepoData verifies). */
export const jwt = (claims: Record<string, unknown>) => `${b64({ typ: 'JWT', alg: 'HS256' })}.${b64(claims)}.c2ln`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GrepoData client: new endpoints', () => {
  it('builds public URLs with the documented parameters', async () => {
    const urls: string[] = [];
    const gd = new GrepoDataClient('https://x', 1000, (async (u: string) => { urls.push(String(u)); return json({ count: 0, results: [], conq: [], items: [], data: [], towns: [] }); }) as typeof fetch, async () => {});
    await gd.ranking('gr125', 'alliance', 'Rank', 0, 500);
    await gd.conquests('gr125', 'alliance', 52, 'enemy', 15, 15);
    await gd.allianceChanges('gr125', 52, 0, 100);
    await gd.townRadar('gr125', 5096, 99999);
    await gd.hourDiffs('gr125', '2026-11-24', 17);
    const q = urls.map((u) => new URL(u));
    expect(q[0].pathname).toBe('/ranking/alliance');
    expect(Object.fromEntries(q[0].searchParams)).toMatchObject({ world: 'gr125', sort_field: 'Rank', sort_order: 'asc', size: '50' });
    expect(Object.fromEntries(q[1].searchParams)).toMatchObject({ type: 'alliance', id: '52', tenemy: 'true', tfriendly: 'false', tinternal: 'false', city: '_', date: '_', new_owner: '_', old_owner: '_', from: '15' });
    expect(q[2].searchParams.get('size')).toBe('49');
    expect(q[3].searchParams.get('margin')).toBe('6000');
    expect(Object.fromEntries(q[4].searchParams)).toEqual({ world: 'gr125', date: '2026-11-24', hour: '17' });
  });

  it('sends the intel token only as a header and keeps caches separate per guild', async () => {
    const seen: { url: string; token: string | undefined }[] = [];
    const gd = new GrepoDataClient('https://x', 1000, (async (u: string, init?: RequestInit) => {
      seen.push({ url: String(u), token: (init?.headers as Record<string, string>)?.access_token });
      return json({ name: 'T', intel: [] });
    }) as typeof fetch, async () => {});
    await gd.intelTown('SECRET1', 'guildA', 'gr125', 5);
    await gd.intelTown('SECRET1', 'guildA', 'gr125', 5); // cached
    await gd.intelTown('SECRET2', 'guildB', 'gr125', 5); // other guild: own request
    expect(seen.length).toBe(2);
    expect(seen.map((s) => s.token)).toEqual(['SECRET1', 'SECRET2']);
    for (const s of seen) expect(s.url).not.toContain('SECRET');
  });

  it('never retries a 401 (GrepoData fail2ban counts them)', async () => {
    let calls = 0;
    const gd = new GrepoDataClient('https://x', 1000, (async () => { calls++; return json({ message: 'Invalid access token' }, 401); }) as typeof fetch, async () => {});
    await expect(gd.intelPlayer('t', 'g', 'gr125', 1)).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('refreshes with a form-encoded POST', async () => {
    let body = ''; let ct = ''; let method = '';
    const gd = new GrepoDataClient('https://x', 1000, (async (_u: string, init?: RequestInit) => {
      body = String(init?.body); method = String(init?.method); ct = (init?.headers as Record<string, string>)['Content-Type'];
      return json({ success: true, success_code: 1101, access_token: 'a', refresh_token: 'r', expires_in: 86400 });
    }) as typeof fetch, async () => {});
    const r = await gd.refreshTokens('my.refresh.tok');
    expect(method).toBe('POST');
    expect(ct).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(body).get('refresh_token')).toBe('my.refresh.tok');
    expect(r.access_token).toBe('a');
  });
});

describe('GrepoData tokens', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const access = jwt({ uid: 1, username: 'crash', iat: now / 1000 - 3600, exp: now / 1000 + 23 * 3600 });
  const refresh = jwt({ uid: 1, ref: true, exp: now / 1000 + 89 * 86400 });

  it('decodes JWT claims without verifying', () => {
    expect(decodeJwt(access)?.username).toBe('crash');
    expect(jwtExpMs(access)).toBe(now + 23 * H);
    expect(looksLikeJwt(access)).toBe(true);
    expect(looksLikeJwt('hello')).toBe(false);
    expect(looksLikeJwt('a.b.c')).toBe(false); // payload is not JSON
  });

  it('plans refresh, login, alerts and silence', () => {
    const base = { refreshToken: null, refreshExp: null, alertStage: 0 };
    expect(planTokenAction({ ...base, accessExp: now + 10 * H }, now, false)).toEqual({ kind: 'none' });
    expect(planTokenAction({ ...base, accessExp: now + WARN_BEFORE_MS - 1 }, now, false)).toEqual({ kind: 'alert', stage: ALERT.expiringSoon });
    expect(planTokenAction({ ...base, accessExp: now + H, alertStage: ALERT.expiringSoon }, now, false)).toEqual({ kind: 'none' });
    expect(planTokenAction({ ...base, accessExp: now - 1, alertStage: ALERT.expiringSoon }, now, false)).toEqual({ kind: 'alert', stage: ALERT.expired });
    expect(planTokenAction({ ...base, accessExp: now - 1, alertStage: ALERT.expired }, now, false)).toEqual({ kind: 'none' });
    expect(planTokenAction({ ...base, accessExp: now + REFRESH_BEFORE_MS - 1, refreshToken: 'r', refreshExp: now + 1e9 }, now, false)).toEqual({ kind: 'refresh' });
    expect(planTokenAction({ ...base, accessExp: now + 5 * H, refreshToken: 'r', refreshExp: now + 1e9 }, now, false)).toEqual({ kind: 'none' });
    expect(planTokenAction({ ...base, accessExp: now + H, refreshToken: 'r', refreshExp: now - 1 }, now, true)).toEqual({ kind: 'login' });
    // after a rejected refresh: no more attempts, only alerts
    expect(planTokenAction({ ...base, accessExp: now + H, refreshToken: 'r', refreshExp: now + 1e9, alertStage: ALERT.refreshFailed }, now, true)).toEqual({ kind: 'none' });
  });

  it('only gives intel to the owning guild, public only in its intel channel', () => {
    const s = new Store(':memory:');
    expect(intelAccess(s.getGdToken('g1'), 'c', now)).toEqual({ ok: false, reason: 'no-token' });
    saveToken(s, 'g1', access, null, 'u1', 'command');
    expect(intelAccess(s.getGdToken('g2'), 'c', now)).toEqual({ ok: false, reason: 'no-token' });
    expect(intelAccess(s.getGdToken('g1'), 'c', now)).toEqual({ ok: true, token: access, ephemeral: true });
    s.setGdIntelChannel('g1', 'intel');
    expect(intelAccess(s.getGdToken('g1'), 'intel', now)).toMatchObject({ ok: true, ephemeral: false });
    expect(intelAccess(s.getGdToken('g1'), 'other', now)).toMatchObject({ ok: true, ephemeral: true });
    expect(intelAccess(s.getGdToken('g1'), 'c', now + 24 * H)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stores tokens per guild, keeps channel/admin on update, clears', () => {
    const s = new Store(':memory:');
    saveToken(s, 'g1', access, refresh, 'u1', 'command');
    s.setGdIntelChannel('g1', 'ch');
    s.setGdAlert('g1', ALERT.expiringSoon);
    saveToken(s, 'g1', access, null, null, 'env');
    const r = s.getGdToken('g1')!;
    expect(r).toMatchObject({ adminUserId: 'u1', intelChannelId: 'ch', alertStage: 0, refreshToken: null, source: 'env', accessExp: now + 23 * H });
    expect(s.allGdTokens().length).toBe(1);
    expect(s.clearGdToken('g1')).toBe(true);
    expect(s.getGdToken('g1')).toBeNull();
  });

  it('renews with the refresh token and stores the rotated pair', async () => {
    const s = new Store(':memory:');
    saveToken(s, 'g1', access, refresh, 'u1', 'command');
    s.setGdAlert('g1', ALERT.expiringSoon);
    const newAccess = jwt({ username: 'crash', iat: now / 1000, exp: now / 1000 + 86400 });
    const newRefresh = jwt({ ref: true, exp: now / 1000 + 90 * 86400 });
    const gd = new GrepoDataClient('https://x', 1000, (async () => json({ access_token: newAccess, refresh_token: newRefresh, expires_in: 86400 })) as typeof fetch, async () => {});
    expect(await renewToken(s, gd, s.getGdToken('g1')!, 'refresh')).toBe('refreshed');
    expect(s.getGdToken('g1')).toMatchObject({ accessToken: newAccess, refreshToken: newRefresh, alertStage: 0, adminUserId: 'u1', accessExp: now + 24 * H });
  });

  it('marks a rejected refresh and does not retry', async () => {
    const s = new Store(':memory:');
    saveToken(s, 'g1', access, refresh, 'u1', 'command');
    let calls = 0;
    const gd = new GrepoDataClient('https://x', 1000, (async () => { calls++; return json({ message: 'Invalid access token' }, 401); }) as typeof fetch, async () => {});
    expect(await renewToken(s, gd, s.getGdToken('g1')!, 'refresh')).toBe('failed');
    expect(calls).toBe(1);
    expect(s.getGdToken('g1')).toMatchObject({ alertStage: ALERT.refreshFailed, lastError: 'HTTP 401', accessToken: access });
  });
});

describe('DB path migration (GrepoDiscord → GrepoCord)', () => {
  it('renames the legacy file with its WAL/SHM', () => {
    const d = mkdtempSync(join(tmpdir(), 'gc-'));
    for (const f of ['grepodiscord.sqlite', 'grepodiscord.sqlite-wal', 'grepodiscord.sqlite-shm']) writeFileSync(join(d, f), 'x');
    expect(resolveDbPath(join(d, 'grepocord.sqlite'))).toBe(join(d, 'grepocord.sqlite'));
    expect(existsSync(join(d, 'grepocord.sqlite'))).toBe(true);
    expect(existsSync(join(d, 'grepocord.sqlite-wal'))).toBe(true);
    expect(existsSync(join(d, 'grepodiscord.sqlite'))).toBe(false);
  });
  it('leaves new installs, existing files and custom names alone', () => {
    const d = mkdtempSync(join(tmpdir(), 'gc-'));
    expect(resolveDbPath(join(d, 'grepocord.sqlite'))).toBe(join(d, 'grepocord.sqlite'));
    writeFileSync(join(d, 'grepodiscord.sqlite'), 'x');
    expect(resolveDbPath(join(d, 'grepodiscord.sqlite'))).toBe(join(d, 'grepodiscord.sqlite'));
    expect(resolveDbPath(join(d, 'mine.sqlite'))).toBe(join(d, 'mine.sqlite'));
    writeFileSync(join(d, 'grepocord.sqlite'), 'y');
    expect(resolveDbPath(join(d, 'grepocord.sqlite'))).toBe(join(d, 'grepocord.sqlite'));
    expect(existsSync(join(d, 'grepodiscord.sqlite'))).toBe(true); // both exist: never overwrite
  });
});

describe('world-local times', () => {
  it('matches the official conquers.txt timestamp (gr = Europe/Athens)', () => {
    expect(worldTz('gr125')).toBe('Europe/Athens');
    expect(localToEpoch('2026-11-24 16:29:56', 'Europe/Athens')).toBe(1795530596);
    expect(localToEpoch('24-11-26 16:29:56', 'Europe/Athens')).toBe(1795530596);
    expect(localToEpoch('2026-07-01 12:00:00', 'Europe/Athens')).toBe(Date.UTC(2026, 6, 1, 9) / 1000); // summer UTC+3
    expect(localToEpoch('garbage', 'UTC')).toBeNull();
  });
  it('picks the latest past occurrence of an hour', () => {
    const now = Date.UTC(2026, 10, 24, 18, 14); // 20:14 Athens
    expect(localDateHour('Europe/Athens', now)).toEqual({ date: '2026-11-24', hour: 20 });
    expect(pickHour('Europe/Athens', undefined, now)).toEqual({ date: '2026-11-24', hour: 19 });
    expect(pickHour('Europe/Athens', 5, now)).toEqual({ date: '2026-11-24', hour: 5 });
    expect(pickHour('Europe/Athens', 22, now)).toEqual({ date: '2026-11-23', hour: 22 });
  });
});

describe('GrepoData views', () => {
  it('scoreboard: four columns, names escaped', () => {
    const e = scoreboardEmbed('en', 'gr125', 'player', { world: 'gr125', date: '2026-11-24', time: '20:09:02', att: [{ i: '1', s: 29750, n: '*star*' }], def: [], con: [], los: [] }, false);
    expect(e.fields?.[0].value).toContain('\\*star\\*');
    expect(e.fields?.[0].value).toContain('29,750');
    expect(e.description).toContain('<t:');
    expect(scoreboardEmbed('el', 'gr125', 'alliance', { world: 'gr125', date: '2026-11-23', time: '23:59:00', att: [], def: [], con: [], los: [] }, true).title).toContain('2026-11-23');
  });
  it('ranking shows the sorted value and offsets', () => {
    const e = rankingEmbed('en', 'gr125', 'alliance', 'Att', { count: 300, results: [{ type: 'alliance', id: 52, name: 'EL', points: 10, rank: 1, members: 27, att: 5000, def: 1 }] }, 15);
    expect(e.description).toMatch(/^\*\*16\.\*\* \[EL\]/);
    expect(e.description).toContain('**5,000**');
  });
  it('wars sorted by total and with net', () => {
    const e = warsEmbed('en', 'gr125', { id: 52, name: 'EL' }, [
      { alliance_id: 1, alliance_name: 'A', towns_gained_from: 1, towns_lost_to: 0 },
      { alliance_id: 2, alliance_name: 'B', towns_gained_from: 3, towns_lost_to: 5 },
    ]);
    expect(e.description!.indexOf('[B]')).toBeLessThan(e.description!.indexOf('[A]'));
    expect(e.description).toContain('net -2');
    expect(e.description).toContain('Towns taken: **4**');
  });
  it('changes and conquests convert world time to Discord timestamps', () => {
    const c = changesEmbed('en', 'gr125', 'alliance', 'EL', { count: 1, items: [{ date: { date: '2026-11-24 16:29:56' }, player_grep_id: 1, player_name: 'P', old_alliance_grep_id: 0, old_alliance_name: '', new_alliance_grep_id: 52, new_alliance_name: 'EL' }] });
    expect(c.description).toBe('<t:1795530596:d> **P**: _none_ → EL');
    const q = conquestHistoryEmbed('en', 'gr125', 'town', 'T', { count: 1, conq: [{ town_id: 1, time: '2026-11-24 16:29:56', n_p_id: 1, o_p_id: 0, n_a_id: 0, o_a_id: 0, points: 100, type: 'enemy', town_name: 'T', n_p_name: 'N', o_p_name: '', n_a_name: '', o_a_name: '' }] });
    expect(q.description).toBe('⚔️ <t:1795530596:d> **T** (100): N ← _ghost town_');
  });
  it('radar rows: distance, radius, ghosts, center excluded', () => {
    const towns = [
      { id: 1, name: 'C', points: 1, player_id: 1, player_name: 'p', alliance_id: 0, alliance_name: '', x: 10, y: 10, tp: 'town', distance: 0 },
      { id: 2, name: 'far', points: 1, player_id: 1, player_name: 'p', alliance_id: 0, alliance_name: '', x: 40, y: 10, tp: 'town', distance: 0 },
      { id: 3, name: 'g', points: 1, player_id: null, player_name: '', alliance_id: 0, alliance_name: '', x: 13, y: 14, tp: 'ghost_town', distance: 0 },
      { id: 4, name: 'n', points: 1, player_id: 2, player_name: 'q', alliance_id: 0, alliance_name: '', x: 11, y: 10, tp: 'town', distance: 0 },
    ];
    expect(radarRows(towns, 10, 10, 10, { excludeId: 1 }).map((r) => [r.town.id, r.dist])).toEqual([[4, 1], [3, 5]]);
    expect(radarRows(towns, 10, 10, 10, { ghostsOnly: true }).map((r) => r.town.id)).toEqual([3]);
  });
  it('town intel: skips deleted reports, shows units', () => {
    const e = townIntelEmbed('en', 'gr125', 5, { name: 'T', ix: 1, iy: 2, player_id: 3, player_name: 'P', intel: [
      { id: 1, date: '24-11-26 16:29:56', type: 'enemy_attack', units: [{ name: 'sword', count: '120', killed: '20' }], wall: 25 },
      { id: 2, date: '23-11-26 10:00:00', type: 'friendly_attack', deleted: true, units: [] },
    ], notes: [] });
    expect(e.fields?.length).toBe(1);
    expect(e.fields?.[0].name).toContain('<t:1795530596:d>');
    expect(e.fields?.[0].value).toContain('sword 120 (−20)');
    expect(e.fields?.[0].value).toContain('wall 25');
  });
  it('player/alliance intel: handles PHP object-keyed players', () => {
    const d = {
      cities: { players: { '7': { id: 7, name: 'P', towns: [{ town_id: 1, name: 'A', count: 3 }, { town_id: 2, name: 'B', count: 1 }] } } },
      off: { players: { '7': { id: 7, name: 'P', towns: [{ town_id: 1, town_name: 'A', date: '24-11-26 16:29:56', units: [{ name: 'slinger', count: '800' }], priority: true }, { town_id: 1, town_name: 'A', units: [], priority: false }] } } },
      def: { players: [] },
    };
    const e = browseIntelEmbed('en', 'gr125', 'alliance', { id: 52, name: 'EL' }, d);
    expect(e.description).toContain('2 towns indexed (4 reports) across 1 player');
    expect(e.fields?.length).toBe(1);
    expect(e.fields?.[0].name).toContain('(1)');
    expect(e.fields?.[0].value).toContain('P · **A**');
    expect(e.fields?.[0].value).toContain('slinger 800');
  });
});
