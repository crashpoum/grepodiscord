# GrepoDiscord v1

A Grepolis Discord bot for a private alliance server, built so it can go public later (every setting is per server).
MIT licensed. TypeScript, discord.js v14, SQLite via Node's built-in `node:sqlite`, Docker Compose.

## What it does (v1)

| Area | Commands | Data source |
|---|---|---|
| Lookups with charts | `/player name` · `/alliance name` (autocomplete) | Current values from the official world files; daily history and ranks from the GrepoData API; charts rendered by the bot (chart.js + node-canvas) |
| Live feeds | `/feed add type:conquests\|alliance\|bp channel [alliance] [player] [ocean] [min_bp] [bp_kind] [skip_ghosts]` · `/feed list` · `/feed remove id` | Diffs between successive official hourly files |
| Radar | `/radar inactive [hours] [ocean] [near_town] [radius] [min_points]` · `/radar ghosts [ocean] [near_town] [radius] [min_points]` | Our own activity tracking from the hourly files. Until enough history exists, GrepoData's `hours_inactive` fills the gap (shown with `*`) |
| Verification + roles | `/verify start player` · `/verify check` · `/verify status` · `/verify unlink` · `/roles verified role` · `/roles alliance alliance role` · `/roles remove alliance` · `/roles list` · `/roles sync` | Public town names in `towns.txt` |
| Settings | `/setup world` · `/setup language en\|el` · `/setup show` · `/help` | |

Commands are localized in English and Greek (`/setup language`). The Greek command descriptions use Discord's `el` locale.

### Verification: why a town name and not the profile text
Grepolis profile texts are **not public**. They are not in the official world data files or in GrepoData's public API. The only way to read them is inside the logged-in game client, and a bot logging into the game breaks InnoGames' rules (§2 account usage, §7 bots/automation). Town names **are** public: they appear in the hourly `towns.txt`. So the member renames **one of their own towns** to include a short code (e.g. `02. Sparta GD7KQ2`), and the bot sees it in the next hourly file. The bot only reads public data, and the human makes the in-game change. Codes expire after 48 h. The bot also checks automatically after each towns refresh, sends the member a DM when verified, and the town can be renamed back afterwards.

Roles: `/roles verified` sets a role for every linked member, and `/roles alliance` maps an in-game alliance to a Discord role. Every hour, after the players file changes, the bot re-syncs. Leaving an alliance removes its role, joining a mapped one adds it, and a deleted account loses all managed roles. **The bot only ever adds or removes the roles you configured.**

## ToS compliance (InnoGames)
- No game login, no session cookies, no game passwords, no internal game (AJAX) API, and no automated in-game actions of any kind.
- Reads only public data: `https://{world}.grepolis.com/data/*.txt.gz` (with ETag/If-Modified-Since, about 8 small requests per world every 15 min, mostly 304s) and GrepoData's public API.
- GrepoData politeness: one shared budget (`GREPODATA_RPM`, default 30/min against their ~400/min ban threshold), per-endpoint caching (10 min info, 60 min history, 6 h world list), request de-duplication, stale-if-error, and exponential backoff with a global pause on 429/503.

## Architecture
```
src/
  data/parse.ts        pure parsers for official files (PHP urlencoded names)
  data/snapshot.ts     in-memory world snapshot + name search
  data/official.ts     conditional download of world files (ETag/IMS, retries)
  data/grepodata.ts    GrepoData client (rate limit, cache, backoff)
  data/ratelimit.ts    limiter, TTL cache, backoff
  diff.ts              conquests / alliance changes / BP deltas / activity (pure)
  feeds.ts feedPlan.ts feed filters + "what to post" planning (pure)
  radar.ts verify.ts roles.ts   pure logic
  refresh.ts           WorldManager: refresh → events
  embeds.ts charts.ts i18n.ts   presentation
  services.ts          use-cases shared by bot and CLI
  db.ts                SQLite store (node:sqlite)
  bot/                 commands, handlers, poster (feeds/roles/verification), scheduler
  index.ts register.ts cli.ts
```
**Why SQLite?** A private alliance bot writes a few rows an hour. `node:sqlite` is built into Node ≥ 22.13, so there is no native DB module to compile, no DB container, and backups are a single file (`data/grepodiscord.sqlite`). It stores guild config, feeds, links, pending codes, the last version of each world file (gzipped, for diffs), and per-player activity. For a big public deployment, swap `src/db.ts` for PostgreSQL behind the same methods.

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
| `DB_PATH` | no | `./data/grepodiscord.sqlite` | SQLite file |
| `MARKETS` | no | `gr,en` | Accepted markets |
| `DEFAULT_LANG` | no | `en` | `en` or `el` for new servers |
| `REFRESH_MINUTES` | no | `15` | Poll interval for official files |
| `GREPODATA_RPM` | no | `30` | GrepoData request budget per minute |
| `USER_AGENT` | no | `GrepoDiscord/1.0 …` | Sent to grepolis.com/grepodata.com. Put a contact address in it |
| `LOG_LEVEL` | no | `info` | `debug`/`info`/`warn`/`error` |

### 3a. Deploy with Docker Compose (on your server)
```bash
docker compose build
docker compose run --rm register        # register slash commands (once, and after command changes)
docker compose up -d                    # start the bot
docker compose logs -f bot
```
Data persists in `./data` (back up `data/grepodiscord.sqlite`). Update: `git pull && docker compose build && docker compose run --rm register && docker compose up -d`.

### 3b. Run without Docker (Node ≥ 22.13; tested on Node 24)
```bash
npm ci
npm run build
npm run register
npm start
```

### 4. First use in Discord
1. `/setup world gr126` (or your world), then `/setup language el` if you want Greek.
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
npm run smoke                                     # drives the real handlers with fake interactions
```
The CLI keeps its own DB (`CLI_DB_PATH`, default `./data/cli.sqlite`). Run `refresh` again after the next hourly file update to see real alliance-change and BP diffs. With Docker: `docker compose run --rm cli refresh gr126`.

## Development
```bash
npm run typecheck   # tsc (src + tests)
npm test            # vitest: parsers, diffs, feeds, radar, verification, roles, limiter, client, i18n, store
npm run build       # → compiled/
```

## Known limits
- Official files update about hourly and at staggered times, so feeds are at most ~1 h behind. That is the same for every tool.
- Distances use island coordinates. Exact in-game distance also depends on the town's slot inside the island, and those templates are not public.
- The inactive radar needs N hours of our own tracking. Before that it asks GrepoData for up to 10 candidates per query.
- GrepoData's public API is undocumented and could change. Lookups fall back to official data (without charts) if it fails.
