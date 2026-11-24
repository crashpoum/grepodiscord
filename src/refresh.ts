/** Keeps world snapshots fresh and produces feed events after each data refresh. */
import { fetchWorldFiles, type FileStore } from './data/official.js';
import { buildSnapshot, WORLD_FILE_NAMES, type WorldFiles, type WorldSnapshot } from './data/snapshot.js';
import { parseConquers, parseKills, parsePlayers, killsMap } from './data/parse.js';
import { allianceChanges, bpDeltas, maxConquestTime, newConquests, updateActivity, type Activity, type AllianceChange, type BpDelta } from './diff.js';
import type { Conquest } from './data/parse.js';
import { log } from './log.js';

export interface StateStore extends FileStore {
  getLastConquestTime(world: string): number | null;
  setLastConquestTime(world: string, t: number): void;
  getActivity(world: string): Map<number, Activity>;
  replaceActivity(world: string, a: Map<number, Activity>): void;
}

const conquestKey = (c: Conquest) => `${c.townId}:${c.time}:${c.newPlayerId ?? 0}`;

export interface RefreshEvents {
  world: string;
  snapshot: WorldSnapshot;
  conquests: Conquest[];
  allianceChanges: AllianceChange[];
  bp: BpDelta[];
  changedFiles: string[];
  firstLoad: boolean;
}

export class WorldManager {
  private snaps = new Map<string, WorldSnapshot>();
  private lastRefresh = new Map<string, number>();
  private running = new Map<string, Promise<RefreshEvents>>();
  constructor(private store: StateStore, private fetchImpl: typeof fetch = fetch, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  get(world: string): WorldSnapshot | undefined { return this.snaps.get(world); }
  lastRefreshAt(world: string): number | undefined { return this.lastRefresh.get(world); }

  /** Build a snapshot from cached files without network (fast startup). */
  loadFromCache(world: string): boolean {
    const f: Partial<WorldFiles> = {};
    for (const name of WORLD_FILE_NAMES) {
      const c = this.store.getFile(world, name);
      if (!c) { if (name.startsWith('alliance_kills')) continue; return false; }
      f[name] = c.body;
    }
    this.snaps.set(world, buildSnapshot(world, f as WorldFiles));
    return true;
  }

  /** Ensure a snapshot exists (loads cache, else fetches). */
  async ensure(world: string): Promise<WorldSnapshot> {
    const s = this.snaps.get(world);
    if (s) return s;
    if (this.loadFromCache(world)) return this.snaps.get(world)!;
    return (await this.refresh(world)).snapshot;
  }

  refresh(world: string): Promise<RefreshEvents> {
    const r = this.running.get(world);
    if (r) return r;
    const p = this.doRefresh(world).finally(() => this.running.delete(world));
    this.running.set(world, p);
    return p;
  }

  private async doRefresh(world: string): Promise<RefreshEvents> {
    const res = await fetchWorldFiles(world, this.store, this.fetchImpl);
    const snapshot = buildSnapshot(world, res.current as WorldFiles);
    this.snaps.set(world, snapshot);
    const now = this.now();
    this.lastRefresh.set(world, now);
    const ev = computeEvents(world, res.changed, res.previous, snapshot, this.store, now);
    log.info(`[${world}] refreshed: ${snapshot.players.size} players, ${snapshot.towns.size} towns; events: ${ev.conquests.length} conquests, ${ev.allianceChanges.length} alliance changes, ${ev.bp.length} bp deltas`);
    return ev;
  }
}

/** Pure-ish event computation (uses store for baselines/activity). Exported for tests and the CLI. */
export function computeEvents(world: string, changed: Set<string>, previous: Partial<Record<string, string>>, snapshot: WorldSnapshot, store: StateStore, now: number): RefreshEvents {
  let firstLoad = false;
  // Conquests: baseline = newest conquest we have already reported.
  let conquests: Conquest[] = [];
  const maxT = maxConquestTime(snapshot.conquers);
  const last = store.getLastConquestTime(world);
  if (last === null) { firstLoad = true; store.setLastConquestTime(world, maxT); }
  else if (changed.has('conquers') && previous.conquers !== undefined) {
    // Set difference against the previous file version: catches conquests that are published late with a
    // timestamp older than the newest one we already saw.
    const seen = new Set(parseConquers(previous.conquers).map(conquestKey));
    conquests = snapshot.conquers.filter((c) => !seen.has(conquestKey(c))).sort((a, b) => a.time - b.time || a.townId - b.townId);
    store.setLastConquestTime(world, Math.max(last, maxT));
  } else if (maxT > last) { conquests = newConquests(snapshot.conquers, last); store.setLastConquestTime(world, maxT); }

  // Alliance membership changes (only when players file changed and we have a previous version).
  let ac: AllianceChange[] = [];
  if (changed.has('players') && previous.players !== undefined) {
    const prev = new Map(parsePlayers(previous.players).map((p) => [p.id, p] as const));
    ac = allianceChanges(prev, snapshot.players);
  }

  // BP deltas per kills file.
  const bp: BpDelta[] = [];
  if (changed.has('player_kills_att') && previous.player_kills_att !== undefined) bp.push(...bpDeltas(killsMap(parseKills(previous.player_kills_att)), snapshot.playerAbp, 'att'));
  if (changed.has('player_kills_def') && previous.player_kills_def !== undefined) bp.push(...bpDeltas(killsMap(parseKills(previous.player_kills_def)), snapshot.playerDbp, 'def'));
  bp.sort((a, b) => b.delta - a.delta);

  // Activity tracking (for the inactive radar).
  if (changed.size > 0 || store.getActivity(world).size === 0) {
    const act = updateActivity(store.getActivity(world), snapshot.players, snapshot.playerAbp, snapshot.playerDbp, now);
    store.replaceActivity(world, act);
  }
  return { world, snapshot, conquests, allianceChanges: ac, bp, changedFiles: [...changed], firstLoad };
}
