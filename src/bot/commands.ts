/**
 * Slash command definitions (registered via `npm run register`).
 * English is the default; every command, subcommand, option and choice gets a Greek (el) name and
 * description from ./commandsEl.ts (applied in commandJson, enforced by test/commands.test.ts).
 */
import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type SlashCommandStringOption, type SlashCommandIntegerOption } from 'discord.js';
import { localizeCommands } from './commandsEl.js';

const worldOpt = (o: SlashCommandStringOption) => o.setName('world').setDescription('World id, e.g. gr125 or en180 (default: server world)').setAutocomplete(true);
const pageOpt = (o: SlashCommandIntegerOption) => o.setName('page').setDescription('Page (default 1)').setMinValue(1).setMaxValue(50);
const kindOpt = (o: SlashCommandStringOption) => o.setName('kind').setDescription('Players or alliances (default: players)')
  .addChoices({ name: 'players', value: 'player' }, { name: 'alliances', value: 'alliance' });

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show what this bot can do'),

  new SlashCommandBuilder().setName('setup').setDescription('Server settings (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('world').setDescription('Set the default world')
      .addStringOption((o) => o.setName('world').setDescription('World id, e.g. gr125').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('language').setDescription('Bot language for this server')
      .addStringOption((o) => o.setName('language').setDescription('Language').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Ελληνικά', value: 'el' })))
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings')),

  new SlashCommandBuilder().setName('player').setDescription('Player stats and history chart')
    .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true).setAutocomplete(true))
    .addStringOption(worldOpt),

  new SlashCommandBuilder().setName('alliance').setDescription('Alliance stats and history chart')
    .addStringOption((o) => o.setName('name').setDescription('Alliance name').setRequired(true).setAutocomplete(true))
    .addStringOption(worldOpt),

  new SlashCommandBuilder().setName('radar').setDescription('Find inactive players and ghost towns')
    .addSubcommand((s) => s.setName('inactive').setDescription('Players with no growth/BP change for N hours')
      .addIntegerOption((o) => o.setName('hours').setDescription('Idle hours (default 48)').setMinValue(1).setMaxValue(24 * 30))
      .addStringOption((o) => o.setName('ocean').setDescription('Ocean(s), e.g. 45 or 45,46'))
      .addStringOption((o) => o.setName('near_town').setDescription('Sort by distance from this town').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('radius').setDescription('Max distance from near_town (default 20)').setMinValue(1).setMaxValue(500))
      .addIntegerOption((o) => o.setName('min_points').setDescription('Minimum player points').setMinValue(0))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('ghosts').setDescription('Ghost towns (no owner)')
      .addStringOption((o) => o.setName('ocean').setDescription('Ocean(s), e.g. 45 or 45,46'))
      .addStringOption((o) => o.setName('near_town').setDescription('Sort by distance from this town').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('radius').setDescription('Max distance from near_town (default 20)').setMinValue(1).setMaxValue(500))
      .addIntegerOption((o) => o.setName('min_points').setDescription('Minimum town points').setMinValue(0))
      .addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('feed').setDescription('Automatic feeds (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('add').setDescription('Post a feed to a channel after each hourly refresh')
      .addStringOption((o) => o.setName('type').setDescription('Feed type').setRequired(true).addChoices(
        { name: 'Conquests', value: 'conquests' }, { name: 'Alliance joins/leaves', value: 'alliance' }, { name: 'BP spikes', value: 'bp' }))
      .addChannelOption((o) => o.setName('channel').setDescription('Target channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName('alliance').setDescription('Only events involving this alliance').setAutocomplete(true))
      .addStringOption((o) => o.setName('player').setDescription('Only events involving this player').setAutocomplete(true))
      .addStringOption((o) => o.setName('ocean').setDescription('Conquests: only in these oceans, e.g. 45,46'))
      .addIntegerOption((o) => o.setName('min_bp').setDescription('BP feed: minimum gain per refresh (default 5000)').setMinValue(1))
      .addStringOption((o) => o.setName('bp_kind').setDescription('BP feed: attack, defence or both').addChoices({ name: 'both', value: 'any' }, { name: 'attack', value: 'att' }, { name: 'defence', value: 'def' }))
      .addBooleanOption((o) => o.setName('skip_ghosts').setDescription('Conquests: ignore ghost-town takeovers'))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('list').setDescription('List feeds'))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a feed').addIntegerOption((o) => o.setName('id').setDescription('Feed id').setRequired(true))),

  new SlashCommandBuilder().setName('verify').setDescription('Link your Discord account to your in-game player').setDMPermission(false)
    .addSubcommand((s) => s.setName('start').setDescription('Get a code to put in one of your town names')
      .addStringOption((o) => o.setName('player').setDescription('Your in-game player name').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('check').setDescription('Check your code now'))
    .addSubcommand((s) => s.setName('status').setDescription('Show your link'))
    .addSubcommand((s) => s.setName('unlink').setDescription('Remove your link')),

  new SlashCommandBuilder().setName('roles').setDescription('Automatic roles from in-game alliance (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('verified').setDescription('Role given to every verified member').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('alliance').setDescription('Give a role to verified members of an alliance')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an alliance role mapping')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show role mappings'))
    .addSubcommand((s) => s.setName('sync').setDescription('Sync roles now')),

  // ---- GrepoData: rankings and scoreboards
  new SlashCommandBuilder().setName('top').setDescription('Rankings and daily/hourly scoreboards')
    .addSubcommand((s) => s.setName('today').setDescription('Top attackers, defenders, conquerors and losers today').addStringOption(kindOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('yesterday').setDescription('Yesterday\'s scoreboard').addStringOption(kindOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('hour').setDescription('Most battle points gained in one hour (players)')
      .addIntegerOption((o) => o.setName('hour').setDescription('Hour of today, world time 0-23 (default: last full hour)').setMinValue(0).setMaxValue(23))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('ranking').setDescription('Overall ranking')
      .addStringOption(kindOpt)
      .addStringOption((o) => o.setName('sort').setDescription('Sort by (default: points)').addChoices(
        { name: 'points', value: 'Points' }, { name: 'attack BP', value: 'Att' }, { name: 'defence BP', value: 'Def' },
        { name: 'total BP', value: 'AttDef' }, { name: 'towns', value: 'Towns' }, { name: 'members (alliances)', value: 'Members' }))
      .addIntegerOption(pageOpt).addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('wars').setDescription('Who an alliance took towns from and lost towns to')
    .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true))
    .addStringOption(worldOpt),

  new SlashCommandBuilder().setName('changes').setDescription('Alliance join/leave history')
    .addSubcommand((s) => s.setName('alliance').setDescription('Members who joined or left an alliance')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)).addIntegerOption(pageOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('player').setDescription('Alliances a player has been in')
      .addStringOption((o) => o.setName('player').setDescription('Player').setRequired(true).setAutocomplete(true)).addIntegerOption(pageOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('world').setDescription('Latest alliance changes in the whole world').addIntegerOption(pageOpt).addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('conquests').setDescription('Conquest history')
    .addSubcommand((s) => s.setName('player').setDescription('Towns a player took or lost')
      .addStringOption((o) => o.setName('player').setDescription('Player').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('filter').setDescription('Which conquests (default: all)').addChoices({ name: 'all', value: 'all' }, { name: 'enemy', value: 'enemy' }, { name: 'friendly', value: 'friendly' }, { name: 'internal', value: 'internal' }))
      .addIntegerOption(pageOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('alliance').setDescription('Towns an alliance took or lost')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('filter').setDescription('Which conquests (default: all)').addChoices({ name: 'all', value: 'all' }, { name: 'enemy', value: 'enemy' }, { name: 'friendly', value: 'friendly' }, { name: 'internal', value: 'internal' }))
      .addIntegerOption(pageOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('town').setDescription('Every owner change of one town')
      .addStringOption((o) => o.setName('town').setDescription('Town').setRequired(true).setAutocomplete(true))
      .addIntegerOption(pageOpt).addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('town').setDescription('Towns: search, details and radar')
    .addSubcommand((s) => s.setName('search').setDescription('Search towns by name')
      .addStringOption((o) => o.setName('query').setDescription('Part of the town name').setRequired(true).setMaxLength(30)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('info').setDescription('Owner, points and island of a town')
      .addStringOption((o) => o.setName('town').setDescription('Town').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('radar').setDescription('Towns around a town or island coordinates')
      .addStringOption((o) => o.setName('town').setDescription('Center town').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('x').setDescription('Island x (use with y instead of a town)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption((o) => o.setName('y').setDescription('Island y (use with x instead of a town)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption((o) => o.setName('radius').setDescription('Radius in islands (default 15, max 150)').setMinValue(1).setMaxValue(150))
      .addBooleanOption((o) => o.setName('ghosts_only').setDescription('Only ghost towns'))
      .addStringOption(worldOpt)),

  // ---- GrepoData City Indexer (needs this server's GrepoData token)
  new SlashCommandBuilder().setName('intel').setDescription('City Indexer intel from GrepoData (this server\'s indexes)').setDMPermission(false)
    .addSubcommand((s) => s.setName('town').setDescription('Latest reports for a town')
      .addStringOption((o) => o.setName('town').setDescription('Town').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('player').setDescription('Indexed towns and troops of a player')
      .addStringOption((o) => o.setName('player').setDescription('Player').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('alliance').setDescription('Indexed towns and troops of an alliance')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('grepodata').setDescription('GrepoData account for intel (admins, private replies)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('token').setDescription('Set the GrepoData token for this server (reply is private)')
      .addStringOption((o) => o.setName('access_token').setDescription('access_token from grepodata.com (browser Local Storage)').setRequired(true).setMaxLength(2000))
      .addStringOption((o) => o.setName('refresh_token').setDescription('refresh_token: lets the bot renew the token by itself (recommended)').setMaxLength(2000)))
    .addSubcommand((s) => s.setName('status').setDescription('Token expiry, auto-renewal and intel channel'))
    .addSubcommand((s) => s.setName('channel').setDescription('Channel where intel is shown publicly (empty: private everywhere)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (leave empty to make intel private everywhere)').addChannelTypes(ChannelType.GuildText, ChannelType.PrivateThread, ChannelType.PublicThread)))
    .addSubcommand((s) => s.setName('clear').setDescription('Remove the GrepoData token from this server')),
];

export const commandJson = () => localizeCommands(commands.map((c) => c.toJSON()));
