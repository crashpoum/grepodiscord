/**
 * Linking Discord members to in-game players without renaming towns:
 *   /iam player → checks the player is in our alliance or a pact (public world data) → "unconfirmed" link right away →
 *   an admin approves or rejects (admin panel or buttons in the admin channel). Admins can also assign directly and
 *   confirm nickname suggestions in bulk. One player per member, one member per player. /verify stays as a fallback.
 */
import type { Store } from '../db.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import type { AdminSettings } from './settings.js';

export type ClaimFail = 'taken' | 'notOurs' | 'already' | 'unknown';
export interface FriendlySides { ours: number[]; allies: number[] }

/** Alliances whose members may claim a player: own + pacts (empty = no sides known yet: anyone). */
export function claimAllowed(snap: WorldSnapshot, playerId: number, sides: FriendlySides, s: AdminSettings): { ok: true } | { ok: false; why: ClaimFail } {
  const p = snap.players.get(playerId);
  if (!p) return { ok: false, why: 'unknown' };
  if (s.linking.allowAnyAlliance) return { ok: true };
  const friendly = new Set([...sides.ours, ...sides.allies]);
  if (!friendly.size) return { ok: true };
  return p.allianceId !== null && friendly.has(p.allianceId) ? { ok: true } : { ok: false, why: 'notOurs' };
}

/** Is this player already linked or claimed by someone else? */
export function playerTaken(store: Store, guildId: string, world: string, playerId: number, userId: string): boolean {
  const l = store.linkForPlayer(guildId, world, playerId);
  if (l && l.userId !== userId) return true;
  const c = store.claimForPlayer(guildId, world, playerId);
  return !!c && c.userId !== userId;
}

/** Record a pending claim (replaces the member's previous pending claim). */
export function createClaim(store: Store, c: { guildId: string; userId: string; userName: string | null; world: string; playerId: number; source: 'iam' | 'suggest' }, now: number): { ok: true } | { ok: false; why: ClaimFail } {
  const link = store.getLink(c.guildId, c.userId);
  if (link && link.world === c.world && link.playerId === c.playerId) return { ok: false, why: 'already' };
  if (playerTaken(store, c.guildId, c.world, c.playerId, c.userId)) return { ok: false, why: 'taken' };
  store.setClaim({ ...c, status: 'pending', createdAt: now });
  return { ok: true };
}

/** Confirm a link (approval, admin assign, bulk confirm). Fails if the player went to someone else meanwhile. */
export function confirmLink(store: Store, guildId: string, userId: string, world: string, playerId: number, by: string, now: number): { ok: true } | { ok: false; why: ClaimFail } {
  const other = store.linkForPlayer(guildId, world, playerId);
  if (other && other.userId !== userId) return { ok: false, why: 'taken' };
  store.setLink({ guildId, userId, world, playerId, verifiedAt: Math.floor(now / 1000) });
  if (store.getClaim(guildId, userId)?.status === 'pending') store.decideClaim(guildId, userId, 'approved', by, now);
  else store.setClaim({ guildId, userId, userName: null, world, playerId, status: 'approved', source: 'admin', createdAt: now, decidedBy: by, decidedAt: now });
  store.removePending(guildId, userId);
  return { ok: true };
}

/** Link state used by permissions: a confirmed link, a pending /iam claim, or nothing. */
export function linkState(store: Store, guildId: string, userId: string, world: string | null): 'confirmed' | 'pending' | 'none' {
  const l = store.getLink(guildId, userId);
  if (l && (!world || l.world === world)) return 'confirmed';
  const c = store.getClaim(guildId, userId);
  return c && c.status === 'pending' && (!world || c.world === world) ? 'pending' : 'none';
}

/** The player a member stands for: confirmed link, else (when unconfirmed members get full access) the pending claim. */
export function effectivePlayer(store: Store, guildId: string, userId: string, world: string, s: AdminSettings): number | null {
  const l = store.getLink(guildId, userId);
  if (l && l.world === world) return l.playerId;
  const c = store.getClaim(guildId, userId);
  return c && c.status === 'pending' && c.world === world && s.linking.unconfirmed === 'full' ? c.playerId : null;
}
