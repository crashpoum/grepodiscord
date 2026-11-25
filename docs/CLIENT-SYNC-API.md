# Client data sync API

GrepoCord accepts data from an external client that a member runs on their own machine (for example a browser
userscript). The client sends what the game **already shows that player**; GrepoCord stores it per Discord server and
shows it in the web app (Troops, Alerts and Ops tabs) and, for incoming attacks, in an alerts channel.

GrepoCord never talks to the game and never sends anything to it. This API only receives data.

---

## Rules for clients

- **No extra in-game requests.** Build every payload only from data the game client has already loaded. Do not call game
  endpoints, open windows or switch towns to collect data.
- **No automation.** Nothing in this API sends, schedules or cancels game actions; the Ops feed only *reports* what the
  player planned in their own client.
- **Opt-in, off by default.** Each feed (troops, incoming, ops) should have its own switch in the client.
- The only network calls are the `POST` / `DELETE` requests below.

---

## Endpoints

```
POST|DELETE  {PUBLIC_URL}/api/sync/troops     (alias: /api/gg/troops)
POST|DELETE  {PUBLIC_URL}/api/sync/incoming   (alias: /api/gg/incoming)
POST|DELETE  {PUBLIC_URL}/api/sync/ops        (alias: /api/gg/ops)
```

`/api/sync/*` and `/api/gg/*` are the same routes; existing clients that use `/api/gg/troops` keep working.

### Auth

```
Authorization: Bearer ggc1_…
Content-Type: application/json
```

A member gets the key in Discord with `/sync link` (Greek: `/συγχρονισμός σύνδεση`). It is shown once. Running it
again rotates the key (the old one stops working). `/sync unlink` deletes the key and all data stored for that member.
Admins can also delete a member's data or revoke their key from the admin panel.

The same key works for all three endpoints. It is bound to that Discord server and to one in-game player: the first
accepted payload (or the member's verified link) fixes the `player_id`; a payload for another player is rejected
(`400 player`). When the server setting "accept synced data only from linked members" is on, unlinked members get
`403 link`.

### Common rules

| Rule | Value |
| --- | --- |
| CORS | Only `https://*.grepolis.com` and `https://grepolis.com`. Other browser origins get `403`. |
| Body size | At most **256 KB** (`413` otherwise). |
| Rate | At most **one write per 15 seconds per endpoint** per key. Extra writes get `429` with a `Retry-After` header (seconds) and `{ "error": "rate", "retry_after": N }`. |
| Replace, not merge | Each `POST` carries the **full current list** and replaces the previous one. An empty list clears it. |
| Opt-out | `DELETE` (same header, no body) removes what is stored for that endpoint. The key stays valid. |
| Staleness | The web app marks a member's data as stale when no `POST` arrived for about **12 minutes**. Send a heartbeat every few minutes even when nothing changed. |
| Leniency | `ts` and every time field may be unix **seconds or milliseconds**. Unknown fields are ignored. A malformed list item is skipped and counted (`skipped` in the response); it never fails the whole request. Duplicate ids keep the first item. |

Common header fields of every body:

| Field | Meaning |
| --- | --- |
| `v` | Protocol version, `1`. |
| `world` | World id (`gr125`, …). Must match the Discord server's world. |
| `player_id` / `player_name` | The logged-in player. |
| `ts` | When the client built the payload. |

### Responses

| Status | When |
| --- | --- |
| `200` | Stored: `{ ok: true, towns: N }`, `{ ok: true, cmds: N, skipped: K }` or `{ ok: true, ops: N, skipped: K }`. Deleted: `{ ok: true, removed: N }`. |
| `400` | Invalid body (`invalid`), wrong world (`world`), or another player than the key is bound to (`player`). |
| `401` | Missing or unknown key. |
| `403` | Origin not allowed, or the server requires a linked member (`link`). |
| `405` | Method not allowed (also what a server without this version answers). |
| `413` | Body too large or too many items. |
| `429` | Too soon; wait `Retry-After` seconds. Do not retry in a loop. |

---

## Troops (`/api/sync/troops`)

```json
{
  "v": 1, "world": "gr125", "player_id": 123456, "player_name": "Leonidas", "ts": 1764100000000,
  "towns": [
    {
      "id": 42, "n": "Sparta", "sea": 55,
      "home": { "sword": 120, "slinger": 300 },
      "total": { "sword": 120, "slinger": 300, "bireme": 10 },
      "sup": { "hoplite": 50 },
      "it": { "sword": 120, "slinger": 300, "hoplite": 50 },
      "w": 25, "wq": 26, "wa": 1764103600,
      "res": { "wood": 15000, "stone": 18600, "iron": 3000, "storage": 30600, "pop_free": 209 },
      "spells": [{ "id": "happiness", "ends_at": 1764107200 }]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `towns[].id` / `n` / `sea` | Town id, name, ocean number (0–99). |
| `home` | Own units in the town. |
| `total` | Own units including those outside. |
| `sup` | Support in the town (may be `{}`). |
| `it` | Optional: everything standing in the town now (own at home + support). |
| `w` / `wq` / `wa` | Optional: wall level, level after queued orders, when the last order finishes (unix seconds). |
| `res` | Optional: wood, stone, iron (silver), warehouse `storage`, optional `pop_free`. Integers. |
| `spells` | Optional: `[{ id, name?, ends_at? }]`, official power ids, at most 12 per town. |

Unit maps: official unit ids as keys (`/^[a-z][a-z0-9_]{0,39}$/`), whole numbers `1…10 000 000` as values, at most
60 keys per map, 250 towns. Never pad missing data with guesses; omit the field instead.

---

## Incoming commands (`/api/sync/incoming`)

The incoming commands the player sees in their own game, with the client's guess of what they are.

```json
{
  "v": 1, "world": "gr125", "player_id": 7, "player_name": "crashpoum99", "ts": 1795566386654,
  "cmds": [
    {
      "id": 9001, "town_id": 11, "town_n": "Akropolis", "type": "attack", "arrival": 1795569986,
      "from_town_id": 77, "from_town_n": "ChakhPihNish", "from_player_id": 42, "from_player": "papasn55",
      "from_alliance": "HDNW", "started": 1795559186,
      "pred": {
        "kind": "naval", "conf": 0.86, "units": ["bireme", "attack_ship"],
        "groups": [
          { "pct": 86, "units": ["bireme", "attack_ship"] },
          { "pct": 40, "units": ["trireme"] },
          { "pct": 12, "units": ["colonize_ship"] }
        ]
      }
    },
    { "id": 9100, "town_id": 11, "town_n": "Akropolis", "type": "support", "arrival": 1795566786 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Command id (number or string, `[A-Za-z0-9_:.-]`, max 64). Used to post each alert only once. |
| `town_id` / `town_n` | The player's town that is targeted. Required: `id`, `town_id`, `arrival`. |
| `type` | `attack`, `conquest`, `revolt`, `spy`, `support` (aliases such as `attack_takeover`, `espionage` are mapped; anything else is `other`). |
| `arrival` | Landing time. |
| `from_*` | Optional: origin town, player, alliance tag. |
| `started` | Optional: when the command left. |
| `pred.kind` | Optional: `colo`, `naval` or `land`. |
| `pred.units` | Optional: the most likely unit **types** as an array of unit ids (no counts). A unit map with counts or a short text is also accepted. |
| `pred.groups` | Optional: the full list of candidates `[{ pct, units: [ids] }]`, shown as percentages, highest first (max 12). |
| `pred.conf` | Optional: confidence of the top group, `0…0.99` (a percentage `0…100` is also accepted). |
| `pred.note` | Optional free text, e.g. `approximate travel time`, `Possible colony ship`, or an error message. |

An empty `cmds` array means nothing is incoming. Alerts go to the admin-chosen channel for hostile types the admins
picked, with an optional role ping and a minimum size (only applied when counts are known), each command id once.

---

## Planned sends (`/api/sync/ops`)

What the player scheduled in their own client, what was sent and what failed. Display only.

```json
{
  "v": 1, "world": "gr125", "player_id": 7, "player_name": "crashpoum99", "ts": 1795566386656,
  "ops": [
    { "id": "cpend1", "kind": "attack", "from_town_id": 11, "from_town_n": "Akropolis", "target_town_id": 55,
      "target_town_n": "TargetHold", "target_player": "EnemyKing", "units": { "hoplite": 200, "slinger": 50 },
      "send_at": 1795569976, "arrive_at": 1795573586, "status": "scheduled" },
    { "id": "csent1", "kind": "attack", "from_town_id": 11, "from_town_n": "Akropolis", "target_town_id": 57,
      "target_town_n": "HitTown", "units": { "sword": 80 }, "send_at": 1795566576, "arrive_at": 1795567386,
      "status": "sent", "sent_at": 1795566382, "arrival": 1795566586 },
    { "id": "cfail1", "kind": "attack", "from_town_id": 11, "from_town_n": "Akropolis", "target_town_id": 58,
      "target_town_n": "Missed", "units": { "archer": 10 }, "send_at": 1795566226, "arrive_at": 1795566286,
      "status": "failed", "reason": "the window had passed" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Op id. Required with `from_town_id`, `target_town_id`, `send_at`, `status`. |
| `kind` | `attack` or `support`. |
| `send_at` | Planned first send time. |
| `arrive_at` | Planned landing time. |
| `status` | `scheduled`, `sent` or `failed` (aliases: `pending`, `planned`, `queued`, `done`, `ok`, `error`…). |
| `sent_at` / `arrival` | From the actual attempt (sent ops). |
| `reason` | Why it failed (failed ops). |
| `units` | Optional unit map (or short text). |
| `target_player` | Optional. |

Clients typically keep up to 80 sent/failed entries for about 24 hours; at most 500 ops per request. The web app groups
them per status and per player and flags an attack and a support landing on the same town within one second.

---

## Who sees the data

Server admins choose per tab who may see Troops, Alerts and Ops (every member, some roles, or admins only) and can
give a member or role temporary access (1 hour, 1 day, 1 week, until a date, or permanent). Guest links never include
synced data.

## Suggested client strings

| | English | Ελληνικά |
| --- | --- | --- |
| Troops switch | Share my troops with GrepoCord | Κοινοποίηση στρατευμάτων στο GrepoCord |
| Incoming switch | Share my incoming attacks with GrepoCord | Κοινοποίηση εισερχόμενων επιθέσεων στο GrepoCord |
| Ops switch | Share my planned sends with GrepoCord | Κοινοποίηση προγραμματισμένων αποστολών στο GrepoCord |
| Help | Sends only what this game client already shows. No extra game requests. Off by default. | Στέλνει μόνο ό,τι δείχνει ήδη αυτός ο πελάτης του παιχνιδιού. Χωρίς επιπλέον αιτήματα στο παιχνίδι. Κλειστό από προεπιλογή. |
