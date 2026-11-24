/** Environment configuration. Only DISCORD_TOKEN/CLIENT_ID are needed to run the bot; the CLI needs none. */
const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  discordToken: env.DISCORD_TOKEN ?? '',
  clientId: env.CLIENT_ID ?? '',
  /** If set, commands are registered to this guild only (instant), else globally. */
  devGuildId: env.DEV_GUILD_ID ?? '',
  dbPath: env.DB_PATH ?? './data/grepocord.sqlite',
  markets: (env.MARKETS ?? 'gr,en').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  defaultLang: (env.DEFAULT_LANG === 'el' ? 'el' : 'en') as 'en' | 'el',
  /** How often to poll official files (they change ~hourly; conditional requests make polling cheap). */
  refreshMinutes: num(env.REFRESH_MINUTES, 15),
  /** Self-imposed GrepoData request budget (their fail2ban bans at 400 req/min; be far below). */
  grepodataRpm: num(env.GREPODATA_RPM, 30),
  grepodataBase: env.GREPODATA_BASE ?? 'https://api.grepodata.com',
  userAgent: env.USER_AGENT ?? 'GrepoCord/1.1 (Discord bot; public data only)',
  /**
   * GrepoData City Indexer access (optional). Tokens can also be set per server with /grepodata token.
   * Env tokens are bound to ONE guild (GREPODATA_GUILD_ID, default DEV_GUILD_ID) so intel never leaks to other servers.
   */
  grepodataToken: env.GREPODATA_TOKEN ?? '',
  grepodataRefreshToken: env.GREPODATA_REFRESH_TOKEN ?? '',
  grepodataLogin: env.GREPODATA_LOGIN ?? '',
  grepodataPassword: env.GREPODATA_PASSWORD ?? '',
  grepodataGuildId: env.GREPODATA_GUILD_ID ?? env.DEV_GUILD_ID ?? '',
  /** Discord user to alert about token expiry for env tokens (default: guild owner). */
  grepodataAdminId: env.GREPODATA_ADMIN_ID ?? '',
  /**
   * Gemini (free tier only) for /report and the weekly newspaper. Without a key those features reply with a
   * clear message (the newspaper falls back to a template). Caps stay below the free-tier quota.
   */
  geminiApiKey: env.GEMINI_API_KEY ?? '',
  geminiModel: env.GEMINI_MODEL ?? '',
  geminiRpm: num(env.GEMINI_RPM, 8),
  geminiRpd: num(env.GEMINI_RPD, 400),
  logLevel: env.LOG_LEVEL ?? 'info',
};
