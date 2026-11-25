/**
 * What the web app and the trackers need from the Discord client, as plain functions (no discord.js types), so the
 * web layer stays testable. index.ts provides the real implementation; tests pass fakes.
 */
export interface DiscordPayload { content?: string; embeds?: unknown[]; components?: unknown[]; allowedMentions?: { parse?: string[]; roles?: string[]; users?: string[] } }
export interface BotBridge {
  /** Post a message as the bot; returns the message id, or throws with a short reason. */
  post(channelId: string, payload: DiscordPayload): Promise<string>;
  /** Edit a message the bot posted; false when it is gone (then post a new one). */
  edit(channelId: string, messageId: string, payload: DiscordPayload): Promise<boolean>;
  /** Role ids of a member (REST, no privileged intent); null when unknown. */
  memberRoles(guildId: string, userId: string): Promise<string[] | null>;
  /** Members with display names when Discord lets the bot list them (needs the Server Members intent); else null. */
  members(guildId: string): Promise<{ userId: string; name: string }[] | null>;
  /** Text channels and roles for the admin panel pickers (gateway cache). */
  channels(guildId: string): { id: string; name: string }[];
  roles(guildId: string): { id: string; name: string; color: string }[];
  userName(guildId: string, userId: string): Promise<string | null>;
  /** Re-apply verified/alliance roles after a link change. */
  syncRoles(guildId: string, userIds: string[]): Promise<void>;
}

import type { LiveHub } from './web/live.js';
import type { AdminService } from './admin/service.js';
import type { GgService } from './web/ggTroops.js';

/** Process-wide handles shared by the bot side and the web app (set once at startup). */
export const runtime: { bridge: BotBridge | null; hub: LiveHub | null; admin: AdminService | null; gg: GgService | null; startedAt: number; errors: { at: number; msg: string }[] } =
  { bridge: null, hub: null, admin: null, gg: null, startedAt: Date.now(), errors: [] };
/** Recent warnings/errors for the admin status page (ring buffer, no secrets: callers pass short messages). */
export function noteError(msg: string, at = Date.now()) {
  runtime.errors.push({ at, msg: msg.replace(/(ggc1_|Bearer\s+)[\w-]+/g, '$1…').slice(0, 300) });
  if (runtime.errors.length > 50) runtime.errors.shift();
}
