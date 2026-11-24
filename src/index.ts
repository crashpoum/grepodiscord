/** Bot entry point. */
import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { log } from './log.js';
import { Store } from './db.js';
import { resolveDbPath } from './dbPath.js';
import { WorldManager } from './refresh.js';
import { GrepoDataClient } from './data/grepodata.js';
import { handleAutocomplete, handleCommand } from './bot/handlers.js';
import { startScheduler } from './bot/scheduler.js';
import { handleButton } from './bot/warPoster.js';
import { seedEnvToken } from './gdAuth.js';
import { Gemini } from './ai/gemini.js';
import { handleReportContext, handleReportModal } from './bot/aiHandlers.js';
import { startWebServer } from './web/server.js';
import { handleWebButton, OPEN_PREFIX } from './bot/webHandlers.js';

if (!config.discordToken) {
  console.error('DISCORD_TOKEN is not set. For a token-free dry run use: npm run cli -- --help');
  process.exit(1);
}

const store = new Store(resolveDbPath(config.dbPath, (m) => log.info(m)));
const ai = new Gemini({ apiKey: config.geminiApiKey, model: config.geminiModel, rpm: config.geminiRpm, rpd: config.geminiRpd, store });
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient(), ai };
log.info(ai.available ? `Gemini: ${ai.model} (free tier caps: ${config.geminiRpm}/min, ${config.geminiRpd}/day)` : 'Gemini: no GEMINI_API_KEY (reports disabled, newspaper uses the template)');
for (const w of store.trackedWorlds()) ctx.worlds.loadFromCache(w);
seedEnvToken(store);

const discordNo = (e: unknown, codes: number[]) => codes.includes(Number((e as { code?: unknown })?.code));

// Guilds intent only: no privileged intents (no message content, no member list scraping).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Live window / map web app (Activity + dashboard), only when configured. Shares the store, caches and GrepoData budget.
const web = config.webEnabled
  ? startWebServer(ctx, {
    has: (id) => client.guilds.cache.has(id),
    name: (id) => client.guilds.cache.get(id)?.name ?? null,
    // REST lookups (no privileged intent): only a definite "Unknown Guild/Member" or "Missing Access" counts as no.
    check: async (id) => {
      if (!client.isReady()) return 'unknown';
      try { await client.guilds.fetch({ guild: id, force: true }); return 'yes'; } catch (e) { return discordNo(e, [10004, 50001]) ? 'no' : 'unknown'; }
    },
    member: async (guildId, userId) => {
      const g = client.guilds.cache.get(guildId);
      if (!g) return 'unknown';
      try { await g.members.fetch({ user: userId, force: false }); return 'yes'; } catch (e) { return discordNo(e, [10007, 10013]) ? 'no' : 'unknown'; }
    },
    manager: async (guildId, userId) => {
      const g = client.guilds.cache.get(guildId);
      if (!g) return false;
      if (g.ownerId === userId) return true;
      try { const m = await g.members.fetch({ user: userId, force: false }); return m.permissions.has(PermissionFlagsBits.ManageGuild); } catch { return false; }
    },
    diag: () => `client ${client.isReady() ? 'ready' : 'NOT ready'}, ${client.guilds.cache.size} guild(s) cached`,
  })
  : null;
if (!web) log.info('web: live window disabled (set PUBLIC_URL and/or ACTIVITY_CLIENT_ID to enable)');

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} guild(s); tracking ${store.trackedWorlds().join(', ') || 'no worlds yet'}`);
  void ctx.gd.activeWorlds(config.markets).catch(() => undefined); // warm world list cache for autocomplete
  const stop = startScheduler(c, ctx);
  const shutdown = () => { log.info('shutting down'); stop(); web?.close(); void c.destroy().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
});

client.on(Events.InteractionCreate, (i) => {
  if (i.isAutocomplete()) void handleAutocomplete(ctx, i);
  else if (i.isChatInputCommand()) void handleCommand(ctx, i);
  else if (i.isButton()) void (i.customId.startsWith(OPEN_PREFIX) ? handleWebButton(ctx, i).catch((e) => log.warn(`web button: ${e}`)) : handleButton(ctx, i));
  else if (i.isModalSubmit()) void handleReportModal(ctx, i);
  else if (i.isMessageContextMenuCommand()) void handleReportContext(ctx, i);
});

client.on(Events.Error, (e) => log.error('discord client error', e));
void client.login(config.discordToken);
