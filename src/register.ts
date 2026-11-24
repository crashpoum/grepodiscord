/**
 * Registers slash commands. Uses DEV_GUILD_ID for instant per-guild registration, else global (can take up to ~1h to
 * appear). Then makes sure the Activity app (ACTIVITY_CLIENT_ID) has its Entry Point "launch" command.
 */
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandJson } from './bot/commands.js';
import { ENTRY_POINT, ensureEntryPoint } from './web/entryPoint.js';

if (!config.discordToken || !config.clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID are required to register commands.');
  process.exit(1);
}
const rest = new REST().setToken(config.discordToken);
// Same app for bot and Activity: a bulk overwrite must carry the Entry Point too (Discord keeps only what is sent).
const sameApp = !config.devGuildId && config.clientId === config.activityClientId;
const body = sameApp ? [...commandJson(), ENTRY_POINT] : commandJson();
const route = config.devGuildId ? Routes.applicationGuildCommands(config.clientId, config.devGuildId) : Routes.applicationCommands(config.clientId);
const res = (await rest.put(route, { body })) as unknown[];
console.log(`Registered ${res.length} commands ${config.devGuildId ? `to guild ${config.devGuildId}` : 'globally'}.`);

try {
  console.log((await ensureEntryPoint()).message);
} catch (e) {
  console.error(`Entry Point command NOT registered: ${(e as Error).message}`);
  process.exitCode = 1;
}
