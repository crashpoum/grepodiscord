/**
 * In-game identity verification (ToS-safe).
 *
 * Why not "put a code in your profile text": Grepolis profile texts are only visible inside the logged-in game
 * client (internal game API). They are NOT in the public world data files nor in GrepoData's public API, and
 * reading them would require a game login, which InnoGames' rules (§2/§7) forbid for a bot.
 *
 * Instead: the member renames one of their own towns to include a short code. Town names ARE public
 * (towns.txt, refreshed hourly), so the bot only reads public data and the human performs the in-game action.
 */
import { randomInt } from 'node:crypto';
import type { Town } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const CODE_PREFIX = 'GD';
export const CODE_TTL_HOURS = 48;

export function generateCode(rand: (max: number) => number = randomInt): string {
  let s = CODE_PREFIX;
  for (let i = 0; i < 4; i++) s += ALPHABET[rand(ALPHABET.length)];
  return s;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Returns the player's town whose (public) name contains the code, or null. */
export function findCodeTown(snap: WorldSnapshot, playerId: number, code: string): Town | null {
  const c = norm(code);
  for (const t of snap.townsByPlayer.get(playerId) ?? []) if (norm(t.name).includes(c)) return t;
  return null;
}

export function isExpired(createdAt: number, now: number): boolean {
  return now - createdAt > CODE_TTL_HOURS * 3600;
}
