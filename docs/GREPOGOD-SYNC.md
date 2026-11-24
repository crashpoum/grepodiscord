# GrepoGod → GrepoCord troop sync

This is the spec for the GrepoGod userscript (owned separately). GrepoCord already implements the server and the Troops tab. GrepoGod only has to push a snapshot of troops already sitting in the client.

---

## Hard rule: no extra in-game requests

GrepoGod must make **no extra in-game requests** to build this payload:

- no game API / ajax / `gpajax` / town-info / window-open calls
- no opening game windows or switching towns in order to fetch data
- use **only** data already loaded in the client models (`ITowns`, `MM`, and the same helpers `frSnapshot()` / `frResRead()` / `frSpellsAll()` already use: `t.units()`, `t.unitsOuter()`, `t.unitsSupport()`, `frWall()`, `frSupportIn()` / `cleanUnits()`, `t.resources()`, warehouse / free-pop helpers, and `CastedPowers` already in `MM`)

The **only** network call for this feature is the `POST` or `DELETE` to GrepoCord, via `GM_xmlhttpRequest`.

`frSnapshot()` (plus the existing `frSnap59` resource and spell helpers) already reads everything this endpoint needs from those models. Reuse its town objects (`id`, `n`, `sea`, `home`, `total`, `sup`, `w` / `wq` / `wa`, `it`) and, when the share switches are on, attach `res` and `spells` from the same in-memory sources. Do not add a second data path and do not open windows or ajax to fill resources or spells.

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
      "wa": 1764103600,
      "res": { "wood": 15000, "stone": 18600, "iron": 3000, "storage": 30600, "pop_free": 209 },
      "spells": [
        { "id": "happiness", "ends_at": 1764107200 },
        { "id": "town_protection", "ends_at": 1764118000 }
      ]
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
| `towns[].res` | Optional. Only when GrepoGod's **Resources and warehouse** share switch (`friends.shRes`) is **on**. Same already-loaded sources as `frResRead()`: `t.resources()` for wood / stone / iron (silver), warehouse capacity, free population. Omit the field entirely when the switch is off or the model is missing for that town. Values may be rounded the same way `frRound` already does. Numbers only, integers, `0…10_000_000` (`storage` ≥ 1); `pop_free` is optional (`0…1_000_000`). |
| `towns[].spells` | Optional. Only when GrepoGod's **Active spells** share switch (`friends.shSp`) is **on**. Same already-loaded sources as `frSpellsAll()`: `MM` `CastedPowers` models and town-agnostic fragments already in memory. Each entry is `{ id, name?, ends_at? }`. `id` is the official power id (`/^[a-z][a-z0-9_]{0,39}$/`). `name` is optional (GrepoCord has its own EN/GR map and will fall back to the id; never send an object). `ends_at` is unix **seconds**, only when the model already has `end_at`. At most 12 spells per town. Send `[]` when the switch is on but the town has no lingering spells. Omit the field entirely when the switch is off. |

Unit maps: keys are official unit ids (`/^[a-z][a-z0-9_]{0,39}$/`), values are whole numbers `1…10_000_000`. Drop zeroes (`cleanUnits()`). At most 60 keys per map, 250 towns, **256 KB** for the whole body. Extra fields (`moves`, `inc`, `sched`, `rs`, `sp`, …) may be present and are ignored — put resources and spells **on each town** as `res` / `spells`, do not rely on the top-level `rs` / `sp` maps.

Do not invent missing counts. If a model is unavailable, send `{}` (or omit `it` / wall / `res` / `spells` fields), never pad with guessed units, resources or spells. **No extra in-game requests** to fill `res` or `spells`.

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

- Push when the troop snapshot **changes** (hash the `towns` array, same idea as `frHash(frSnapshot())`). A fresh resource reading must **not** by itself trigger an instant push (GrepoGod already treats `rs` as “present or not” in `frHash`); resources and spells travel with the normal 30 s / 5 min cadence.
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

Guild members (the same people who can open `/live`) see a **Troops** tab: each linked player, last-sync age, and their towns in a two-column grid like GrepoGod's Friends list (name, wall chip, ocean on the compact card; click to expand). The expanded town shows troops at home, in town (own + support), total including units outside, support in town, and wall level (with upgrade / demolition if `wq` is sent). When `res` is present, a Resources row shows Wood / Stone / Silver bars relative to warehouse storage, plus warehouse size and free population. When `spells` is present, an Active spells row shows named pills (EN/GR from the power id, falling back to a sanitized `name` or the id — never `[object Object]`) and a live countdown from `ends_at`. Official Grepolis unit icons are loaded through GrepoCord's own `/gpcdn` proxy. Filters: player, town search, unit type. An alliance-wide totals row sums the towns currently shown.
