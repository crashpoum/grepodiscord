import { describe, expect, it } from 'vitest';
import { findGhostTowns, findInactive } from '../src/radar.js';
import type { Activity } from '../src/diff.js';
import { snap } from './helpers.js';

const s = snap();
const H = 3600;
const act = (id: number, lastChangeAt: number, firstSeenAt = 0): [number, Activity] => [id, { playerId: id, points: 0, abp: 0, dbp: 0, towns: 0, lastChangeAt, firstSeenAt }];

describe('findInactive', () => {
  const now = 100 * H;
  const activity = new Map([act(1, now - 50 * H), act(2, now - 10 * H), act(3, now - 72 * H)]);
  it('returns players idle for >= hours, sorted by idle time', () => {
    const r = findInactive(s, activity, { hours: 48, now });
    expect(r.hits.map((h) => [h.player.id, h.hoursInactive])).toEqual([[3, 72], [1, 50]]);
    expect(r.trackedHours).toBe(100);
  });
  it('filters by ocean and sorts by distance from a point within radius', () => {
    const r = findInactive(s, activity, { hours: 1, now, oceans: [45], near: { x: 455, y: 535 }, radius: 10 });
    expect(r.hits.map((h) => h.player.id)).toEqual([3, 1]);
    expect(r.hits[0].dist).toBe(0);
    expect(r.hits[1].town.id).toBe(100); // closest of Alice's towns
  });
  it('reports untracked candidates when tracking window is too short', () => {
    const young = new Map([act(1, now - 2 * H, now - 2 * H)]);
    const r = findInactive(s, young, { hours: 48, now });
    expect(r.hits).toEqual([]);
    expect(r.candidatesUntracked.map((c) => c.player.id).sort()).toEqual([1, 2, 3]);
    expect(r.candidatesUntracked.every((c) => c.town)).toBe(true);
  });
  it('respects minPoints and excluded alliances', () => {
    const r = findInactive(s, activity, { hours: 1, now, minPoints: 300, excludeAllianceIds: [10] });
    expect(r.hits.map((h) => h.player.id)).toEqual([2]);
  });
});

describe('findGhostTowns', () => {
  it('lists ghost towns by points or by distance', () => {
    expect(findGhostTowns(s, {}).map((g) => g.town.id)).toEqual([400, 401]);
    expect(findGhostTowns(s, { oceans: [81] }).map((g) => g.ocean)).toEqual([81]);
    const near = findGhostTowns(s, { near: { x: 450, y: 530 }, radius: 50 });
    expect(near.map((g) => g.town.id)).toEqual([400]);
    expect(near[0].dist).toBeCloseTo(Math.hypot(2, 2));
    expect(findGhostTowns(s, { minPoints: 500 }).map((g) => g.town.id)).toEqual([400]);
  });
});
