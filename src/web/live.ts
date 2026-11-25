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
import { describeCommand } from './cmdKind.js';

export type { LiveEnd, LiveCommand, LiveIntel, LiveTeam, LiveView } from './types.js';
import type { LiveCommand, LiveEnd, LiveIntel, LiveProblem, LiveTeam, LiveView } from './types.js';

interface GuildLive {
  world: string | null; viewerAt: number; timer: NodeJS.Timeout | null; busy: boolean; polls: number;
  teams: LiveTeam[]; teamsAt: number; cmds: Map<string, Map<string, GdSharedCommand>>; since: Map<string, number>;
  overview: Map<string, { at: number; data: GdIndexOverview }>; updatedAt: number | null; err: { key: StringKey; vars: Record<string, string | number> } | null;
  failures: number; lastPollAt: number | null; nextPollAt: number | null; intervalSec: number; lastCount: number | null; lastLog: string;
  /** Last read by a chat board / tracker (polls slowly, at most once a minute, while only these watch). */
  passiveAt: number; manualAt: number; allTeams: LiveTeam[];
}
/** Per-guild overrides from the admin panel (poll speed, which command-share teams to follow). */
export interface LiveGuildOpts { pollSeconds?: number | null; teams?: string[] | null }
export const MANUAL_COOLDOWN_MS = 10_000;
export const PASSIVE_IDLE_MS = 3 * 60_000;
export const PASSIVE_MIN_SEC = 60;
/** Manual refresh gate: one per guild every 10 s, never while a poll runs. Returns the wait in ms (0 = go). */
export function manualWait(lastAt: number, busy: boolean, now: number, cooldown = MANUAL_COOLDOWN_MS): number {
  if (busy) return 1000;
  return Math.max(0, lastAt + cooldown - now);
}

/** Which kind of problem an error key is, for the client banner. */
export function problemOf(key: StringKey | null | undefined): LiveProblem | null {
  if (!key) return null;
  if (key === 'web.err.noTeams') return 'noTeams';
  if (key === 'web.err.busy' || key === 'gd.rateLimited') return 'busy';
  if (key === 'web.err.notSetup') return 'notSetup';
  if (key === 'intel.refreshFailed') return 'refresh';
  if (key === 'intel.noToken' || key === 'intel.expired' || key === 'intel.rejected' || key === 'gd.auth') return 'token';
  return 'other';
}
/**
 * Seconds between polls: LIVE_POLL_SECONDS, stretched so `teams` command pulls per minute leave one request/min spare
 * for the team list and overview inside LIVE_RPM; doubled per consecutive failure (rate limit: at least 60 s), max 120 s.
 */
export function pollInterval(pollSeconds: number, rpm: number, teams: number, failures: number, rateLimited = false): number {
  const base = Math.max(pollSeconds, Math.ceil((60 * Math.max(1, teams)) / Math.max(1, rpm - 1)));
  if (!failures) return base;
  return Math.min(120, Math.max(rateLimited ? 60 : 0, base * 2 ** Math.min(failures, 5)));
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
    town: str(c[`${p}_twn_n`]), townId: num(c[`${p}_twn_id`]) || null, player: str(c[`${p}_ply_n`]), playerId: num(c[`${p}_ply_id`]) || null,
    alliance: str(c[`${p}_all_n`]), allianceId: num(c[`${p}_all_id`]) || null,
  });
  const src = end('src'), trg = end('trg');
  const srcOurs = src.allianceId !== null && ours.has(src.allianceId);
  const trgOurs = trg.allianceId !== null && ours.has(trg.allianceId);
  const spy = str(c.type) === 'attack_spy';
  return {
    id: str(c.es_id) || `${str(c.cmd_id)}:${str(c.arrival_at)}`, type: str(c.type), sub: str(c.subtype), arrival: Number(c.arrival_at) || 0, started: num(c.started_at), src, trg,
    units: spy ? [] : normUnits(c.units), by: str(c.upload_n), own: !!c.own_command, ret: !!c.return, planned: !!c.is_planned,
    side: trgOurs && !srcOurs ? 'in' : srcOurs && !trgOurs ? 'out' : 'other',
    strat: str(c.attacking_strategy), deleted: !!c.delete_status && c.delete_status !== '', silver: spy ? num(c.units) : null,
  };
}

export type DropReason = 'deleted' | 'arrived' | 'departed';
/**
 * Everything GrepoData would show, soonest first (by countdown: an arising revolt counts down to its phase 2 start).
 * Exactly GrepoData's own rules: only hard-deleted commands, commands that already arrived (60 s grace) and planned
 * commands whose departure passed are left out. No side, type or direction filtering here: that is the viewer's own
 * view filters. (`cancel_human` is "cancelable until" / planned departure / revolt phase 2, never a cancellation.)
 */
export function activeCommands(all: Iterable<GdSharedCommand>, ours: Set<number>, nowSec: number, limit = 5000): LiveCommand[] {
  return selectCommands(all, ours, nowSec, limit).commands;
}
export function selectCommands(all: Iterable<GdSharedCommand>, ours: Set<number>, nowSec: number, limit = 5000): { commands: LiveCommand[]; fetched: number; dropped: Record<DropReason, number>; cut: number } {
  const out: { c: LiveCommand; at: number }[] = [];
  const dropped: Record<DropReason, number> = { deleted: 0, arrived: 0, departed: 0 };
  const seen = new Set<string>();
  let fetched = 0;
  for (const raw of all) {
    if (!raw) continue;
    fetched++;
    if (raw.delete_status === 'hard') { dropped.deleted++; continue; }
    const c = toLiveCommand(raw, ours);
    if (!(c.arrival >= nowSec - 60)) { dropped.arrived++; continue; }
    if (c.planned && c.started !== null && c.started > 0 && c.started <= nowSec) { dropped.departed++; continue; }
    const dk = raw.cmd_id ? `${raw.cmd_id}|${c.arrival}` : c.id; // GrepoData ids include the team: the same command shared in two of our teams
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({ c, at: describeCommand(c, nowSec).countdownAt });
  }
  out.sort((a, b) => a.at - b.at || (a.c.started ?? 0) - (b.c.started ?? 0));
  return { commands: out.slice(0, limit).map((x) => x.c), fetched, dropped, cut: Math.max(0, out.length - limit) };
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
  /** Admin-panel overrides per guild (set by the web app); default none. */
  guildOpts: (guildId: string) => LiveGuildOpts = () => ({});
  constructor(private ctx: Ctx, private sides: (guildId: string, world: string) => Promise<number[]>, private opts = { pollSeconds: config.livePollSeconds, rpm: config.liveRpm, now: Date.now }) {
    this.budget = new Budget(opts.rpm, opts.now);
  }
  private pollSecondsOf(guildId: string): number {
    const v = Number(this.guildOpts(guildId).pollSeconds);
    return Number.isFinite(v) && v > 0 ? Math.min(120, Math.max(3, Math.round(v))) : this.opts.pollSeconds;
  }
  private watched(s: GuildLive): 'active' | 'passive' | null {
    const n = this.opts.now();
    if (n - s.viewerAt <= IDLE_AFTER) return 'active';
    if (n - s.passiveAt <= PASSIVE_IDLE_MS) return 'passive';
    return null;
  }
  /** "Refresh now" (Discord button / web button): one per guild every 10 s, inside the same GrepoData budget. */
  refreshNow(guildId: string): { ok: true } | { ok: false; waitMs: number } {
    const s = this.state(guildId);
    const wait = manualWait(s.manualAt, s.busy, this.opts.now());
    if (wait > 0) return { ok: false, waitMs: wait };
    s.manualAt = this.opts.now();
    s.viewerAt = Math.max(s.viewerAt, this.opts.now() - IDLE_AFTER + 30_000); // keep it alive for 30 s
    this.schedule(guildId, 0);
    return { ok: true };
  }
  /** Admin panel: clear errors/backoff and poll again now (also re-reads the team list). */
  restart(guildId: string) {
    const s = this.state(guildId);
    s.err = null; s.failures = 0; s.teamsAt = 0; s.manualAt = 0;
    s.viewerAt = Math.max(s.viewerAt, this.opts.now() - IDLE_AFTER + 30_000);
    if (!s.busy) this.schedule(guildId, 0);
  }
  /** Health summary for the admin panel. */
  health(guildId: string) {
    const s = this.g.get(guildId);
    if (!s) return { state: 'idle', lastPollAt: null, lastOkAt: null, nextPollAt: null, intervalSec: this.pollSecondsOf(guildId), teams: [] as LiveTeam[], allTeams: [] as LiveTeam[], error: null as string | null, failures: 0, watched: null as string | null, budgetUsed: this.budget.used() };
    return { state: s.err ? 'error' : s.updatedAt ? 'ok' : 'warming', lastPollAt: s.lastPollAt, lastOkAt: s.updatedAt, nextPollAt: s.nextPollAt, intervalSec: s.intervalSec || this.pollSecondsOf(guildId),
      teams: s.teams, allTeams: s.allTeams, error: s.err ? s.err.key : null, failures: s.failures, watched: this.watched(s), budgetUsed: this.budget.used() };
  }

  /** The cached snapshot for a guild; marks a viewer so polling starts (or keeps running). Never calls GrepoData itself. */
  async view(guildId: string, lang: Lang, passive = false): Promise<LiveView> {
    const s = this.state(guildId);
    if (passive) s.passiveAt = this.opts.now(); else s.viewerAt = this.opts.now();
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
    const problem = problemOf(s.err?.key);
    return {
      status: {
        state: problem === 'busy' ? 'throttled' : s.err ? 'error' : s.updatedAt === null ? 'warming' : 'ok',
        problem, lastPollAt: s.lastPollAt, lastOkAt: s.updatedAt, nextPollAt: s.nextPollAt, intervalSec: s.intervalSec || this.opts.pollSeconds, serverNow: this.opts.now(),
      },
      world, updatedAt: s.updatedAt, pollSeconds: s.intervalSec || this.opts.pollSeconds, teams: s.teams,
      commands: activeCommands(all, ours, Math.floor(this.opts.now() / 1000)), intel: intel.slice(0, 25), conquests: conquests.slice(0, 12), stats,
      error: s.err ? t(lang, s.err.key, s.err.vars) : null, warming: s.updatedAt === null && !s.err,
    };
  }

  /** Alliances seen in the cached command share: who uploads its own commands (us) and who sends attacks at us. */
  liveSides(guildId: string): { own: number[]; attackers: number[] } {
    const s = this.g.get(guildId);
    const own = new Map<number, number>(), att = new Map<number, number>();
    for (const m of s?.cmds.values() ?? []) for (const c of m.values()) {
      const sa = num(c.src_all_id), ta = num(c.trg_all_id);
      if (c.own_command && sa) own.set(sa, (own.get(sa) ?? 0) + 1);
      else if (!c.own_command && sa && ta && /attack|takeover|conquer|revolt/i.test(str(c.type))) att.set(sa, (att.get(sa) ?? 0) + 1);
    }
    const top = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    return { own: top(own), attackers: top(att) };
  }

  stop() { for (const s of this.g.values()) { if (s.timer) clearTimeout(s.timer); s.timer = null; } }

  private state(guildId: string): GuildLive {
    let s = this.g.get(guildId);
    if (!s) {
      s = { world: null, viewerAt: 0, timer: null, busy: false, polls: 0, teams: [], teamsAt: 0, cmds: new Map(), since: new Map(), overview: new Map(), updatedAt: null, err: null,
        failures: 0, lastPollAt: null, nextPollAt: null, intervalSec: 0, lastCount: null, lastLog: '', passiveAt: 0, manualAt: 0, allTeams: [] };
      this.g.set(guildId, s);
    }
    return s;
  }

  private schedule(guildId: string, ms: number) {
    const s = this.state(guildId);
    if (s.timer) clearTimeout(s.timer);
    s.nextPollAt = this.opts.now() + ms;
    s.timer = setTimeout(() => { s.timer = null; void this.tick(guildId); }, ms);
    s.timer.unref?.();
  }

  /** One poll round. Public for tests. */
  async tick(guildId: string): Promise<void> {
    const s = this.state(guildId);
    if (s.busy) return;
    if (!this.watched(s)) { log.debug(`live: guild ${guildId} idle, polling paused`); return; }
    s.busy = true;
    s.lastPollAt = this.opts.now();
    try {
      await this.poll(guildId, s);
    } catch (e) {
      const c = classifyError(e);
      if (problemOf(c.key) !== 'token') logError(`live poll ${guildId}`, e, c);
      s.err = { key: c.key, vars: c.vars };
    } finally {
      s.busy = false;
      const p = problemOf(s.err?.key);
      // A full budget is not a failure (just wait); token/team problems and errors back off.
      s.failures = s.err && p !== 'busy' ? s.failures + 1 : 0;
      s.intervalSec = pollInterval(this.pollSecondsOf(guildId), this.opts.rpm, s.teams.length, s.failures, s.err?.key === 'gd.rateLimited');
      this.logResult(guildId, s);
      const w = this.watched(s);
      // Only a chat board is reading: poll at most once a minute (stays well inside the budget).
      if (w) this.schedule(guildId, (w === 'passive' ? Math.max(PASSIVE_MIN_SEC, s.intervalSec) : s.intervalSec) * 1000);
      else s.nextPollAt = null;
    }
  }

  /** One log line when the result changes (count, teams or error), not on every 5 s poll. */
  private logResult(guildId: string, s: GuildLive) {
    const all: GdSharedCommand[] = [];
    for (const m of s.cmds.values()) all.push(...m.values());
    const sel = selectCommands(all, new Set(), Math.floor(this.opts.now() / 1000));
    const count = sel.commands.length;
    const drops = Object.entries(sel.dropped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
    const line = s.err ? `error ${s.err.key}` : `${count} active command(s) in ${s.teams.length} team(s) (fetched ${sel.fetched}, shown ${count}${drops ? `, dropped: ${drops}` : ''}${sel.cut ? `, cut ${sel.cut}` : ''})`;
    if (line === s.lastLog) { log.debug(`live: guild ${guildId} ${s.world ?? '-'}: ${line}`); return; }
    s.lastLog = line;
    const delta = !s.err && s.lastCount !== null && s.lastCount !== count ? ` (${count > s.lastCount ? '+' : ''}${count - s.lastCount})` : '';
    if (!s.err) s.lastCount = count;
    (s.err ? log.warn : log.info)(`live: guild ${guildId} ${s.world ?? '-'}: ${line}${delta}; next poll in ${s.intervalSec}s`);
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
      const pick = this.guildOpts(guildId).teams;
      s.allTeams = (r.value?.operations ?? []).filter((o) => o.world === world && o.index).map((o) => ({ key: o.index, name: str(o.team) || o.index, commands: Number(o.commands) || 0, players: Number(o.players) || 0 }));
      const ops = (r.value?.operations ?? []).filter((o) => o.world === world && o.index && o.active !== false && (!pick?.length || pick.includes(o.index))).slice(0, MAX_TEAMS);
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
      for (const c of v.items ?? []) if (c && (c.es_id || c.cmd_id)) m.set(String(c.es_id || `${c.cmd_id}:${c.arrival_at}`), c);
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
