/** Registers slash commands. Uses DEV_GUILD_ID for instant per-guild registration, else global (can take up to ~1h to appear). */
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandJson } from './bot/commands.js';

if (!config.discordToken || !config.clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID are required to register commands.');
  process.exit(1);
}
const rest = new REST().setToken(config.discordToken);
const body = commandJson();
const route = config.devGuildId ? Routes.applicationGuildCommands(config.clientId, config.devGuildId) : Routes.applicationCommands(config.clientId);
const res = (await rest.put(route, { body })) as unknown[];
console.log(`Registered ${res.length} commands ${config.devGuildId ? `to guild ${config.devGuildId}` : 'globally'}.`);
