import type { Client } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import type { Ctx } from '../services.js';
import { postFeedEvents, processPendingVerifications, syncRolesForWorld } from './poster.js';

/** Polls tracked worlds every REFRESH_MINUTES; files change ~hourly, conditional GETs make no-op polls cheap. */
export function startScheduler(client: Client, ctx: Ctx): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const world of ctx.store.trackedWorlds()) {
        try {
          const ev = await ctx.worlds.refresh(world);
          if (ev.changedFiles.length === 0) continue;
          await postFeedEvents(client, ctx, ev);
          if (ev.changedFiles.includes('towns')) await processPendingVerifications(client, ctx, world);
          if (ev.changedFiles.includes('players')) await syncRolesForWorld(client, ctx, world);
        } catch (e) {
          log.error(`refresh ${world} failed: ${e}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  const h = setInterval(() => void tick(), config.refreshMinutes * 60_000);
  return () => clearInterval(h);
}
