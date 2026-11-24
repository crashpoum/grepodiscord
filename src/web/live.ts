/**
 * Live window data hub: polls GrepoData command share + index overview with the guild's own token, ONLY while
 * someone is watching, caches the result server-side and fans the same snapshot out to every viewer.
 * Budget: the hub never spends more than LIVE_RPM requests/minute (on top of the client-wide GREPODATA_RPM cap),
 * so viewers can't push the bot over GrepoData's limits no matter how many tabs are open.
 */
import type { Ctx } from '../services.js';
import { withGuildToken } from '../gdServices.js';
import type { GdIndexOverview, GdSharedCommand } from '../data/grepodata.js';
import { classifyError, logError } from '../bot/errors.js';
import { t, type Lang, type StringKey } from '../i18n.js';
import { config } from '../config.js';
import { log } from '../log.js';

export type { LiveEnd, LiveCommand, LiveIntel, LiveTeam, LiveView } from './types.js';
import type { LiveCommand, LiveEnd, LiveIntel, LiveTeam, LiveView } from './types.js';

interface GuildLive {
  world: string | null; viewerAt: number; timer: NodeJS.Timeout | null; busy: boolean; polls: number;
  teams: LiveTeam[]; teamsAt: number; cmds: Map<string, Map<string, GdSharedCommand>>; since: Map<string, number>;
  overview: Map<string, { at: number; data: GdIndexOverview }>; updatedAt: number | null; err: { key: StringKey; vars: Record<string, string | number> } | null;
}

const TEAMS_EVERY = 5 * 60_000;
const OVERVIEW_EVERY = 5 * 60_000;
const IDLE_AFTER = 90_000;
const MAX_TEAMS = 3;
const FULL_RESYNC_EVERY = 15; // polls

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export function normUnits(u: unknown): [string, number][] {
  let v = u;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  const out: [string, number][] = [];
  if (Array.isArray(v)) {
    for (const x of v) { const o = x as { name?: unknown; count?: unknown }; const n = num(o?.count); if (o?.name && n) out.push([String(o.name), n]); }
  } else if (v && typeof v === 'object') {
    for (const [k, c] of Object.entries(v)) { const n = num(c); if (n) out.push([k, n]); }
  }
  return out.slice(0, 20);
}

export function toLiveCommand(c: GdSharedCommand, ours: Set<number>): LiveCommand {
  const end = (p: 'src' | 'trg'): LiveEnd => ({
    town: str(c[`${p}_twn_n`]), townId: num(c[`${p}_twn_id`]), player: str(c[`${p}_ply_n`]), playerId: num(c[`${p}_ply_id`]),
    alliance: str(c[`${p}_all_n`]), allianceId: num(c[`${p}_all_id`]),
  });
  const src = end('src'), trg = end('trg');
  const srcOurs = src.allianceId !== null && ours.has(src.allianceId);
  const trgOurs = trg.allianceId !== null && ours.has(trg.allianceId);
  return {
    id: str(c.es_id), type: str(c.type), sub: str(c.subtype), arrival: Number(c.arrival_at) || 0, started: num(c.started_at), src, trg,
    units: normUnits(c.units), by: str(c.upload_n), own: !!c.own_command, ret: !!c.return, planned: !!c.is_planned,
    side: trgOurs && !srcOurs ? 'in' : srcOurs && !trgOurs ? 'out' : 'other',
  };
}

/** Commands still relevant: not deleted/cancelled and arriving no earlier than 60 s ago; soonest first. */
export function activeCommands(all: Iterable<GdSharedCommand>, ours: Set<number>, nowSec: number, limit = 300): LiveCommand[] {
  const out: LiveCommand[] = [];
  for (const c of all) {
    if (c.delete_status === 'hard' || c.delete_status === 'soft' || c.cancel_human) continue;
    if (!(Number(c.arrival_at) >= nowSec - 60)) continue;
    out.push(toLiveCommand(c, ours));
  }
  return out.sort((a, b) => a.arrival - b.arrival).slice(0, limit);
}

export class Budget {
  private stamps: number[] = [];
  constructor(private perMinute: number, private now = Date.now) {}
  used() { const n = this.now(); this.stamps = this.stamps.filter((s) => n - s < 60_000); return this.stamps.length; }
  take(n = 1): boolean { if (this.used() + n > this.perMinute) return false; for (let i = 0; i < n; i++) this.stamps.push(this.now()); return true; }
}

export class LiveHub {
  private g = new Map<string, GuildLive>();
  readonly budget: Budget;
  constructor(private ctx: Ctx, private sides: (guildId: string, world: string) => Promise<number[]>, private opts = { pollSeconds: config.livePollSeconds, rpm: config.liveRpm, now: Date.now }) {
    this.budget = new Budget(opts.rpm, opts.now);
  }

  /** The cached snapshot for a guild; marks a viewer so polling starts (or keeps running). Never calls GrepoData itself. */
  async view(guildId: string, lang: Lang): Promise<LiveView> {
    const s = this.state(guildId);
    s.viewerAt = this.opts.now();
    if (!s.timer && !s.busy) this.schedule(guildId, 0);
    const world = s.world ?? this.ctx.store.getGuild(guildId).world;
    const ours = new Set(world ? await this.sides(guildId, world).catch(() => [] as number[]) : []);
    const all: GdSharedCommand[] = [];
    for (const m of s.cmds.values()) all.push(...m.values());
    const ovs = [...s.overview.values()].map((o) => o.data);
    const intel: LiveIntel[] = [];
    const conquests: LiveView['conquests'] = [];
    let stats = null as LiveView['stats'];
    for (const o of ovs) {
      const prev = stats ?? { reports: 0, spies: 0, attacks: 0 };
      stats = { reports: prev.reports + (Number(o.total_reports) || 0), spies: prev.spies + (Number(o.spy_reports) || 0), attacks: prev.attacks + (Number(o.enemy_attacks) || 0) };
      for (const x of o.latest_intel ?? []) intel.push({ townId: num(x.town_id), town: str(x.town_name), player: str(x.player_name), alliance: str(x.alliance_name), date: str(x.date), units: normUnits(x.units) });
      for (const x of o.recent_conquests ?? []) conquests.push({ townId: num(x.town_id), town: str(x.town_name), player: str(x.player_name), alliance: str(x.alliance_name), by: str(x.belligerent_alliance_name ?? x.belligerent_player_name), date: str(x.last_attack_date) });
    }
    return {
      world, updatedAt: s.updatedAt, pollSeconds: this.opts.pollSeconds, teams: s.teams,
      commands: activeCommands(all, ours, Math.floor(this.opts.now() / 1000)), intel: intel.slice(0, 25), conquests: conquests.slice(0, 12), stats,
      error: s.err ? t(lang, s.err.key, s.err.vars) : null, warming: s.updatedAt === null && !s.err,
    };
  }

  stop() { for (const s of this.g.values()) { if (s.timer) clearTimeout(s.timer); s.timer = null; } }

  private state(guildId: string): GuildLive {
    let s = this.g.get(guildId);
    if (!s) {
      s = { world: null, viewerAt: 0, timer: null, busy: false, polls: 0, teams: [], teamsAt: 0, cmds: new Map(), since: new Map(), overview: new Map(), updatedAt: null, err: null };
      this.g.set(guildId, s);
    }
    return s;
  }

  private schedule(guildId: string, ms: number) {
    const s = this.state(guildId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; void this.tick(guildId); }, ms);
    s.timer.unref?.();
  }

  /** One poll round. Public for tests. */
  async tick(guildId: string): Promise<void> {
    const s = this.state(guildId);
    if (s.busy) return;
    if (this.opts.now() - s.viewerAt > IDLE_AFTER) { log.debug(`live: guild ${guildId} idle, polling paused`); return; }
    s.busy = true;
    try {
      await this.poll(guildId, s);
    } catch (e) {
      const c = classifyError(e);
      logError(`live poll ${guildId}`, e, c);
      s.err = { key: c.key, vars: c.vars };
    } finally {
      s.busy = false;
      if (this.opts.now() - s.viewerAt <= IDLE_AFTER) this.schedule(guildId, this.opts.pollSeconds * 1000);
    }
  }

  private async poll(guildId: string, s: GuildLive) {
    const world = this.ctx.store.getGuild(guildId).world;
    if (!world) { s.err = { key: 'web.err.notSetup', vars: {} }; return; }
    if (world !== s.world) { s.world = world; s.teams = []; s.teamsAt = 0; s.cmds.clear(); s.since.clear(); s.overview.clear(); s.updatedAt = null; }
    const now = this.opts.now();
    const gd = this.ctx.gd;
    if (now - s.teamsAt > TEAMS_EVERY) {
      if (!this.budget.take()) { s.err = { key: 'web.err.busy', vars: {} }; return; }
      const r = await withGuildToken(this.ctx, guildId, '', (tok) => gd.commandTeams(tok, guildId));
      s.teamsAt = now;
      const ops = (r.value?.operations ?? []).filter((o) => o.world === world && o.index && o.active !== false).slice(0, MAX_TEAMS);
      s.teams = ops.map((o) => ({ key: o.index, name: str(o.team) || o.index, commands: Number(o.commands) || 0, players: Number(o.players) || 0 }));
      for (const k of [...s.cmds.keys()]) if (!s.teams.some((x) => x.key === k)) { s.cmds.delete(k); s.since.delete(k); s.overview.delete(k); }
    }
    if (!s.teams.length) { s.err = { key: 'web.err.noTeams', vars: { world } }; s.updatedAt = now; return; }
    s.err = null;
    s.polls++;
    for (const team of s.teams) {
      if (!this.budget.take()) { s.err = { key: 'web.err.busy', vars: {} }; break; }
      const full = s.polls % FULL_RESYNC_EVERY === 1 || !s.since.has(team.key);
      const r = await withGuildToken(this.ctx, guildId, '', (tok) => gd.commandsGet(tok, guildId, team.key, full ? 0 : s.since.get(team.key) ?? 0));
      const v = r.value;
      if (!v) { s.cmds.set(team.key, new Map()); s.since.delete(team.key); continue; } // 8020: no active commands
      if (v.updated_at) s.since.set(team.key, Number(v.updated_at));
      if (v.success_code === 8010) continue;
      const m = full ? new Map<string, GdSharedCommand>() : s.cmds.get(team.key) ?? new Map<string, GdSharedCommand>();
      for (const c of v.items ?? []) if (c?.es_id) m.set(String(c.es_id), c);
      const cutoff = Math.floor(now / 1000) - 300;
      for (const [id, c] of m) if (Number(c.arrival_at) < cutoff || c.delete_status === 'hard') m.delete(id);
      s.cmds.set(team.key, m);
    }
    for (const team of s.teams) {
      const o = s.overview.get(team.key);
      if (o && now - o.at < OVERVIEW_EVERY) continue;
      if (!this.budget.take()) break;
      const r = await withGuildToken(this.ctx, guildId, '', (tok) => gd.indexOverview(tok, guildId, team.key));
      if (r.value) s.overview.set(team.key, { at: now, data: r.value });
      else s.overview.delete(team.key);
    }
    s.updatedAt = now;
  }
}
