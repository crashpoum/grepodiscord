/**
 * Map town-click side panel: one town's owner, ownership history (public conquests), the owner's activity clock and,
 * when the viewer may see them, synced troops and synced incoming commands for that town. All from data the bot
 * already has (world files, its own DB); nothing is fetched for it.
 */
import type { Ctx } from '../services.js';
import type { GgService } from './ggTroops.js';
import type { GgTown } from './ggCore.js';
import type { IncomingCmd } from './syncFeeds.js';

export interface TownPanel {
  id: number; name: string; points: number; ix: number; iy: number;
  owner: { id: number; name: string; points: number; towns: number } | null;
  alliance: { id: number; name: string } | null;
  /** [unix s, newPlayerName, oldPlayerName] newest first. */
  history: [number, string, string][];
  /** Score changes per hour of day (UTC 0..23) of the owner, from the bot's hourly world refreshes. */
  clock: number[] | null;
  troops: { player: string; ts: number; town: GgTown } | null;
  incoming: { player: string; cmd: IncomingCmd }[] | null;
}

export async function townPanel(ctx: Ctx, gg: GgService, guildId: string, world: string, userId: string, townId: number, may: { troops: boolean; alerts: boolean }): Promise<TownPanel | null> {
  if (!Number.isInteger(townId) || townId <= 0) return null;
  const snap = await ctx.worlds.ensure(world);
  const tw = snap.towns.get(townId);
  if (!tw) return null;
  const pn = (id: number | null) => (id ? snap.players.get(id)?.name ?? `#${id}` : '');
  const p = tw.playerId ? snap.players.get(tw.playerId) ?? null : null;
  const a = p?.allianceId ? snap.alliances.get(p.allianceId) ?? null : null;
  const history = snap.conquers.filter((c) => c.townId === townId).sort((x, y) => y.time - x.time).slice(0, 12).map((c) => [c.time, pn(c.newPlayerId), pn(c.oldPlayerId)] as [number, string, string]);
  let troops: TownPanel['troops'] = null;
  if (may.troops) {
    for (const s of gg.view(guildId, world, userId).players) {
      const t = s.towns.find((x) => x.id === townId);
      if (t) { troops = { player: s.playerName, ts: s.recvAt, town: t }; break; }
    }
  }
  let incoming: TownPanel['incoming'] = null;
  if (may.alerts) {
    const nowS = Math.floor(Date.now() / 1000);
    incoming = [];
    for (const s of gg.feedView<IncomingCmd>('incoming', guildId, world, userId).players) for (const c of s.items) if (c.town_id === townId && c.arrival > nowS) incoming.push({ player: s.playerName, cmd: c });
    incoming.sort((x, y) => x.cmd.arrival - y.cmd.arrival);
  }
  const clock = p ? ctx.store.playerHours(world, p.id) : null;
  return {
    id: tw.id, name: tw.name, points: tw.points, ix: tw.islandX, iy: tw.islandY,
    owner: p ? { id: p.id, name: p.name, points: p.points, towns: p.towns } : null, alliance: a ? { id: a.id, name: a.name } : null,
    history, clock: clock && clock.some((n) => n > 0) ? clock : null, troops, incoming,
  };
}
