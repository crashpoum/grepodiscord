import type { Client } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import type { Ctx } from '../services.js';
import { runTokenCare } from './tokenCare.js';
import { recordHistory } from './insights.js';
import { runNewspapers } from './aiHandlers.js';
import { postFeedEvents, processPendingVerifications, syncRolesForWorld } from './poster.js';
import { rollBaselines, runOpReminders, sendThreatAlerts, updateBoardsForWorld } from './warPoster.js';

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
          try { recordHistory(ctx, ev.snapshot); } catch (e) { log.warn(`history ${world}: ${e}`); }
          await postFeedEvents(client, ctx, ev);
          if (ev.changedFiles.includes('towns')) await processPendingVerifications(client, ctx, world);
          if (ev.changedFiles.includes('players')) await syncRolesForWorld(client, ctx, world);
          await sendThreatAlerts(client, ctx, ev).catch((e) => log.warn(`threat alerts ${world}: ${e}`));
          await updateBoardsForWorld(client, ctx, world).catch((e) => log.warn(`boards ${world}: ${e}`));
          if (ctx.store.boardsForWorld(world).length) rollBaselines(ctx, ev.snapshot);
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
  // GrepoData tokens: check shortly after start, then every 30 minutes (cheap: only DB reads unless renewal is due).
  const care = () => void runTokenCare(client, ctx).catch((e) => log.error(`token care failed: ${e}`));
  const t0 = setTimeout(care, 15_000);
  const h2 = setInterval(care, 30 * 60_000);
  // Op planner: 60-second "click Send now" reminders (DB-only check every 15 s).
  let remBusy = false;
  const rem = () => {
    if (remBusy) return;
    remBusy = true;
    void runOpReminders(client, ctx).catch((e) => log.error(`op reminders failed: ${e}`)).finally(() => { remBusy = false; });
  };
  const h3 = setInterval(rem, 15_000);
  // Weekly newspaper: due check every 5 minutes (DB-only unless one is due).
  let newsBusy = false;
  const news = () => {
    if (newsBusy) return;
    newsBusy = true;
    void runNewspapers(client, ctx).catch((e) => log.error(`newspapers failed: ${e}`)).finally(() => { newsBusy = false; });
  };
  const h4 = setInterval(news, 5 * 60_000);
  const t1 = setTimeout(news, 60_000);
  return () => { clearInterval(h); clearInterval(h2); clearInterval(h3); clearInterval(h4); clearTimeout(t0); clearTimeout(t1); };
}
