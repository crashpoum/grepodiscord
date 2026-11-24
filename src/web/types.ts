/** Shapes shared by the server and the browser bundle (no runtime code, no node imports). */
export interface LiveEnd { town: string; townId: number | null; player: string; playerId: number | null; alliance: string; allianceId: number | null }
export interface LiveCommand { id: string; type: string; sub: string; arrival: number; started: number | null; src: LiveEnd; trg: LiveEnd; units: [string, number][]; by: string; own: boolean; ret: boolean; planned: boolean; side: 'in' | 'out' | 'other' }
export interface LiveIntel { townId: number | null; town: string; player: string; alliance: string; date: string; units: [string, number][] }
export interface LiveTeam { key: string; name: string; commands: number; players: number }
export interface LiveView {
  world: string | null; updatedAt: number | null; pollSeconds: number; teams: LiveTeam[]; commands: LiveCommand[]; intel: LiveIntel[];
  conquests: { townId: number | null; town: string; player: string; alliance: string; by: string; date: string }[];
  stats: { reports: number; spies: number; attacks: number } | null; error: string | null; warming: boolean;
  /** GrepoData poll status for the header/banner. Times are ms epoch. */
  status: LiveStatus;
}
export type LiveProblem = 'token' | 'refresh' | 'noTeams' | 'busy' | 'notSetup' | 'other';
export interface LiveStatus {
  state: 'ok' | 'warming' | 'error' | 'throttled';
  problem: LiveProblem | null;
  lastPollAt: number | null; lastOkAt: number | null; nextPollAt: number | null;
  /** Effective seconds between polls (LIVE_POLL_SECONDS, stretched to stay inside LIVE_RPM, longer while backing off). */
  intervalSec: number;
  serverNow: number;
}


export interface MapPayload {
  world: string; generatedAt: number;
  /** [id, islandX, islandY, slot, playerId(0 = ghost), points, name] */
  towns: [number, number, number, number, number, number, string][];
  /** [id, name, allianceId(0 = none), points] */
  players: [number, string, number, number][];
  /** [id, name, points, towns] */
  alliances: [number, string, number, number][];
  /** ours = the server's own alliance(s), allies = /war ally pacts, enemies = /war enemy or auto. `auto` says how they were found. */
  sides: { ours: number[]; allies: number[]; enemies: number[]; source: 'set' | 'verified' | 'roles' | 'live' | 'none' };
  /** [unixSeconds, townId, newPlayerId, oldPlayerId, newAllianceId, oldAllianceId] (0 = none), oldest first */
  conquests: [number, number, number, number, number, number][];
  /** Daily alliance towns history from the bot's own records: { day: { allianceId: towns } } (last 40 days). */
  history: Record<string, Record<number, number>>;
  me: number | null;
}

