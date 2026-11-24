/** Environment configuration. Only DISCORD_TOKEN/CLIENT_ID are needed to run the bot; the CLI needs none. */
const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  discordToken: env.DISCORD_TOKEN ?? '',
  clientId: env.CLIENT_ID ?? '',
  /** If set, commands are registered to this guild only (instant), else globally. */
  devGuildId: env.DEV_GUILD_ID ?? '',
  dbPath: env.DB_PATH ?? './data/grepodiscord.sqlite',
  markets: (env.MARKETS ?? 'gr,en').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  defaultLang: (env.DEFAULT_LANG === 'el' ? 'el' : 'en') as 'en' | 'el',
  /** How often to poll official files (they change ~hourly; conditional requests make polling cheap). */
  refreshMinutes: num(env.REFRESH_MINUTES, 15),
  /** Self-imposed GrepoData request budget (their fail2ban bans at 400 req/min; be far below). */
  grepodataRpm: num(env.GREPODATA_RPM, 30),
  grepodataBase: env.GREPODATA_BASE ?? 'https://api.grepodata.com',
  userAgent: env.USER_AGENT ?? 'GrepoDiscord/1.0 (Discord bot; public data only)',
  logLevel: env.LOG_LEVEL ?? 'info',
};
