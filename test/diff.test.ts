import { describe, expect, it } from 'vitest';
import { allianceChanges, bpDeltas, maxConquestTime, newConquests, updateActivity } from '../src/diff.js';
import { parseConquers, parsePlayers } from '../src/data/parse.js';

const pmap = (s: string) => new Map(parsePlayers(s).map((p) => [p.id, p] as const));

describe('conquests', () => {
  const c = parseConquers('1,100,5,,,,1\n2,300,5,6,,,1\n3,200,5,6,,,1');
  it('returns only newer conquests, sorted by time', () => {
    expect(newConquests(c, 100).map((x) => x.townId)).toEqual([3, 2]);
    expect(newConquests(c, 300)).toEqual([]);
    expect(maxConquestTime(c)).toBe(300);
    expect(maxConquestTime([])).toBe(0);
  });
});

describe('allianceChanges', () => {
  it('detects join, leave, switch, deleted and new players joining', () => {
    const prev = pmap('1,A,,100,1,1\n2,B,10,90,2,1\n3,C,10,80,3,1\n4,D,20,70,4,1\n5,E,,60,5,1');
    const next = pmap('1,A,10,100,1,1\n2,B,,90,2,1\n3,C,20,80,3,1\n5,E,,61,5,1\n6,F,20,10,6,1');
    const ch = allianceChanges(prev, next);
    const byId = Object.fromEntries(ch.map((c) => [c.playerId, c]));
    expect(byId[1]).toMatchObject({ kind: 'join', fromAllianceId: null, toAllianceId: 10 });
    expect(byId[2]).toMatchObject({ kind: 'leave', fromAllianceId: 10, toAllianceId: null });
    expect(byId[3]).toMatchObject({ kind: 'switch', fromAllianceId: 10, toAllianceId: 20 });
    expect(byId[4]).toMatchObject({ kind: 'deleted', fromAllianceId: 20 });
    expect(byId[6]).toMatchObject({ kind: 'join', toAllianceId: 20 });
    expect(byId[5]).toBeUndefined();
    expect(ch.map((c) => c.points)).toEqual([...ch.map((c) => c.points)].sort((a, b) => b - a));
  });
  it('is empty for identical snapshots', () => {
    const s = pmap('1,A,10,100,1,1');
    expect(allianceChanges(s, s)).toEqual([]);
  });
});

describe('bpDeltas', () => {
  it('returns positive gains only, sorted desc, new ids from zero', () => {
    const prev = new Map([[1, 100], [2, 500], [3, 50]]);
    const next = new Map([[1, 1100], [2, 500], [3, 40], [4, 300]]);
    expect(bpDeltas(prev, next, 'att')).toEqual([
      { id: 1, kind: 'att', delta: 1000, total: 1100 },
      { id: 4, kind: 'att', delta: 300, total: 300 },
    ]);
  });
});

describe('updateActivity', () => {
  it('tracks last change time and first seen', () => {
    const p1 = pmap('1,A,,100,1,1\n2,B,,50,2,1');
    const a1 = updateActivity(new Map(), p1, new Map(), new Map(), 1000);
    expect(a1.get(1)).toMatchObject({ lastChangeAt: 1000, firstSeenAt: 1000 });
    // B grows, A idle; BP change for A counts as activity on the next step
    const a2 = updateActivity(a1, pmap('1,A,,100,1,1\n2,B,,60,2,1'), new Map(), new Map(), 5000);
    expect(a2.get(1)?.lastChangeAt).toBe(1000);
    expect(a2.get(2)?.lastChangeAt).toBe(5000);
    const a3 = updateActivity(a2, pmap('1,A,,100,1,1'), new Map([[1, 10]]), new Map(), 9000);
    expect(a3.get(1)?.lastChangeAt).toBe(9000);
    expect(a3.get(1)?.firstSeenAt).toBe(1000);
    expect(a3.has(2)).toBe(false); // deleted player dropped
  });
});
