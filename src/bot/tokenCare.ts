/**
 * Hourly GrepoData token maintenance: renew tokens that are about to expire (refresh token, or the
 * optional env login for the env guild) and DM the admin when a token will expire / has expired /
 * could not be renewed. Alert state lives in gd_tokens.alert_stage so each alert is sent once.
 */
import type { Client } from 'discord.js';
import { config } from '../config.js';
import { ALERT, planTokenAction, renewToken } from '../gdAuth.js';
import type { GdTokenRow } from '../db.js';
import { t } from '../i18n.js';
import { log } from '../log.js';
import type { Ctx } from '../services.js';
import { discordTs } from '../time.js';

export async function runTokenCare(client: Client | null, ctx: Ctx, now = Date.now()): Promise<void> {
  for (const row of ctx.store.allGdTokens()) {
    const canLogin = !!(config.grepodataLogin && config.grepodataPassword && row.guildId === config.grepodataGuildId);
    const action = planTokenAction(row, now, canLogin);
    if (action.kind === 'none') continue;
    if (action.kind === 'refresh' || action.kind === 'login') {
      const res = await renewToken(ctx.store, ctx.gd, row, action.kind);
      if (res === 'failed') {
        const after = ctx.store.getGdToken(row.guildId);
        if (after?.alertStage === ALERT.refreshFailed) await alert(client, ctx, after, 'gdtoken.alert.failed');
      }
      continue;
    }
    await alert(client, ctx, row, action.stage === ALERT.expired ? 'gdtoken.alert.expired' : 'gdtoken.alert.soon');
    // Keep a refresh-failed marker if present; otherwise record the stage we just alerted.
    if (row.alertStage !== ALERT.refreshFailed) ctx.store.setGdAlert(row.guildId, action.stage, row.lastError);
  }
}

async function alert(client: Client | null, ctx: Ctx, row: GdTokenRow, key: 'gdtoken.alert.soon' | 'gdtoken.alert.expired' | 'gdtoken.alert.failed') {
  const guild = client?.guilds.cache.get(row.guildId);
  const lang = ctx.store.getGuild(row.guildId, config.defaultLang).lang;
  const text = t(lang, key, { guild: guild?.name ?? row.guildId, exp: discordTs(row.accessExp ? Math.floor(row.accessExp / 1000) : null, 'R'), error: row.lastError ?? '?' });
  const target = row.adminUserId || config.grepodataAdminId || guild?.ownerId;
  if (!client || !target) { log.warn(`GrepoData token alert for guild ${row.guildId} (no one to DM): ${key}`); return; }
  try {
    const user = await client.users.fetch(target);
    await user.send(text);
    log.info(`GrepoData token alert ${key} sent for guild ${row.guildId}`);
  } catch (e) {
    log.warn(`GrepoData token alert DM for guild ${row.guildId} failed: ${e}`);
  }
}
