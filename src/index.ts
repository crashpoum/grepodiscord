/** Bot entry point. */
import { Client, Events, GatewayIntentBits } from 'discord.js';
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

if (!config.discordToken) {
  console.error('DISCORD_TOKEN is not set. For a token-free dry run use: npm run cli -- --help');
  process.exit(1);
}

const store = new Store(resolveDbPath(config.dbPath, (m) => log.info(m)));
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient() };
for (const w of store.trackedWorlds()) ctx.worlds.loadFromCache(w);
seedEnvToken(store);

// Guilds intent only: no privileged intents (no message content, no member list scraping).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} guild(s); tracking ${store.trackedWorlds().join(', ') || 'no worlds yet'}`);
  void ctx.gd.activeWorlds(config.markets).catch(() => undefined); // warm world list cache for autocomplete
  const stop = startScheduler(c, ctx);
  const shutdown = () => { log.info('shutting down'); stop(); void c.destroy().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
});

client.on(Events.InteractionCreate, (i) => {
  if (i.isAutocomplete()) void handleAutocomplete(ctx, i);
  else if (i.isChatInputCommand()) void handleCommand(ctx, i);
  else if (i.isButton()) void handleButton(ctx, i);
});

client.on(Events.Error, (e) => log.error('discord client error', e));
void client.login(config.discordToken);
