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
  /**
   * Live window / world map web app (Discord Activity + browser dashboard). Served by the bot process on WEB_PORT;
   * started only when PUBLIC_URL or ACTIVITY_CLIENT_ID is set (or WEB_ENABLED=true). See SETUP-ACTIVITY.md.
   */
  publicUrl: (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
  webPort: num(env.WEB_PORT, 8080),
  webEnabled: env.WEB_ENABLED === 'true' || !!(env.PUBLIC_URL || env.ACTIVITY_CLIENT_ID),
  /** HMAC secret for dashboard links/sessions; auto-generated and stored in the DB when empty. */
  webSecret: env.WEB_SECRET ?? '',
  /** The SEPARATE Discord application that hosts the Activity (never the bot's own app). */
  activityClientId: env.ACTIVITY_CLIENT_ID ?? '',
  activityClientSecret: env.ACTIVITY_CLIENT_SECRET ?? '',
  /** Optional Custom Link from the Activity app's portal; default https://discord.com/activities/<ACTIVITY_CLIENT_ID>. */
  activityLink: (env.ACTIVITY_LINK ?? '').trim(),
  /** Live window: seconds between command-share polls, and the share of the GrepoData budget it may use. */
  livePollSeconds: Math.max(3, num(env.LIVE_POLL_SECONDS, 5)),
  liveRpm: Math.max(2, num(env.LIVE_RPM, 12)),
  /** Official Grepolis image CDN for unit/command icons (proxied + cached by the web server, never committed). Empty = own icons only. */
  grepolisCdn: (env.GREPOLIS_CDN ?? 'https://gpnl.innogamescdn.com').trim().replace(/\/+$/, ''),
  privacyContact: env.PRIVACY_CONTACT ?? '',
  /**
   * Bot owner(s): Discord user id(s), comma-separated. Only they can add or remove admin-panel admins and restore
   * backups. Without it, nobody can open /admin (server managers still use the slash commands).
   */
  ownerUserIds: (env.OWNER_USER_ID ?? '').split(/[\s,]+/).filter((x) => /^\d{5,25}$/.test(x)),
  logLevel: env.LOG_LEVEL ?? 'info',
};
