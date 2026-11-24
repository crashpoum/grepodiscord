/** Turns refresh events + feed configs into concrete messages (pure; used by bot and CLI). */
import type { APIEmbed } from 'discord.js';
import type { FeedConfig } from './feeds.js';
import { matchAllianceChange, matchBp, matchConquest } from './feeds.js';
import type { RefreshEvents } from './refresh.js';
import { allianceChangesEmbeds, bpEmbeds, conquestEmbed } from './embeds.js';
import type { Lang } from './i18n.js';

export interface PlannedPost { feedId: number; guildId: string; channelId: string; embeds: APIEmbed[] }

/** Max conquest embeds per feed per refresh (anti-spam); the rest are summarized. */
export const MAX_CONQUESTS_PER_REFRESH = 30;

export function planFeedPosts(feeds: FeedConfig[], ev: RefreshEvents, langFor: (guildId: string) => Lang): PlannedPost[] {
  const out: PlannedPost[] = [];
  const snap = ev.snapshot;
  for (const f of feeds) {
    if (f.world !== ev.world) continue;
    const lang = langFor(f.guildId);
    let embeds: APIEmbed[] = [];
    if (f.type === 'conquests') {
      const hits = ev.conquests.filter((c) => matchConquest(f.filter, c, snap));
      embeds = hits.slice(0, MAX_CONQUESTS_PER_REFRESH).map((c) => conquestEmbed(lang, snap, c));
      if (hits.length > MAX_CONQUESTS_PER_REFRESH) embeds.push({ description: `+${hits.length - MAX_CONQUESTS_PER_REFRESH} more`, color: 0x7f8c8d });
    } else if (f.type === 'alliance') {
      const hits = ev.allianceChanges.filter((c) => matchAllianceChange(f.filter, c));
      if (hits.length) embeds = allianceChangesEmbeds(lang, snap, hits);
    } else if (f.type === 'bp') {
      const hits = ev.bp.filter((d) => matchBp(f.filter, d, snap)).slice(0, 40);
      if (hits.length) embeds = bpEmbeds(lang, snap, hits);
    }
    if (embeds.length) out.push({ feedId: f.id, guildId: f.guildId, channelId: f.channelId, embeds });
  }
  return out;
}

/** Discord allows max 10 embeds per message. */
export function batchEmbeds(embeds: APIEmbed[], size = 10): APIEmbed[][] {
  const out: APIEmbed[][] = [];
  for (let i = 0; i < embeds.length; i += size) out.push(embeds.slice(i, i + size));
  return out;
}
