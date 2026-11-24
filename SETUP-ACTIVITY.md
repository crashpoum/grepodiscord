# Live window & world map: Discord Activity + browser dashboard

This guide sets up `/live` and `/map` (Greek: `/ζωντανά`, `/χάρτης`):

* **Live window**: GrepoData shared commands (command share / "ops") for your world, with incoming attacks first and a live countdown. It also shows the latest intel and recent conquests of your index.
* **World map**: every town coloured by owner (our side vs enemies, or by alliance). A **time slider replays conquests** from the official conquers file. It also has a towns-per-alliance chart from the bot's stored daily history, and can draw the live commands on the map.

It works in two ways. Both serve the same pages from the bot container.

| Mode | What users click | Needs |
|---|---|---|
| **Discord Activity** (inside Discord) | the **Open in Discord** button of `/live` / `/map`, or the App Launcher 🚀 | a *separate* Discord app with Activities on. It is unverified until Discord verifies it (see [§5](#5-the-25-member-limit-and-verification)) |
| **Browser dashboard** (fallback) | the **Open in browser** button (a personal signed link, 12 h), or *Sign in with Discord* | only `PUBLIC_URL` (sign-in also needs the Activity app's OAuth2 credentials) |

```
Discord client ──► <activity-id>.discordsays.com ─┐   (Discord's proxy, URL Mapping "/")
Browser ───────────────────────────────────────────┤
                                                   ▼
                          https://grepo.example.com (Cloudflare)
                                                   │  named tunnel (outbound only, no open ports)
                                   cloudflared ────┘──► http://bot:8080 (web app inside the bot container)
```

The bot calls GrepoData **once per server** and caches the result. Every viewer then reads that cache. With nobody watching, it makes **no** GrepoData calls (polling stops 90 s after the last viewer). While someone watches, it makes about 3–4 requests per minute per command-share team. That is capped by `LIVE_RPM` (default 12), inside the global `GREPODATA_RPM=30`.

---

## 0. What you need

* The bot already running with docker/podman compose (README), on a server where a world is set (`/setup world`).
* For live commands: a GrepoData token set for the server (`/grepodata token`). Its GrepoData account must be a member of a **command-share team** for your world (grepodata.com → Ops). The map works without a token.
* A domain on Cloudflare (free plan is fine). Example below: `grepo.example.com`.
* A Discord account with 2FA enabled. This is required later for Activities and verification.

## 1. Cloudflare: create the named tunnel and hostname

1. Log in to <https://dash.cloudflare.com> → **Networking → Tunnels** → **Create a tunnel**. Older dashboards call this *Zero Trust → Networks → Tunnels*; pick type **Cloudflared**.
2. Name it, e.g. `grepocord`, then **Create tunnel**.
3. On *Install and run*, choose **Docker**. Copy the long token after `--token` in the shown command. Do **not** run the command: compose runs cloudflared for you.
4. Continue. Open the tunnel → **Routes** tab → **Add route → Published application** (older UI: *Public Hostname → Add*):
   * **Subdomain**: `grepo`, **Domain**: `example.com`
   * **Service URL**: `http://bot:8080`. Here `bot` is the compose service name and `8080` is `WEB_PORT`.
   * Save. Cloudflare creates the DNS record for you.
5. Do **not** put Cloudflare Access (login wall) in front of this hostname. Discord's Activity proxy could not pass it. The app has its own login.

## 2. Bot: enable the web app and the tunnel

Add these to `.env` next to `docker-compose.yml`:

```env
PUBLIC_URL=https://grepo.example.com
CLOUDFLARE_TUNNEL_TOKEN=<token from step 1.3>
COMPOSE_PROFILES=tunnel
# optional
PRIVACY_CONTACT=you@example.com
```

Rebuild, register the two new commands once, and start:

```bash
docker compose build            # or: podman compose build
docker compose run --rm register
docker compose up -d            # starts bot + cloudflared (COMPOSE_PROFILES=tunnel)
docker compose logs -f bot cloudflared
```

Check it:

* `https://grepo.example.com/healthz` should answer `ok`. In Cloudflare the tunnel should show **Healthy**.
* In Discord, run `/map`. You get an **Open in browser** button. Open it and the map loads.

**The browser fallback is now done.** It works for any server size. The steps below add the in-Discord Activity.

## 3. Discord: create a SEPARATE application for the Activity

> **Never enable Activities on the bot's own application.** Use a new app, so the main bot is never affected by Activity review or verification. The bot never needs the Activity app's token.

1. <https://discord.com/developers/applications> → **New Application**, e.g. `GrepoCord Live`. Create it in a **Team** if you want others to manage it.
2. **General Information** → copy the **Application ID**. This is `ACTIVITY_CLIENT_ID`.
   * Also set **Terms of Service URL** `https://grepo.example.com/terms` and **Privacy Policy URL** `https://grepo.example.com/privacy`. Verification needs both, and the bot serves both pages in EN and GR.
3. **OAuth2**:
   * **Reset Secret** → copy it. This is `ACTIVITY_CLIENT_SECRET`. Keep it secret and never commit it.
   * **Redirects** → add `https://grepo.example.com/oauth/callback` (used by "Sign in with Discord" on the browser dashboard) → **Save**.
4. **Activities → URL Mappings**: set **PREFIX** `/` and **TARGET** `grepo.example.com`. Use no `https://` and no path. Save.
5. **Activities → Settings** → **Enable Activities** and accept the prompt.
   * Discord creates the default **Entry Point command** ("Launch") for you. That is what puts the app in the App Launcher 🚀.
   * *Supported Platforms*: tick Web/Desktop, iOS and Android.
   * Optional: **Activities → Art Assets** (cover image), and **Rich Presence → Art Assets**.
6. **Installation**: under *Install Link* choose **Discord Provided Link**. Tick **Guild Install** with scope `applications.commands` (and **User Install** if you like). Open the install link and add the app to your Grepolis server. It needs no permissions and is not a bot.
7. Optional: **Activities → Custom Links → Create New**, then copy the link into `ACTIVITY_LINK`. Without it the bot uses `https://discord.com/activities/<ACTIVITY_CLIENT_ID>`. Either way, `custom_id=live|map` opens the right tab.

Add these to `.env` and restart:

```env
ACTIVITY_CLIENT_ID=<Application ID of the Activity app>
ACTIVITY_CLIENT_SECRET=<its OAuth2 client secret>
# ACTIVITY_LINK=https://discord.com/activities/<id>?link_id=0-...   (optional)
```

```bash
docker compose up -d
```

Now `/live` and `/map` show **Open in Discord** (Activity) and **Open in browser**. `/live share:true` posts the Activity link publicly in the channel so others can join. The personal browser link always stays private.

On first launch Discord asks each user to **Authorize** the Activity app (scopes `identify` and `guilds`). The backend exchanges the code (`POST /api/token`). It then checks that the user is in the server where the Activity was opened and that the bot is in that server too.

## 4. Inside Discord

* Click **Open in Discord**, or open the **App Launcher 🚀** in a voice or text channel and pick *GrepoCord Live*.
* Tabs: **Live** and **Map**. Language follows the server language (`/setup language`).
* Map controls: drag to pan, wheel or pinch to zoom, search box (alliance / player / town), **Our side vs enemies** or **Alliances** colouring.
* Timeline: drag the slider or press **Play** to replay conquests. Rings mark conquests in the last 1/7/30 days before the slider time.

## 5. The 25-member limit and verification

Discord rules as of November 2026 ([Verified vs Unverified Activities](https://support-dev.discord.com/hc/en-us/articles/26576097154199), [How users can play](https://support-dev.discord.com/hc/en-us/articles/21204493235991)):

* An **unverified** Activity can only be launched in servers with **fewer than 25 members** (and DMs). Even there, only the **developer team** and up to **50 App Testers** can launch it.
* A **verified** Activity has **no member limit**.

Your server has 25+ members, so until the Activity app is verified, pick one of these:

**A. Browser dashboard (works now, any size).** Members use **Open in browser** from `/live` and `/map`, or `https://grepo.example.com` → *Sign in with Discord*.

**B. Test it in a small server.** Make a private server with fewer than 25 members. Add the Activity app there, and invite the officers as **App Testers**: portal → **App Testers** → add their usernames (they must be your Discord friends). Each tester must:
1. accept the email invite,
2. turn on Discord **Settings → Advanced → Developer Mode**,
3. turn on **Application Test Mode** and paste the Activity's Application ID → **Activate**.

**C. Verify the Activity app**, to use it in the big server. In the portal choose the Activity app → **App Verification**, and work through the checklist it shows. Usually that means:
* the team owner verifies their identity with **Stripe**,
* 2FA on the owner account,
* **Terms of Service** and **Privacy Policy** URLs (already served at `/terms` and `/privacy`),
* the app owned by a Team,
* app info filled in (description, icon).

Then press **Verify App**. Discord changes the checklist from time to time. If it asks for something this small app cannot meet (for example a minimum number of servers or users), keep using option A. Verifying the **Activity app** does not touch the main bot app.

## 6. Environment variables (summary)

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | – | Public https URL (tunnel hostname). Enables the web app and the browser links |
| `WEB_PORT` | `8080` | Port inside the container. If you change it, change `expose` in docker-compose and the tunnel Service URL too |
| `WEB_SECRET` | auto | HMAC secret for links and sessions. Empty means one is generated once and stored in the DB. Changing it logs everyone out |
| `ACTIVITY_CLIENT_ID` | – | Application ID of the **separate** Activity app |
| `ACTIVITY_CLIENT_SECRET` | – | Its OAuth2 client secret (Activity login + dashboard "Sign in with Discord") |
| `ACTIVITY_LINK` | `https://discord.com/activities/<ACTIVITY_CLIENT_ID>` | Optional Custom Link |
| `LIVE_POLL_SECONDS` | `20` | Command-share poll interval while someone watches (min 10) |
| `LIVE_RPM` | `12` | Max GrepoData requests/min for the live window |
| `PRIVACY_CONTACT` | – | Contact shown on `/terms` and `/privacy` |
| `CLOUDFLARE_TUNNEL_TOKEN` | – | Token of the named tunnel (used by the `cloudflared` compose service) |
| `COMPOSE_PROFILES` | – | `tunnel` starts cloudflared with plain `docker compose up -d` |
| `WEB_ENABLED` | auto | `true` forces the web server on without `PUBLIC_URL` (local testing) |

## 7. Security notes

* The web app is reachable only through the tunnel. No host port is published. Uncomment `ports: ["127.0.0.1:8080:8080"]` in compose to test locally.
* Access requires a signed session tied to **one Discord server**, from one of:
  * the Activity OAuth (membership checked),
  * Discord login (membership checked, only servers that have the bot and a world),
  * a personal link from `/live` or `/map` (valid 12 h; the token sits in the URL fragment, so it never reaches logs).
* Anyone who can run `/live` in a server can see that server's live intel. This is the same rule as `/intel`. Don't forward personal links.
* The GrepoData token never leaves the server. The Discord OAuth token is used once and not stored.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `/live` says the live window is not set up | Set `PUBLIC_URL` and/or `ACTIVITY_CLIENT_ID`, then restart |
| `https://…/healthz` gives 502 or 1033 | The tunnel is down or the Service URL is wrong. It must be `http://bot:8080`; check `docker compose logs cloudflared` |
| The Activity shows "unavailable" or isn't in the App Launcher | It is unverified and the server has 25+ members, or the user is not a tester or in Test Mode (§5) |
| Activity: blank screen / `blocked:csp` | URL Mapping missing or wrong: it must be `/` → `grepo.example.com` with no `https://` |
| "Discord login failed" | Wrong `ACTIVITY_CLIENT_SECRET`, or the redirect `https://grepo.example.com/oauth/callback` was not added in OAuth2 |
| Live: "not in any active command-share team" | Add the GrepoData account (the one whose token the bot uses) to a team for this world on grepodata.com |
| Live: intel token errors | Same fixes as `/intel`: `/grepodata status`, `/grepodata token` |
| Map is empty | The world data is still loading. Wait for the first refresh (`docker compose logs bot`) |
