/** Pure role-sync computation. */
import type { Player } from './data/parse.js';

export interface RoleConfig { verifiedRoleId: string | null; allianceRoles: Map<number, string> }

export function managedRoleIds(cfg: RoleConfig): Set<string> {
  const s = new Set<string>(cfg.allianceRoles.values());
  if (cfg.verifiedRoleId) s.add(cfg.verifiedRoleId);
  return s;
}

/** Desired managed roles for a linked member. `player` null = account gone (deleted/ended world). */
export function desiredRoles(cfg: RoleConfig, player: Player | null): Set<string> {
  const s = new Set<string>();
  if (!player) return s;
  if (cfg.verifiedRoleId) s.add(cfg.verifiedRoleId);
  if (player.allianceId !== null) {
    const r = cfg.allianceRoles.get(player.allianceId);
    if (r) s.add(r);
  }
  return s;
}

/** Only touches roles the bot manages; never removes unrelated roles. */
export function roleChanges(cfg: RoleConfig, current: Iterable<string>, player: Player | null): { add: string[]; remove: string[] } {
  const managed = managedRoleIds(cfg);
  const want = desiredRoles(cfg, player);
  const cur = new Set(current);
  const add = [...want].filter((r) => !cur.has(r));
  const remove = [...cur].filter((r) => managed.has(r) && !want.has(r));
  return { add, remove };
}
