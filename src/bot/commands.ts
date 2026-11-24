/** Slash command definitions (registered via `npm run register`). */
import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const worldOpt = (o: import('discord.js').SlashCommandStringOption) =>
  o.setName('world').setDescription('World id, e.g. gr126 or en180 (default: server world)').setDescriptionLocalizations({ el: 'Κόσμος, π.χ. gr126 (προεπιλογή: κόσμος του server)' }).setAutocomplete(true);

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show what this bot can do').setDescriptionLocalizations({ el: 'Τι μπορεί να κάνει το bot' }),

  new SlashCommandBuilder().setName('setup').setDescription('Server settings (admins)').setDescriptionLocalizations({ el: 'Ρυθμίσεις server (διαχειριστές)' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('world').setDescription('Set the default world').setDescriptionLocalizations({ el: 'Ορισμός προεπιλεγμένου κόσμου' })
      .addStringOption((o) => o.setName('world').setDescription('World id, e.g. gr126').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('language').setDescription('Bot language for this server').setDescriptionLocalizations({ el: 'Γλώσσα του bot για τον server' })
      .addStringOption((o) => o.setName('language').setDescription('Language').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Ελληνικά', value: 'el' })))
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings').setDescriptionLocalizations({ el: 'Εμφάνιση ρυθμίσεων' })),

  new SlashCommandBuilder().setName('player').setDescription('Player stats and history chart').setDescriptionLocalizations({ el: 'Στατιστικά και γράφημα παίκτη' })
    .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true).setAutocomplete(true))
    .addStringOption(worldOpt),

  new SlashCommandBuilder().setName('alliance').setDescription('Alliance stats and history chart').setDescriptionLocalizations({ el: 'Στατιστικά και γράφημα συμμαχίας' })
    .addStringOption((o) => o.setName('name').setDescription('Alliance name').setRequired(true).setAutocomplete(true))
    .addStringOption(worldOpt),

  new SlashCommandBuilder().setName('radar').setDescription('Find inactive players and ghost towns').setDescriptionLocalizations({ el: 'Εύρεση ανενεργών παικτών και πόλεων-φαντασμάτων' })
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

  new SlashCommandBuilder().setName('feed').setDescription('Automatic feeds (admins)').setDescriptionLocalizations({ el: 'Αυτόματες ροές (διαχειριστές)' })
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

  new SlashCommandBuilder().setName('verify').setDescription('Link your Discord account to your in-game player').setDescriptionLocalizations({ el: 'Σύνδεση του Discord σου με τον παίκτη σου' }).setDMPermission(false)
    .addSubcommand((s) => s.setName('start').setDescription('Get a code to put in one of your town names')
      .addStringOption((o) => o.setName('player').setDescription('Your in-game player name').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('check').setDescription('Check your code now'))
    .addSubcommand((s) => s.setName('status').setDescription('Show your link'))
    .addSubcommand((s) => s.setName('unlink').setDescription('Remove your link')),

  new SlashCommandBuilder().setName('roles').setDescription('Automatic roles from in-game alliance (admins)').setDescriptionLocalizations({ el: 'Αυτόματοι ρόλοι από συμμαχία (διαχειριστές)' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('verified').setDescription('Role given to every verified member').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('alliance').setDescription('Give a role to verified members of an alliance')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an alliance role mapping')
      .addStringOption((o) => o.setName('alliance').setDescription('Alliance').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Show role mappings'))
    .addSubcommand((s) => s.setName('sync').setDescription('Sync roles now')),
];

export const commandJson = () => commands.map((c) => c.toJSON());
