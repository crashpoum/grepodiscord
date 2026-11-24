/**
 * Slash command definitions (registered via `npm run register`).
 * English is the default; every command, subcommand, option and choice gets a Greek (el) name and
 * description from ./commandsEl.ts (applied in commandJson, enforced by test/commands.test.ts).
 */
import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder, PermissionFlagsBits, SlashCommandBuilder, type SlashCommandStringOption, type SlashCommandIntegerOption, type SlashCommandSubcommandBuilder } from 'discord.js';
import { localizeCommands } from './commandsEl.js';

const worldOpt = (o: SlashCommandStringOption) => o.setName('world').setDescription('World id, e.g. gr125 or en180 (default: server world)').setAutocomplete(true);
const pageOpt = (o: SlashCommandIntegerOption) => o.setName('page').setDescription('Page (default 1)').setMinValue(1).setMaxValue(50);
const kindOpt = (o: SlashCommandStringOption) => o.setName('kind').setDescription('Players or alliances (default: players)')
  .addChoices({ name: 'players', value: 'player' }, { name: 'alliances', value: 'alliance' });

const opIdOpt = (o: SlashCommandIntegerOption) => o.setName('op').setDescription('Op number').setRequired(true).setMinValue(1).setAutocomplete(true);
/** Shared options for /op assign and /op join: origin town, unit, optional in-game travel time and speed modifiers. */
const opSendOpts = (s: SlashCommandSubcommandBuilder) => s // call AFTER the subcommand's own required options
  .addStringOption((o) => o.setName('town').setDescription('Town you send from').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('unit').setDescription('Slowest unit in the attack').setRequired(true).setAutocomplete(true))
  .addStringOption((o) => o.setName('travel').setDescription('Travel time shown in the game, e.g. 1:23:45 (exact send time)').setMaxLength(20))
  .addBooleanOption((o) => o.setName('meteorology').setDescription('Meteorology researched (+10% land units)'))
  .addBooleanOption((o) => o.setName('cartography').setDescription('Cartography researched (+10% ships)'))
  .addBooleanOption((o) => o.setName('lighthouse').setDescription('Lighthouse built (+15% ships)'))
  .addIntegerOption((o) => o.setName('boost').setDescription('Other speed bonus in % (hero, spell, movement boost)').setMinValue(0).setMaxValue(200))
  .addStringOption((o) => o.setName('transport').setDescription('Boats for land units (default: transport boat)')
    .addChoices({ name: 'transport boat', value: 'big_transporter' }, { name: 'fast transport ship', value: 'small_transporter' }));

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
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('soft').setDescription('Soft targets near your towns or alliance, ranked 0-100')
      .addStringOption((o) => o.setName('around').setDescription('Measure distance from (default: your towns if verified, else alliance)')
        .addChoices({ name: 'my towns', value: 'me' }, { name: 'our alliance', value: 'alliance' }))
      .addStringOption((o) => o.setName('near_town').setDescription('Or: around this town instead').setAutocomplete(true))
      .addIntegerOption((o) => o.setName('radius').setDescription('Max distance in islands (default 15)').setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName('min_points').setDescription('Minimum player points').setMinValue(0))
      .addIntegerOption((o) => o.setName('max_points').setDescription('Maximum player points').setMinValue(0))
      .addStringOption((o) => o.setName('ocean').setDescription('Ocean(s), e.g. 45 or 45,46'))
      .addBooleanOption((o) => o.setName('ghosts').setDescription('Include ghost towns (default: yes)'))
      .addStringOption(worldOpt)),

  new SlashCommandBuilder().setName('quitrisk').setDescription('Who is likely to quit or go inactive (public trends)')
    .addStringOption((o) => o.setName('player').setDescription('One player: detailed breakdown').setAutocomplete(true))
    .addStringOption((o) => o.setName('alliance').setDescription('Rank the members of this alliance').setAutocomplete(true))
    .addStringOption((o) => o.setName('near_town').setDescription('Rank players around this town').setAutocomplete(true))
    .addIntegerOption((o) => o.setName('radius').setDescription('Distance from near_town in islands (default 20)').setMinValue(1).setMaxValue(100))
    .addIntegerOption((o) => o.setName('min_points').setDescription('Minimum player points').setMinValue(0))
    .addStringOption(worldOpt),

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

  // ---- War room (Components V2 board that edits itself after each world-data refresh)
  new SlashCommandBuilder().setName('warroom').setDescription('Auto-updating war-room board (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('place').setDescription('Post a war-room board that updates itself every hour')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a board').addIntegerOption((o) => o.setName('id').setDescription('Board number').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('list').setDescription('Boards and war sides').addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('refresh').setDescription('Update all boards of this server now'))
    .addSubcommand((s) => s.setName('ally').setDescription('Mark an alliance as our side')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('enemy').setDescription('Mark an alliance as an enemy')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('options').setDescription('Extra board sections: enemy quit watch, soft targets')
      .addBooleanOption((o) => o.setName('quitters').setDescription('Show enemies likely to quit'))
      .addBooleanOption((o) => o.setName('soft_targets').setDescription('Show soft targets near us')))
    .addSubcommand((s) => s.setName('unset').setDescription('Remove an alliance from both sides')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)).addStringOption(worldOpt)),

  // ---- Personal town-threat alerts (verified members, DMs)
  new SlashCommandBuilder().setName('alerts').setDescription('DM alerts when enemies act near your towns').setDMPermission(false)
    .addSubcommand((s) => s.setName('on').setDescription('Turn threat alerts on (or change settings)')
      .addIntegerOption((o) => o.setName('radius').setDescription('Distance from your towns in islands (default 10)').setMinValue(1).setMaxValue(50))
      .addIntegerOption((o) => o.setName('min_bp').setDescription('Attack-BP gain per hour that counts as a threat (default 3000)').setMinValue(100))
      .addStringOption((o) => o.setName('scope').setDescription('Whom to watch (default: enemy alliances)')
        .addChoices({ name: 'enemy alliances', value: 'enemies' }, { name: 'everyone outside our side', value: 'all' })))
    .addSubcommand((s) => s.setName('off').setDescription('Turn threat alerts off'))
    .addSubcommand((s) => s.setName('status').setDescription('Show your alert settings'))
    .addSubcommand((s) => s.setName('test').setDescription('Preview what the last 24 hours would have sent you')),

  // ---- Land-at-T op planner (the bot only tells players when to click Send)
  new SlashCommandBuilder().setName('op').setDescription('Plan a timed op: everyone gets their own send time').setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Create an op: target town and landing time (server time)')
      .addStringOption((o) => o.setName('target').setDescription('Target town').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('land').setDescription('Landing time, server time: 2026-11-25 21:30:00, 25/11 21:30 or 21:30:00').setRequired(true).setMaxLength(40))
      .addStringOption((o) => o.setName('name').setDescription('Op name').setMaxLength(60))
      .addStringOption(worldOpt))
    .addSubcommand((s) => opSendOpts(s.setName('assign').setDescription('Assign a member: they get a DM with their send time')
      .addIntegerOption(opIdOpt).addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))))
    .addSubcommand((s) => opSendOpts(s.setName('join').setDescription('Join an op yourself and get your send time').addIntegerOption(opIdOpt)))
    .addSubcommand((s) => s.setName('leave').setDescription('Leave an op').addIntegerOption(opIdOpt))
    .addSubcommand((s) => s.setName('show').setDescription('Show an op and everyone\'s send times').addIntegerOption(opIdOpt))
    .addSubcommand((s) => s.setName('list').setDescription('Open ops on this server'))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel an op (creator or admins)').addIntegerOption(opIdOpt)),

  // ---- AI report parser (Gemini free tier)
  new SlashCommandBuilder().setName('report').setDescription('Parse and store battle/spy reports (AI), search them by town').setDMPermission(false)
    .addSubcommand((s) => s.setName('parse').setDescription('Paste a report or attach a screenshot (empty = paste box)')
      .addStringOption((o) => o.setName('text').setDescription('Report text copied from the game').setMaxLength(6000))
      .addAttachmentOption((o) => o.setName('image').setDescription('Screenshot of the report'))
      .addStringOption((o) => o.setName('town').setDescription('Town the report is about (if not detected)').setAutocomplete(true))
      .addBooleanOption((o) => o.setName('private').setDescription('Only you see the result (still stored for the server)'))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('search').setDescription('Stored reports about a town')
      .addStringOption((o) => o.setName('town').setDescription('Town').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('kind').setDescription('Report type').addChoices(
        { name: 'attack', value: 'attack' }, { name: 'defense', value: 'defense' }, { name: 'spy', value: 'spy' },
        { name: 'support', value: 'support' }, { name: 'conquest', value: 'conquest' }, { name: 'other', value: 'other' }))
      .addIntegerOption(pageOpt).addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('show').setDescription('Show a stored report')
      .addIntegerOption((o) => o.setName('id').setDescription('Report number').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a stored report (author or admins)')
      .addIntegerOption((o) => o.setName('id').setDescription('Report number').setRequired(true).setMinValue(1))),

  // ---- Weekly newspaper (Gemini, template fallback)
  new SlashCommandBuilder().setName('newspaper').setDescription('Weekly world newspaper (admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('channel').setDescription('Post the newspaper every week in this channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('day').setDescription('Day of the week (default Sunday)').addChoices(
        { name: 'Monday', value: 1 }, { name: 'Tuesday', value: 2 }, { name: 'Wednesday', value: 3 }, { name: 'Thursday', value: 4 },
        { name: 'Friday', value: 5 }, { name: 'Saturday', value: 6 }, { name: 'Sunday', value: 0 }))
      .addIntegerOption((o) => o.setName('hour').setDescription('Hour, server time (default 20)').setMinValue(0).setMaxValue(23))
      .addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('preview').setDescription('Write this week\'s newspaper now (only you see it)').addStringOption(worldOpt))
    .addSubcommand((s) => s.setName('post').setDescription('Post this week\'s newspaper to the channel now'))
    .addSubcommand((s) => s.setName('status').setDescription('Newspaper schedule and AI usage'))
    .addSubcommand((s) => s.setName('off').setDescription('Stop the weekly newspaper')),

  // ---- Live window / world map (Discord Activity of a separate app, or a personal browser link)
  new SlashCommandBuilder().setName('live').setDescription('Live window: shared commands and latest intel (Activity or browser)').setDMPermission(false)
    .addBooleanOption((o) => o.setName('share').setDescription('Post the Activity link in this channel so others can join')),
  new SlashCommandBuilder().setName('map').setDescription('Interactive world map with a conquest timeline (Activity or browser)').setDMPermission(false)
    .addBooleanOption((o) => o.setName('share').setDescription('Post the Activity link in this channel so others can join')),

  // ---- GrepoGod troop sync (userscript pushes a snapshot; this server never talks to the game)
  new SlashCommandBuilder().setName('grepogod').setDescription('Link GrepoGod so this server can see your troops').setDMPermission(false)
    .addSubcommand((s) => s.setName('link').setDescription('Get a private key for GrepoGod (or replace your existing key)'))
    .addSubcommand((s) => s.setName('unlink').setDescription('Delete your key and troop data from this server')),
];

/** Message actions (right-click a message → Apps). Names may contain spaces; localized in commandJson. */
export const contextCommands = [
  new ContextMenuCommandBuilder().setName('Parse report').setType(ApplicationCommandType.Message).setDMPermission(false),
];

export const CONTEXT_EL: Record<string, string> = { 'Parse report': 'Ανάλυση αναφοράς' };
export const commandJson = () => [
  ...localizeCommands(commands.map((c) => c.toJSON())),
  ...contextCommands.map((c) => { const j = c.toJSON(); return { ...j, name_localizations: { el: CONTEXT_EL[j.name] ?? j.name } }; }),
];
