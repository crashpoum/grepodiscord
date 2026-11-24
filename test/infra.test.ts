import { describe, expect, it } from 'vitest';
import { RateLimiter, TtlCache, backoffMs } from '../src/data/ratelimit.js';
import { GrepoDataClient, GrepoDataError } from '../src/data/grepodata.js';
import { STRINGS, t } from '../src/i18n.js';
import { Store } from '../src/db.js';
import { isValidWorldId } from '../src/data/official.js';
import { md } from '../src/embeds.js';

describe('RateLimiter', () => {
  it('allows max per window and waits for the rest', async () => {
    let now = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(2, 1000, () => now, async (ms) => { waits.push(ms); now += ms; });
    await rl.acquire(); await rl.acquire();
    expect(waits).toEqual([]);
    await rl.acquire();
    expect(waits.length).toBe(1);
    expect(now).toBeGreaterThanOrEqual(1000);
  });
  it('honours a global pause', async () => {
    let now = 0;
    const rl = new RateLimiter(10, 1000, () => now, async (ms) => { now += ms; });
    rl.pause(5000);
    await rl.acquire();
    expect(now).toBe(5000);
  });
});

describe('TtlCache / backoff', () => {
  it('expires entries but keeps stale copies', () => {
    let now = 0;
    const c = new TtlCache<number>(10, () => now);
    c.set('a', 1, 100);
    expect(c.get('a')).toBe(1);
    now = 200;
    expect(c.get('a')).toBeUndefined();
    expect(c.getStale('a')).toBe(1);
  });
  it('evicts oldest beyond max entries', () => {
    const c = new TtlCache<number>(2);
    c.set('a', 1, 1e6); c.set('b', 2, 1e6); c.set('c', 3, 1e6);
    expect(c.getStale('a')).toBeUndefined();
  });
  it('backoff grows and is capped', () => {
    expect(backoffMs(0, 1000, 60000, () => 0)).toBe(500);
    expect(backoffMs(3, 1000, 60000, () => 1)).toBe(8000);
    expect(backoffMs(20, 1000, 60000, () => 1)).toBe(60000);
  });
});

describe('GrepoDataClient', () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  it('caches responses and de-duplicates', async () => {
    let calls = 0;
    const gd = new GrepoDataClient('https://x', 100, (async () => { calls++; return json({ grep_id: 1, name: 'A' }); }) as typeof fetch, async () => {});
    const [a, b] = await Promise.all([gd.playerInfo('en1', 1), gd.playerInfo('en1', 1)]);
    await gd.playerInfo('en1', 1);
    expect(a.name).toBe('A'); expect(b.name).toBe('A');
    expect(calls).toBe(1);
  });
  it('retries after 429 / 5xx and succeeds', async () => {
    const seq = [json({}, 429, { 'retry-after': '0.001' }), json({}, 502), json({ grep_id: 2, name: 'B' })];
    let calls = 0;
    const gd = new GrepoDataClient('https://x', 100, (async () => seq[calls++]) as typeof fetch, async () => {});
    expect((await gd.playerInfo('en1', 2)).name).toBe('B');
    expect(calls).toBe(3);
  });
  it('does not retry 400/404', async () => {
    let calls = 0;
    const gd = new GrepoDataClient('https://x', 100, (async () => { calls++; return json({}, 404); }) as typeof fetch, async () => {});
    await expect(gd.playerInfo('en1', 3)).rejects.toBeInstanceOf(GrepoDataError);
    expect(calls).toBe(1);
  });
});

describe('i18n', () => {
  it('Greek has every key with the same placeholders', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [k, v] of Object.entries(STRINGS.en)) {
      const g = (STRINGS.el as Record<string, string>)[k];
      expect(g, k).toBeTruthy();
      expect(ph(g), k).toBe(ph(v));
    }
  });
  it('interpolates', () => {
    expect(t('en', 'feed.removed', { id: 7 })).toBe('Feed #7 removed.');
    expect(t('el', 'feed.removed', { id: 7 })).toBe('Η ροή #7 αφαιρέθηκε.');
  });
});

describe('Store (sqlite)', () => {
  it('persists guild config, feeds, links, roles, files, activity', () => {
    const s = new Store(':memory:');
    expect(s.getGuild('g').world).toBeNull();
    s.setGuild({ guildId: 'g', world: 'gr126', lang: 'el', verifiedRoleId: 'V' });
    expect(s.getGuild('g')).toMatchObject({ world: 'gr126', lang: 'el', verifiedRoleId: 'V' });
    const id = s.addFeed({ guildId: 'g', channelId: 'c', world: 'gr126', type: 'bp', filter: { minBp: 100 } });
    expect(s.feedsForWorld('gr126')[0]).toMatchObject({ id, type: 'bp', filter: { minBp: 100 } });
    s.setAllianceRole('g', 10, 'R');
    expect(s.getAllianceRoles('g').get(10)).toBe('R');
    s.setPending({ guildId: 'g', userId: 'u', world: 'en180', playerId: 5, code: 'GDAAAA', createdAt: 1 });
    expect(s.trackedWorlds()).toEqual(['en180', 'gr126']);
    s.setLink({ guildId: 'g', userId: 'u', world: 'en180', playerId: 5, verifiedAt: 2 });
    expect(s.linkForPlayer('g', 'en180', 5)?.userId).toBe('u');
    s.putFile('gr126', 'players', { etag: 'e', lastModified: null, body: 'Πόλη,1', fetchedAt: 3 });
    expect(s.getFile('gr126', 'players')?.body).toBe('Πόλη,1');
    s.replaceActivity('gr126', new Map([[1, { playerId: 1, points: 1, abp: 2, dbp: 3, towns: 4, lastChangeAt: 5, firstSeenAt: 6 }]]));
    expect(s.getActivity('gr126').get(1)?.firstSeenAt).toBe(6);
    expect(s.removeFeed('g', id)).toBe(true);
    expect(s.removeFeed('other', 999)).toBe(false);
  });
});

describe('misc', () => {
  it('validates world ids against configured markets', () => {
    expect(isValidWorldId('gr126', ['gr', 'en'])).toBe(true);
    expect(isValidWorldId('de170', ['gr', 'en'])).toBe(false);
    expect(isValidWorldId('gr126.evil.com', ['gr', 'en'])).toBe(false);
  });
  it('escapes markdown in names', () => {
    expect(md('*Mariw*')).toBe('\\*Mariw\\*');
  });
});
