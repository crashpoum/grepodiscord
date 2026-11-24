# GrepoGod → GrepoCord troop sync

This is the spec for the GrepoGod userscript (owned separately). GrepoCord already implements the server and the Troops tab. GrepoGod only has to push a snapshot of troops already sitting in the client.

---

## Hard rule: no extra in-game requests

GrepoGod must make **no extra in-game requests** to build this payload:

- no game API / ajax / `gpajax` / town-info / window-open calls
- no opening game windows or switching towns in order to fetch data
- use **only** data already loaded in the client models (`ITowns`, `MM`, and the same helpers `frSnapshot()` already uses: `t.units()`, `t.unitsOuter()`, `t.unitsSupport()`, `frWall()`, `frSupportIn()` / `cleanUnits()`)

The **only** network call for this feature is the `POST` or `DELETE` to GrepoCord, via `GM_xmlhttpRequest`.

`frSnapshot()` already reads everything this endpoint needs from those models. Reuse its town objects (`id`, `n`, `sea`, `home`, `total`, `sup`, `w` / `wq` / `wa`, `it`). Do not add a second data path.

---

## Endpoint

```
POST   https://grepo.crashpoum.fyi/api/gg/troops
DELETE https://grepo.crashpoum.fyi/api/gg/troops
```

(The host is the bot's `PUBLIC_URL`. The path is always `/api/gg/troops`.)

Userscript metadata **must** include:

```
// @connect grepo.crashpoum.fyi
```

Send with `GM_xmlhttpRequest` (not page `fetch`). That is the only allowed network call.

### Auth

```
Authorization: Bearer <key>
Content-Type: application/json
```

The key is issued in Discord by `/grepogod link` (ephemeral; shown once). Running `/grepogod link` again **rotates** it (the old key stops working). `/grepogod unlink` deletes the key and all stored troop data for that user.

The key is bound to that Discord server and, when the user is verified, to their in-game player. A snapshot whose `player_id` does not match the verified player is rejected.

### POST body

```json
{
  "v": 1,
  "world": "gr125",
  "player_id": 123456,
  "player_name": "Leonidas",
  "ts": 1764100000000,
  "towns": [
    {
      "id": 42,
      "n": "Sparta",
      "sea": 55,
      "home": { "sword": 120, "slinger": 300 },
      "total": { "sword": 120, "slinger": 300, "bireme": 10 },
      "sup": { "hoplite": 50 },
      "it": { "sword": 120, "slinger": 300, "hoplite": 50 },
      "w": 25,
      "wq": 26,
      "wa": 1764103600
    }
  ]
}
```

Field meanings (same as `frSnapshot()`):

| Field | Meaning |
| --- | --- |
| `v` | Protocol version. Must be `1`. |
| `world` | World id (`gr125`, …). Must be a live world and must match the Discord server's world. |
| `player_id` / `player_name` | The logged-in player. |
| `ts` | Snapshot time (unix **milliseconds**; seconds are also accepted). |
| `towns[].id` | Town id (integer). |
| `towns[].n` | Town name. |
| `towns[].sea` | Ocean number (0–99). |
| `towns[].home` | Own units **in** the town (`t.units()`, then `cleanUnits()`). |
| `towns[].total` | Own units including those **outside** (`home` + `t.unitsOuter()`). |
| `towns[].sup` | Support **in** the town (`t.unitsSupport()`). May be `{}`. |
| `towns[].it` | Everything standing **inside** the town right now: own at home + support from other towns (including other players). Optional; omit if `frSupportIn()` could not be read. |
| `towns[].w` | Current wall level (0–30). Optional. |
| `towns[].wq` | Wall level after queued wall orders finish, only when it differs from `w`. Optional. |
| `towns[].wa` | Unix **seconds** when the last queued wall order finishes. Optional. |

Unit maps: keys are official unit ids (`/^[a-z][a-z0-9_]{0,39}$/`), values are whole numbers `1…10_000_000`. Drop zeroes (`cleanUnits()`). At most 60 keys per map, 250 towns, **256 KB** for the whole body. Extra fields (`moves`, `inc`, `sched`, …) may be present and are ignored.

Do not invent missing counts. If a model is unavailable, send `{}` (or omit `it` / wall fields), never pad with guessed units.

### Responses

| Status | When |
| --- | --- |
| `200` | Stored (`{ ok: true, towns: N }`) or deleted (`{ ok: true, removed: N }`). |
| `400` | Invalid payload, unknown / wrong world, or `player_id` does not match the verified player (`{ error: "invalid" \| "world" \| "player" }`). |
| `401` | Missing or unknown key. |
| `413` | Body larger than 256 KB, or too many towns. |
| `429` | More than one write per **15 seconds** for this key (server-side safety limit). |

CORS is allowed only for `https://*.grepolis.com` (and `https://grepolis.com`). Other browser origins receive `403`. `GM_xmlhttpRequest` is not subject to page CORS, but still use it — do not switch to page `fetch`.

### DELETE (opt-out)

When the user turns the opt-in **off**, call `DELETE /api/gg/troops` with the same `Authorization` header (no body). This removes the stored snapshot. The key remains valid so they can opt in again without running `/grepogod link`. If they also want the key gone, they run `/grepogod unlink` in Discord.

---

## Pacing

- Push when the troop snapshot **changes** (hash the `towns` array, same idea as `frHash(frSnapshot())`).
- **At most every 30 seconds**, even if it changes more often.
- **Re-push every 5 minutes** even if nothing changed (heartbeat so GrepoCord can show a last-sync age and mark stale data).
- The server additionally rejects more than one write per 15 seconds; treat `429` as “try again later”, not as a retry storm.

Suggested trigger: the same game-model hooks already used for Friends, plus a 5-minute timer. Still **no extra game requests**.

---

## Opt-in toggle (default OFF)

This is off until the user turns it on. Suggested strings:

**English**

- Label: `Share my troops with GrepoCord`
- Help: `Send the troops already loaded in this client to your alliance's GrepoCord (the Troops tab). No extra game requests are made. Off by default.`
- Off / on confirmation as you usually do for Friends-style switches.

**Greek**

- Label: `Κοινοποίηση στρατευμάτων στο GrepoCord`
- Help: `Στέλνει στο GrepoCord της συμμαχίας σου (καρτέλα Στρατεύματα) τα στρατεύματα που είναι ήδη φορτωμένα σε αυτόν τον πελάτη. Δεν γίνονται επιπλέον αιτήματα στο παιχνίδι. Κλειστό από προεπιλογή.`

Settings needed: the key from `/grepogod link` (a paste field), and this toggle. Do not enable the toggle automatically when a key is pasted.

On toggle **off**, `DELETE` as above and stop the timer.

---

## What GrepoCord shows

Guild members (the same people who can open `/live`) see a **Troops** tab: each linked player, last-sync age, and their towns in the Friends-list layout — at home, in town (own + support), total including units outside, support in town, and wall level (with upgrade / demolition if `wq` is sent). Official Grepolis unit icons are loaded through GrepoCord's own `/gpcdn` proxy. Filters: player, town search, unit type. An alliance-wide totals row sums the towns currently shown.
