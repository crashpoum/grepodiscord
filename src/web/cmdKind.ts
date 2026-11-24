/**
 * What a GrepoData shared command IS, decided from its raw fields exactly the way GrepoData's own live view does
 * (frontend command list template + backend Commands::AddCommands), so labels, icons and row styles match:
 * - `type` is the game's movement type: attack (incoming attack), attack_land, attack_sea, attack_spy, attack_takeover
 *   (colony ship under conquest), breakthrough, farm_attack, support, abort, revolt, colonization, foundation,
 *   portal_attack_olympus, portal_support_olympus. Unknown types are still shown (as "other"), never dropped.
 * - `subtype`: 'attack_takeover' = colony ship has LANDED and the conquest is running (arrival = conquered at);
 *   'command' = colony ship still travelling; 'cs_eta' = foundation (colonization_finished_at known); 'ongoing_revolt' =
 *   a running revolt (started_at = phase 2 start, arrival = phase 2 end); 'portal' | 'quest' | 'temple' | 'attack_spot'.
 * - `cancel_human` is NOT a cancellation: it holds "cancelable until" (fresh own commands), the planned departure
 *   (planned commands) or the revolt phase-2 start, depending on the command.
 * Shared by the server (sorting) and the browser (rendering); no DOM here.
 */
export type CmdKind = 'attack' | 'support' | 'revolt' | 'conquest' | 'siege' | 'colonize' | 'spy' | 'farm' | 'return' | 'other';
export type TimeLabel = 'arrival' | 'arrivalPortal' | 'colonized' | 'conquered' | 'revoltP2' | 'planned';
export type CmdBadge = 'siege' | 'revoltArising' | 'revoltRunning' | 'returning' | 'planned' | 'quest' | 'temple' | 'portal' | 'spot';

/** Official command-type icons (Grepolis CDN images/game/unit_overview/<name>.png), in sprite order (/gpcdn/cmds.png). */
export const GP_CMD_ICONS = ['attack', 'attack_land', 'attack_sea', 'attack_spy', 'attack_takeover', 'support', 'abort', 'farm_attack', 'revolt', 'revolt_arising',
  'revolt_running', 'breakthrough', 'colonization', 'foundation', 'portal_attack_olympus', 'portal_support_olympus'] as const;
export type CmdIcon = (typeof GP_CMD_ICONS)[number];

export interface CmdFields { type: string; sub: string; ret: boolean; planned: boolean; strat?: string; started: number | null; arrival: number }
export interface CmdInfo {
  kind: CmdKind;
  /** Official icon name, or null for an unknown type (own fallback icon). */
  icon: CmdIcon | null;
  label: TimeLabel;
  badges: CmdBadge[];
  /** What the countdown runs to: arrival, or the phase-2 start of a revolt that is still arising. */
  countdownAt: number;
}

const ATTACK_TYPES = new Set(['attack', 'attack_land', 'attack_sea', 'breakthrough', 'portal_attack_olympus']);

export function describeCommand(c: CmdFields, nowSec: number): CmdInfo {
  const type = (c.type || '').toLowerCase(), sub = (c.sub || '').toLowerCase();
  const badges: CmdBadge[] = [];
  let kind: CmdKind;
  if (type === 'attack_takeover') kind = sub === 'attack_takeover' ? 'siege' : 'conquest';
  else if (type === 'colonization' || type === 'foundation') kind = 'colonize';
  else if (type === 'revolt') kind = 'revolt';
  else if (type === 'support' || type === 'portal_support_olympus') kind = 'support';
  else if (type === 'attack_spy') kind = 'spy';
  else if (type === 'farm_attack') kind = 'farm';
  else if (type === 'abort') kind = 'return';
  else if (ATTACK_TYPES.has(type)) kind = 'attack';
  // Older/other spellings, so nothing unknown is ever mislabelled as an attack.
  else if (/takeover|conquer/.test(type)) kind = 'conquest';
  else if (/colon|found/.test(type)) kind = 'colonize';
  else if (/revolt/.test(type)) kind = 'revolt';
  else if (/support/.test(type)) kind = 'support';
  else if (/spy|espionage/.test(type)) kind = 'spy';
  else if (/attack|breach|siege/.test(type)) kind = 'attack';
  else kind = 'other';
  if (c.ret && kind !== 'return') { badges.push('returning'); kind = 'return'; }

  let icon: CmdIcon | null = (GP_CMD_ICONS as readonly string[]).includes(type) ? (type as CmdIcon) : kind === 'attack' ? 'attack_land' : kind === 'support' ? 'support' : kind === 'spy' ? 'attack_spy' : kind === 'conquest' || kind === 'siege' ? 'attack_takeover' : kind === 'colonize' ? 'colonization' : kind === 'revolt' ? 'revolt' : kind === 'return' ? 'abort' : null;
  let label: TimeLabel = 'arrival';
  let countdownAt = c.arrival;
  if (sub === 'ongoing_revolt') {
    label = 'revoltP2';
    const arising = c.started !== null && c.started > nowSec;
    icon = arising ? 'revolt_arising' : 'revolt_running';
    badges.push(arising ? 'revoltArising' : 'revoltRunning');
    if (arising) countdownAt = c.started!;
  } else if (type === 'revolt' && (c.strat === 'revolt_arising' || c.strat === 'revolt_running')) {
    icon = c.strat;
  }
  if (kind === 'siege') { label = 'conquered'; badges.push('siege'); }
  else if (sub === 'cs_eta') label = 'colonized';
  else if (sub === 'portal' && label === 'arrival') label = 'arrivalPortal';
  if (sub === 'quest') badges.push('quest'); else if (sub === 'temple') badges.push('temple'); else if (sub === 'portal') badges.push('portal'); else if (sub === 'attack_spot') badges.push('spot');
  if (c.planned) { label = 'planned'; badges.push('planned'); }
  return { kind, icon, label, badges, countdownAt };
}

/** Kinds that threaten the target town (red row style when it is ours). */
export const HOSTILE: ReadonlySet<CmdKind> = new Set(['attack', 'conquest', 'siege', 'revolt', 'spy', 'farm']);
