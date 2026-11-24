# GrepoCord

_Formerly GrepoDiscord. Upgrading an existing install? See [Upgrading](#upgrading)._

A Grepolis Discord bot for a private alliance server, built so it can go public later (every setting is per server).
MIT licensed. TypeScript, discord.js v14, SQLite via Node's built-in `node:sqlite`, Docker Compose.

## What it does

| Area | Commands | Data source |
|---|---|---|
| Lookups with charts | `/player name` · `/alliance name` (autocomplete) | Current values from the official world files; daily history and ranks from the GrepoData API; charts rendered by the bot (chart.js + node-canvas) |
| Live feeds | `/feed add type:conquests\|alliance\|bp channel [alliance] [player] [ocean] [min_bp] [bp_kind] [skip_ghosts]` · `/feed list` · `/feed remove id` | Diffs between successive official hourly files |
| Radar | `/radar inactive [hours] [ocean] [near_town] [radius] [min_points]` · `/radar ghosts [ocean] [near_town] [radius] [min_points]` | Our own activity tracking from the hourly files. Until enough history exists, GrepoData's `hours_inactive` fills the gap (shown with `*`) |
| Verification + roles | `/verify start player` · `/verify check` · `/verify status` · `/verify unlink` · `/roles verified role` · `/roles alliance alliance role` · `/roles remove alliance` · `/roles list` · `/roles sync` | Public town names in `towns.txt` |
| Rankings and scoreboards | `/top today [kind]` · `/top yesterday [kind]` · `/top hour [hour]` · `/top ranking [kind] [sort] [page]` | GrepoData scoreboards (daily ABP/DBP/conquered/lost, per-hour BP gains) and rankings (points, attack, defence, total BP, towns, members) |
| Wars and history | `/wars alliance` · `/changes alliance\|player\|world` · `/conquests player\|alliance\|town [filter] [page]` | GrepoData alliance wars, join/leave history and full conquest history (enemy, friendly or internal) |
| Towns | `/town search query` · `/town info town` · `/town radar [town] [x y] [radius] [ghosts_only]` | GrepoData town search, town details and radar (falls back to the official files if GrepoData is down) |
| Intel (City Indexer) | `/intel town\|player\|alliance` | GrepoData City Indexer with **this server's** GrepoData token (see [Intel](#intel-grepodata-city-indexer)) |
| GrepoData account (admins) | `/grepodata token access_token [refresh_token]` · `/grepodata status` · `/grepodata channel [channel]` · `/grepodata clear` | Replies are always private |
| War room (admins) | `/warroom place [channel]` · `/warroom remove id` · `/warroom list` · `/warroom refresh` · `/warroom ally alliance` · `/warroom enemy alliance` · `/warroom unset alliance` | A Components V2 board that **edits itself** after every hourly refresh: towns traded vs each enemy (24 h / 7 d), our conquests and losses, top BP movers (24 h window), enemy conquests near our towns and the closest enemy towns. Official files only: costs no GrepoData requests |
| Threat alerts (verified members) | `/alerts on [radius] [min_bp] [scope]` · `/alerts off` · `/alerts status` · `/alerts test` | DMs after the hourly refresh when your town is conquered, or an enemy conquers or founds a town, or gains a lot of attack BP, within `radius` islands of your towns |
| Op planner (land at T) | `/op create target land [name]` · `/op assign op member town unit [travel] [meteorology] [cartography] [lighthouse] [boost] [transport]` · `/op join op town unit […]` · `/op leave` · `/op show` · `/op list` · `/op cancel` | Each member gets a DM with **their own send time** and a reminder 60 s before. **The bot never sends anything in game: the player clicks Send.** |
| Soft targets | `/radar soft [around:me\|alliance] [near_town] [radius] [min_points] [max_points] [ocean] [ghosts]` | Ranks towns near your towns (or the alliance's) 0–100 from public data: inactivity, stagnant points, low defence record and no new defence BP, isolation from alliance-mates, no alliance, small town, just conquered, ghost towns. Our side is excluded |
| Quit prediction | `/quitrisk [player] [alliance] [near_town] [radius] [min_points]` · optional board section via `/warroom options quitters:true` | Score from idle time, points trend, BP trend, towns lost vs taken (7 days) and alliance status, with a confidence % |
| AI reports (Gemini free tier) | `/report parse [text] [image] [town] [private]` (no input = paste box) · right-click a message → Apps → **Parse report** · `/report search town [kind] [page]` · `/report show id` · `/report delete id` | Gemini reads a pasted report or screenshot into units/losses/buildings/resources; stored per Discord server and searchable by town |
| Weekly newspaper (admins) | `/newspaper channel channel [day] [hour]` · `/newspaper preview` · `/newspaper post` · `/newspaper status` · `/newspaper off` | Conquests, wars, risers/fallers and our alliance's week, written by Gemini in the server language; template summary without a key |
| Settings | `/setup world` · `/setup language en\|el` · `/setup show` · `/help` | |

Everything is in English and Greek. Bot replies follow `/setup language`. Command, subcommand, option and choice **names and descriptions** are localized with Discord's `el` locale, so members whose Discord is in Greek see e.g. `/κορυφαίοι σήμερα` or `/πόλη ραντάρ`. A test enforces that every command element has a Greek name and description and that the EN/GR string tables match.

All times from GrepoData are in the world's own time zone (gr worlds: Europe/Athens). The bot converts them to Discord timestamps, so every reader sees their own local time.

## Intel (GrepoData City Indexer)
Intel comes from your **GrepoData account** (the one you use on grepodata.com with the userscript). It is not your game account, and the bot never sees a game password.

- **Scope.** Each Discord server has its own token. Intel is only ever fetched with the token of the server where the command runs, and it is only shown in that server. Replies are private (only the person asking sees them). The exception is the channel an admin picks with `/grepodata channel`: intel asked for there is posted publicly. Caches are kept separate per server.
- **Setting the token.** An admin (Manage Server) runs `/grepodata token access_token:<…> refresh_token:<…>`. The reply is private. Tokens are stored in the SQLite DB, sent only as a request header to api.grepodata.com, and never logged or shown again. `/grepodata status` shows the account name, expiry and auto-renewal state, never the token itself.
- **Where to find the tokens.** Sign in at https://grepodata.com in a desktop browser. Press F12, then open Application (Chrome/Edge) or Storage (Firefox) → Local Storage → `https://grepodata.com`. Copy the values of `access_token` and `refresh_token`.
- **Expiry and renewal.** GrepoData access tokens last **24 h**. Refresh tokens last **90 days** and are replaced on every use.
  - **With a refresh token:** about 2 h before the access token expires, the bot calls `POST /auth/refresh` and stores the new pair. This repeats every day, so the 90-day window keeps moving and no further action is needed.
  - **Without a refresh token:** the bot DMs the admin who set the token about 6 h before it expires, and again when it has expired.
  - **If renewal is rejected:** the bot stops trying (GrepoData bans IPs that cause many 401s), pauses intel and DMs the admin.
  - **Optional fallback:** `GREPODATA_LOGIN` / `GREPODATA_PASSWORD` let the bot log in again with `POST /auth/login`. This only works for the server in `GREPODATA_GUILD_ID`. It is not needed if you give a refresh token.
- **Token from `.env`.** Instead of the command you can set `GREPODATA_TOKEN` (and preferably `GREPODATA_REFRESH_TOKEN`). These are bound to **one** server: `GREPODATA_GUILD_ID`, or `DEV_GUILD_ID` if that is empty. A newer token set with `/grepodata token`, or a renewed one, takes precedence. The `.env` value is only applied again when you change it to a newer token.

## War room, threat alerts and the op planner
- **Sides.** `/warroom ally` and `/warroom enemy` set our side and the enemies per world. Left empty, they are automatic: our side is the alliances of verified members, and enemies are the (up to 5) alliances that took the most towns from us in the last 7 days. Boards and threat alerts both use these sides.
- **Boards** are one message each, edited in place after every world-data refresh (and with the 🔄 button, at most once a minute). If someone deletes the message, the bot posts a new one. The bot needs View Channel and Send Messages in that channel.
- **Threat alerts** are opt-in per member and need `/verify`. `scope:enemies` (default) watches the enemy list, or everyone outside our side if no enemies are set; `scope:all` always watches everyone outside our side. `/alerts test` previews the last 24 h.
- **Op planner.** The landing time is entered in **server (world) time**, the clock the game shows (gr worlds: Europe/Athens): `2026-11-25 21:30:00`, `25/11 21:30` or `21:30:00`. Every reply also shows Discord timestamps, so readers see their own local time.
  - **Exact:** give `travel:` = the travel time the game shows in the attack window (it already includes your bonuses). The send time is then exactly landing − travel.
  - **Estimate:** without `travel:`, the bot estimates from the map (`50 × distance_px / speed + 900 / world speed`, speeds from the world's `units.json` with meteorology/cartography/lighthouse/boost applied; land units on another island travel at the speed of their boats). Town positions inside an island are not public, so this is shown as **≈ ± a few minutes**. Use `travel:` for real ops.
  - The anti-timing rule (±10 s on every command) still applies in game.

## AI features (Gemini, free tier only)
- **Key.** Create one at https://aistudio.google.com/apikey in a Google project **without billing**. Such a project stays on the free tier and cannot be charged. Put it in `.env` as `GEMINI_API_KEY`. No key: `/report` answers with a clear message and the newspaper uses a template.
- **Model.** Default `gemini-3.5-flash-lite` (text + images, free tier). `GEMINI_MODEL` accepts only free-tier flash models; pro/paid models are refused and replaced by the default.
- **Limits.** All AI calls go through one queue capped at `GEMINI_RPM` (default 8/min) and `GEMINI_RPD` (default 400 per Pacific day, counted in the DB), below the free-tier quota. On a 429 the bot waits for Google's retry delay; if the daily quota is gone, AI features pause until midnight Pacific (10:00 Greek time) and say so. One user can parse a report every 20 s. `/newspaper status` shows today's usage.
- **Privacy.** Only what members paste or attach (and, for the newspaper, public world numbers) is sent to Google. On the free tier Google may use prompts to improve its products, so do not paste anything private. Reports are stored only in this bot's DB, per Discord server.
- **Accuracy.** The AI can misread numbers, especially on blurry screenshots. Every parsed report says so; pasted text is more reliable than images.

## Soft targets and quit prediction
- Built only from public data: the hourly official files (players, towns, conquests, kill points), the bot's activity tracking, and a **daily snapshot** of every player and alliance the bot stores itself (kept 40 days).
- Trends (points, BP, newspaper risers/fallers) compare with the stored day closest to a week ago, so they get useful after the bot has run for a few days and complete after 7. Until then the reply shows fewer signals and a lower confidence.
- Scores are heuristics, not facts: scout before you attack.

### Verification: why a town name and not the profile text
Grepolis profile texts are **not public**. They are not in the official world data files or in GrepoData's public API. The only way to read them is inside the logged-in game client, and a bot logging into the game breaks InnoGames' rules (§2 account usage, §7 bots/automation). Town names **are** public: they appear in the hourly `towns.txt`. So the member renames **one of their own towns** to include a short code (e.g. `02. Sparta GD7KQ2`), and the bot sees it in the next hourly file. The bot only reads public data, and the human makes the in-game change. Codes expire after 48 h. The bot also checks automatically after each towns refresh, sends the member a DM when verified, and the town can be renamed back afterwards.

Roles: `/roles verified` sets a role for every linked member, and `/roles alliance` maps an in-game alliance to a Discord role. Every hour, after the players file changes, the bot re-syncs. Leaving an alliance removes its role, joining a mapped one adds it, and a deleted account loses all managed roles. **The bot only ever adds or removes the roles you configured.**

## ToS compliance (InnoGames)
- No game login, no session cookies, no game passwords, no internal game (AJAX) API, and no automated in-game actions of any kind.
- AI (optional, Gemini) only sees what members paste or attach, and public world numbers for the newspaper. It never touches the game.
- Reads only public data: `https://{world}.grepolis.com/data/*.txt.gz` (with ETag/If-Modified-Since, about 8 small requests per world every 15 min, mostly 304s) and GrepoData's public API.
- GrepoData politeness:
  - one shared budget (`GREPODATA_RPM`, default 30/min against their ~400/min ban threshold)
  - per-endpoint caching: 10 min for info and scoreboards, 15 min for changes and conquests, 30 min for rankings and towns, 60 min for history and wars, 5 min for intel, 6 h for the world list
  - request de-duplication, stale-if-error, and exponential backoff with a global pause on 429/503
  - 4xx responses are never retried, which matters for 401s with their fail2ban

## Architecture
```
src/
  data/parse.ts        pure parsers for official files (PHP urlencoded names)
  data/snapshot.ts     in-memory world snapshot + name search
  data/official.ts     conditional download of world files (ETag/IMS, retries)
  data/grepodata.ts    GrepoData client (rate limit, cache, backoff; public + intel + auth endpoints)
  data/ratelimit.ts    limiter, TTL cache, backoff
  diff.ts              conquests / alliance changes / BP deltas / activity (pure)
  feeds.ts feedPlan.ts feed filters + "what to post" planning (pure)
  radar.ts verify.ts roles.ts   pure logic
  refresh.ts           WorldManager: refresh → events
  embeds.ts charts.ts i18n.ts   presentation
  services.ts          use-cases shared by bot and CLI
  gdServices.ts gdViews.ts   GrepoData features: use-cases + embeds (pure)
  gdAuth.ts            GrepoData tokens: JWT decode, renewal plan, guild scoping
  time.ts              world-local time → Discord timestamps
  dbPath.ts            grepodiscord.sqlite → grepocord.sqlite migration
  db.ts                SQLite store (node:sqlite)
  bot/                 commands (+ commandsEl.ts Greek names), handlers, gdHandlers, poster, scheduler, tokenCare
  index.ts register.ts cli.ts
```
**Why SQLite?** A private alliance bot writes a few rows an hour. `node:sqlite` is built into Node ≥ 22.13, so there is no native DB module to compile, no DB container, and backups are a single file (`data/grepocord.sqlite`). It stores guild config, feeds, links, pending codes, GrepoData tokens per server, the last version of each world file (gzipped, for diffs), and per-player activity. For a big public deployment, swap `src/db.ts` for PostgreSQL behind the same methods.

## Setup

### 1. Create the Discord application
1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it as `DISCORD_TOKEN`. No privileged intents are needed: leave Presence, Server Members and Message Content **off**.
3. **General Information** → copy **Application ID** as `CLIENT_ID`.
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`. Bot permissions: **View Channels, Send Messages, Embed Links, Attach Files, Manage Roles**. Open the URL and add the bot to your server.
5. In Server Settings → Roles, drag the bot's role **above** every role it should manage.
6. (Recommended for a private bot) Enable Developer Mode in Discord, right-click your server → Copy Server ID, and use it as `DEV_GUILD_ID` so commands register instantly.

### 2. Configure
```bash
cp .env.example .env    # fill DISCORD_TOKEN, CLIENT_ID, DEV_GUILD_ID, USER_AGENT contact
```
| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DISCORD_TOKEN` | yes (bot/register) | | Bot token |
| `CLIENT_ID` | yes (register) | | Application ID |
| `DEV_GUILD_ID` | no | | Register commands to this server only (instant). Empty = global (up to ~1 h) |
| `DB_PATH` | no | `./data/grepocord.sqlite` | SQLite file. An old `grepodiscord.sqlite` in the same folder is renamed automatically |
| `MARKETS` | no | `gr,en` | Accepted markets |
| `DEFAULT_LANG` | no | `en` | `en` or `el` for new servers |
| `REFRESH_MINUTES` | no | `15` | Poll interval for official files |
| `GREPODATA_RPM` | no | `30` | GrepoData request budget per minute |
| `USER_AGENT` | no | `GrepoCord/1.1 …` | Sent to grepolis.com/grepodata.com. Put a contact address in it |
| `GREPODATA_TOKEN` | no | | GrepoData `access_token` for intel (alternative to `/grepodata token`) |
| `GREPODATA_REFRESH_TOKEN` | no | | GrepoData `refresh_token`: enables automatic daily renewal (recommended) |
| `GREPODATA_GUILD_ID` | no | `DEV_GUILD_ID` | The one Discord server the `.env` token belongs to |
| `GREPODATA_ADMIN_ID` | no | server owner | Discord user ID to DM about the `.env` token expiring |
| `GREPODATA_LOGIN` / `GREPODATA_PASSWORD` | no | | Optional GrepoData (not game!) login for re-login when no refresh token works |
| `LOG_LEVEL` | no | `info` | `debug`/`info`/`warn`/`error` |

### 3a. Deploy with Docker Compose (on your server)
```bash
docker compose build
docker compose run --rm register        # register slash commands (once, and after command changes)
docker compose up -d                    # start the bot
docker compose logs -f bot
```
Data persists in `./data` (back up `data/grepocord.sqlite`). Update: `git pull && docker compose build && docker compose run --rm register && docker compose up -d`.

The container starts as root only to create `/app/data` and `chown` it to the `node` user. That fixes the "unable to open database file" error you get when Docker creates `./data` as root. It then drops privileges with `setpriv` and runs the bot as `node`.

## Upgrading
### From GrepoDiscord (v1) to GrepoCord
The image and container are renamed `grepodiscord` → `grepocord`. Your `.env` and `./data` stay where they are. On first start, `data/grepodiscord.sqlite` (with its `-wal`/`-shm` files) is renamed to `data/grepocord.sqlite`.

Run these in the folder that holds `docker-compose.yml`, `.env` and `data/`:
```bash
docker compose down                     # stop the OLD container (grepodiscord) while the old compose file is still checked out
git pull
docker compose build
docker compose run --rm register        # re-register: new commands + Greek command names (needed after every update that adds commands)
docker compose up -d
docker compose logs -f bot              # expect "Migrated database /app/data/grepodiscord.sqlite -> /app/data/grepocord.sqlite" once
```
- **Already pulled before running `docker compose down`?** Remove the old container by name with `docker rm -f grepodiscord`, then continue with `docker compose build`.
- **Optional cleanup:** remove the old image with `docker image rm grepodiscord:latest`.
- **Your `.env`:** it may still say `USER_AGENT=GrepoDiscord/…`. That still works, but you can rename it.
- **Explicit `DB_PATH`:** if your `.env` sets `DB_PATH`, the compose file overrides it inside the container. Outside Docker it is respected as-is.

### 3b. Run without Docker (Node ≥ 22.13; tested on Node 24)
```bash
npm ci
npm run build
npm run register
npm start
```

### 4. First use in Discord
1. `/setup world gr125` (or your world), then `/setup language el` if you want Greek.
2. `/feed add type:conquests channel:#conquests alliance:<yours>`. Add an enemy alliance feed or `ocean:45,46` as needed.
3. `/feed add type:alliance channel:#diplomacy` and `/feed add type:bp channel:#war min_bp:10000`.
4. `/roles verified role:@Verified`, then `/roles alliance alliance:<yours> role:@Member`.
5. Members run `/verify start player:<name>`, rename a town, and get their roles automatically within about an hour.

Feeds start from a baseline the first time a world loads: old history is never posted. Alliance-change and BP feeds fire after the **second** hourly file version.

## Dry run / CLI (no Discord token needed)
```bash
npm run build
npm run cli -- worlds
npm run cli -- player gr126 "ultramike99" --lang el --out data/player.png
npm run cli -- alliance en180 "GoldHunter" --out data/alliance.png
npm run cli -- radar-inactive en180 --hours 24 --ocean 45
npm run cli -- radar-ghosts gr126 --near "04." --radius 150
npm run cli -- refresh gr126 --since-hours 3      # prints the embeds each feed would post
npm run cli -- verify-check gr126 "Player" GDABCD
npm run cli -- top-today gr125 --kind alliance [--yesterday]
npm run cli -- top-hour gr125 --hour 17
npm run cli -- ranking gr125 --kind alliance --sort Att
npm run cli -- wars gr125 "EL-TRUCOOOOO"
npm run cli -- changes gr125 alliance "EL-TRUCOOOOO"
npm run cli -- conquests gr125 player "Grimmjow" --filter enemy --page 2
npm run cli -- town-search gr125 zagan
npm run cli -- town-radar gr125 "ZAGAN 14" --radius 40   # or --x 500 --y 500
npm run cli -- token-status                       # decodes GREPODATA_TOKEN (account, expiry); no network, never prints it
npm run cli -- intel gr125 town "ZAGAN 14"         # uses GREPODATA_TOKEN from the environment
npm run smoke                                     # drives the real handlers with fake interactions
npm run smoke:batch1                              # war room, alerts, op planner (live gr125 data, fake Discord)
npm run smoke:batch2                              # soft targets, quit risk, reports, newspaper (fake Gemini unless SMOKE_GEMINI=1)
```
The CLI keeps its own DB (`CLI_DB_PATH`, default `./data/cli.sqlite`). Run `refresh` again after the next hourly file update to see real alliance-change and BP diffs. With Docker: `docker compose run --rm cli refresh gr126`.

## Development
```bash
npm run typecheck   # tsc (src + tests)
npm test            # vitest: parsers, diffs, feeds, radar, verification, roles, limiter, GrepoData client/auth/views, Greek command localization, i18n, store
npm run build       # → compiled/
```

## Known limits
- Official files update about hourly and at staggered times, so feeds are at most ~1 h behind. That is the same for every tool.
- Soft-target and quit scores need a few days of the bot's own daily history for trends (the footer shows how many days exist).
- AI report parsing can misread numbers; check before acting. Discord slash options flatten newlines, so long pasted reports work best with the paste box (`/report parse` without options) or a screenshot.
- Op planner estimates without `travel:` can be several minutes off (town slot positions inside islands are not public). With the in-game travel time they are exact.
- Threat alerts and boards see what the hourly public files show: conquests, new towns and BP changes. Incoming attacks are not public, so they cannot be detected.
- Distances use island coordinates. Exact in-game distance also depends on the town's slot inside the island, and those templates are not public.
- The inactive radar needs N hours of our own tracking. Before that it asks GrepoData for up to 10 candidates per query.
- GrepoData's public API is undocumented and could change. Lookups fall back to official data (without charts) if it fails.
- GrepoData's `/town/radar` is centred on a town. For x/y coordinates the bot uses the nearest town as the anchor and filters by island distance itself.
- Intel requires a GrepoData account that is a member of the relevant City Indexer teams. The bot only shows what that account can see.
