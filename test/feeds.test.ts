import { describe, expect, it } from 'vitest';
import { matchAllianceChange, matchBp, matchConquest, type FeedConfig } from '../src/feeds.js';
import { batchEmbeds, planFeedPosts, MAX_CONQUESTS_PER_REFRESH } from '../src/feedPlan.js';
import { computeEvents, type StateStore } from '../src/refresh.js';
import { MemoryFileStore } from '../src/data/official.js';
import type { Activity } from '../src/diff.js';
import { snap, files } from './helpers.js';
import { buildSnapshot } from '../src/data/snapshot.js';

const s = snap();
const [c1, c2, c3] = s.conquers; // c1: town100 (oc45) 3->1, alliance 20->10; c2: ghost->2 (oc18); c3: internal 3->3 in alliance 20

describe('matchConquest', () => {
  it('matches everything with an empty filter', () => {
    expect([c1, c2, c3].every((c) => matchConquest({}, c, s))).toBe(true);
  });
  it('filters by alliance (either side), player, ocean, ghosts', () => {
    expect(matchConquest({ allianceIds: [20] }, c1, s)).toBe(true); // old alliance
    expect(matchConquest({ allianceIds: [10] }, c2, s)).toBe(false);
    expect(matchConquest({ playerIds: [2] }, c2, s)).toBe(true);
    expect(matchConquest({ oceans: [45] }, c1, s)).toBe(true);
    expect(matchConquest({ oceans: [45] }, c2, s)).toBe(false);
    expect(matchConquest({ allianceIds: [10], oceans: [18] }, c1, s)).toBe(false); // ocean narrows
    expect(matchConquest({ skipGhosts: true }, c2, s)).toBe(false);
  });
});

describe('matchAllianceChange / matchBp', () => {
  const ch = { kind: 'switch' as const, playerId: 3, playerName: 'C', fromAllianceId: 10, toAllianceId: 20, points: 1 };
  it('alliance filter matches from or to', () => {
    expect(matchAllianceChange({}, ch)).toBe(true);
    expect(matchAllianceChange({ allianceIds: [20] }, ch)).toBe(true);
    expect(matchAllianceChange({ allianceIds: [99] }, ch)).toBe(false);
    expect(matchAllianceChange({ playerIds: [3] }, ch)).toBe(true);
  });
  it('bp threshold, kind and alliance', () => {
    const d = { id: 1, kind: 'att' as const, delta: 6000, total: 9000 };
    expect(matchBp({}, d, s)).toBe(true); // default 5000
    expect(matchBp({ minBp: 7000 }, d, s)).toBe(false);
    expect(matchBp({ bpKind: 'def' }, d, s)).toBe(false);
    expect(matchBp({ allianceIds: [10] }, d, s)).toBe(true); // player 1 is in alliance 10
    expect(matchBp({ allianceIds: [20] }, d, s)).toBe(false);
  });
});

class MemState extends MemoryFileStore implements StateStore {
  last = new Map<string, number>();
  act = new Map<string, Map<number, Activity>>();
  getLastConquestTime(w: string) { return this.last.has(w) ? this.last.get(w)! : null; }
  setLastConquestTime(w: string, t: number) { this.last.set(w, t); }
  getActivity(w: string) { return this.act.get(w) ?? new Map(); }
  replaceActivity(w: string, a: Map<number, Activity>) { this.act.set(w, a); }
}

describe('computeEvents', () => {
  it('stores a baseline on first load (no spam), then reports only new events', () => {
    const st = new MemState();
    const first = computeEvents('en999', new Set(['players', 'conquers']), {}, s, st, 1000);
    expect(first.firstLoad).toBe(true);
    expect(first.conquests).toEqual([]);
    expect(st.getLastConquestTime('en999')).toBe(3000);
    expect(st.getActivity('en999').size).toBe(3);

    const nextFiles = files({
      players: ['1,Alice,10,1100,1,2', '2,Bob+the+Great,20,500,2,1', '3,Cara%27s,20,200,3,1'].join('\n'),
      conquers: files().conquers + '\n401,4000,1,,10,,300',
      player_kills_att: ['1,1,12000', '2,2,100'].join('\n'),
    });
    const next = buildSnapshot('en999', nextFiles);
    const ev = computeEvents('en999', new Set(['players', 'conquers', 'player_kills_att']), { players: files().players, conquers: files().conquers, player_kills_att: files().player_kills_att }, next, st, 4600);
    expect(ev.firstLoad).toBe(false);
    expect(ev.conquests.map((c) => c.townId)).toEqual([401]);
    expect(ev.allianceChanges).toEqual([expect.objectContaining({ kind: 'join', playerId: 2, toAllianceId: 20 })]);
    expect(ev.bp).toEqual([{ id: 1, kind: 'att', delta: 7000, total: 12000 }]);
    expect(st.getActivity('en999').get(1)?.lastChangeAt).toBe(4600);
    expect(st.getActivity('en999').get(3)?.lastChangeAt).toBe(1000);

    const feeds: FeedConfig[] = [
      { id: 1, guildId: 'g', channelId: 'c1', world: 'en999', type: 'conquests', filter: {} },
      { id: 2, guildId: 'g', channelId: 'c2', world: 'en999', type: 'alliance', filter: { allianceIds: [20] } },
      { id: 3, guildId: 'g', channelId: 'c3', world: 'en999', type: 'bp', filter: { minBp: 5000 } },
      { id: 4, guildId: 'g', channelId: 'c4', world: 'other1', type: 'conquests', filter: {} },
      { id: 5, guildId: 'g', channelId: 'c5', world: 'en999', type: 'bp', filter: { minBp: 50000 } },
    ];
    const posts = planFeedPosts(feeds, ev, () => 'el');
    expect(posts.map((p) => p.channelId)).toEqual(['c1', 'c2', 'c3']);
    expect(posts[0].embeds[0].title).toContain('Κατάκτηση');
    expect(posts[1].embeds[0].description).toContain('Bob the Great');
    expect(posts[2].embeds[0].description).toContain('+7.000');
  });

  it('caps conquest embeds per refresh and batches by 10', () => {
    const many = Array.from({ length: 45 }, (_, k) => `${100 + (k % 2)},${5000 + k},1,3,10,20,600`).join('\n');
    const sn = buildSnapshot('en999', files({ conquers: many }));
    const ev = { world: 'en999', snapshot: sn, conquests: sn.conquers, allianceChanges: [], bp: [], changedFiles: [], firstLoad: false };
    const [post] = planFeedPosts([{ id: 1, guildId: 'g', channelId: 'c', world: 'en999', type: 'conquests', filter: {} }], ev, () => 'en');
    expect(post.embeds).toHaveLength(MAX_CONQUESTS_PER_REFRESH + 1);
    expect(batchEmbeds(post.embeds).map((b) => b.length)).toEqual([10, 10, 10, 1]);
  });
});
