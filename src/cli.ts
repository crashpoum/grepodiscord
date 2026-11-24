/**
 * Token-free CLI / dry-run. Uses live data, prints embeds as text, writes charts to files.
 *   npm run cli -- worlds
 *   npm run cli -- player gr126 "Name" [--lang el] [--out chart.png]
 *   npm run cli -- alliance en180 "Name" [--out chart.png]
 *   npm run cli -- radar-inactive en180 [--hours 48] [--ocean 45] [--near "Town"] [--radius 20]
 *   npm run cli -- radar-ghosts gr126 [--ocean 45] [--near "Town"] [--radius 20]
 *   npm run cli -- refresh en180 [--since-hours 6] [--alliance X] [--ocean 45] [--min-bp 1000]
 *       Runs a real refresh against the CLI database (CLI_DB_PATH, default ./data/cli.sqlite) and prints
 *       what each feed type would post. Run it again after the next hourly update to see real diffs.
 *   npm run cli -- verify-check gr126 "Player" GDABCD
 *
 * GrepoData features (public API, cached + rate-limited):
 *   npm run cli -- top-today gr125 [--kind alliance] [--yesterday]
 *   npm run cli -- top-hour gr125 [--hour 17]
 *   npm run cli -- ranking gr125 [--kind alliance] [--sort Points|Att|Def|AttDef|Towns|Members] [--page 2]
 *   npm run cli -- wars gr125 "Alliance"
 *   npm run cli -- changes gr125 alliance|player|world ["Name"] [--page 2]
 *   npm run cli -- conquests gr125 player|alliance|town "Name" [--filter all|enemy|friendly|internal] [--page 2]
 *   npm run cli -- town-search gr125 "query" · town-info gr125 "Town" · town-radar gr125 ["Town"] [--x 581 --y 296] [--radius 15] [--ghosts]
 * City Indexer intel (uses GREPODATA_TOKEN / GREPODATA_REFRESH_TOKEN from the environment; never printed):
 *   npm run cli -- token-status            decode the env token (account, expiry) without any network call
 *   npm run cli -- intel gr125 town|player|alliance "Name"
 */
import { writeFileSync } from 'node:fs';
import { Store } from './db.js';
import { WorldManager } from './refresh.js';
import { GrepoDataClient } from './data/grepodata.js';
import { isValidWorldId } from './data/official.js';
import { embedToText } from './embeds.js';
import { allianceCard, playerCard, radarGhosts, radarInactive, resolveAlliance, resolvePlayer, type Ctx } from './services.js';
import { planFeedPosts } from './feedPlan.js';
import { newConquests } from './diff.js';
import { findCodeTown } from './verify.js';
import { parseOceanList } from './geo.js';
import type { FeedConfig, FeedFilter } from './feeds.js';
import type { Lang } from './i18n.js';
import { config } from './config.js';
import { t } from './i18n.js';
import { decodeJwt, jwtExpMs, looksLikeJwt, saveToken } from './gdAuth.js';
import { changes, conquestHistory, intelBrowse, intelTown, topHour, topRanking, topScoreboard, townInfo, townRadar, townSearch, wars, UserError } from './gdServices.js';
import type { RankSort, TopKind } from './gdViews.js';
import type { ConquestFilter } from './data/grepodata.js';

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const pos: string[] = [];
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a.startsWith('--')) { const n = argv[k + 1]; if (n === undefined || n.startsWith('--')) flags.set(a.slice(2), 'true'); else { flags.set(a.slice(2), n); k++; } }
  else pos.push(a);
}
const [cmd, world, ...rest] = pos;
const lang: Lang = flags.get('lang') === 'el' ? 'el' : 'en';
const num = (k: string) => (flags.has(k) ? Number(flags.get(k)) : undefined);
const kind: TopKind = flags.get('kind') === 'alliance' ? 'alliance' : 'player';

function usage(): never {
  console.log(`Usage: cli <worlds|player|alliance|radar-inactive|radar-ghosts|refresh|verify-check|top-today|top-hour|ranking|wars|changes|conquests|town-search|town-info|town-radar|intel|token-status> <world> [args] [--lang el]\nSee header of src/cli.ts for details.`);
  process.exit(cmd ? 1 : 0);
}

async function main() {
  if (!cmd || cmd === '--help' || flags.has('help')) usage();
  const store = new Store(process.env.CLI_DB_PATH ?? './data/cli.sqlite');
  const ctx: Ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient() };
  if (cmd === 'worlds') {
    for (const s of await ctx.gd.activeWorlds(config.markets)) console.log(`${s.server} (${s.timezone}): ${s.worlds.map((w) => w.id).join(', ')}`);
    return;
  }
  if (cmd === 'token-status') {
    const tok = config.grepodataToken;
    if (!tok) { console.log('GREPODATA_TOKEN is not set.'); return; }
    const c = decodeJwt(tok);
    if (!c) { console.log('GREPODATA_TOKEN is not a JWT.'); return; }
    const exp = jwtExpMs(tok);
    console.log(`account: ${c.username ?? '?'} · issued ${c.iat ? new Date(c.iat * 1000).toISOString() : '?'} · expires ${exp ? new Date(exp).toISOString() : '?'} (${exp && exp < Date.now() ? 'EXPIRED' : 'valid'})`);
    console.log(`refresh token in env: ${config.grepodataRefreshToken ? `yes, expires ${new Date(jwtExpMs(config.grepodataRefreshToken) ?? 0).toISOString()}` : 'no'} · login in env: ${config.grepodataLogin ? 'yes' : 'no'}`);
    return;
  }
  if (!world || !isValidWorldId(world)) { console.error(`Invalid world "${world}" (markets: ${config.markets.join(',')})`); process.exit(1); }
  const area = { oceans: parseOceanList(flags.get('ocean')), nearTown: flags.get('near'), radius: num('radius'), hours: num('hours'), minPoints: num('min-points'), limit: num('limit') };

  switch (cmd) {
    case 'player':
    case 'alliance': {
      const q = rest.join(' ');
      const card = cmd === 'player' ? await playerCard(ctx, world, q, lang) : await allianceCard(ctx, world, q, lang);
      if (!card) { console.log(`not found: ${q}`); process.exit(2); }
      if (card.chart) {
        const out = flags.get('out') ?? `./data/${cmd}-${world}.png`;
        writeFileSync(out, card.chart);
        card.embed.image = { url: `file://${out}` };
      }
      console.log(embedToText(card.embed));
      return;
    }
    case 'radar-inactive': console.log(embedToText(await radarInactive(ctx, world, area, lang))); return;
    case 'radar-ghosts': console.log(embedToText(await radarGhosts(ctx, world, area, lang))); return;
    case 'verify-check': {
      const snap = await ctx.worlds.ensure(world);
      const code = rest.pop() ?? '';
      const p = resolvePlayer(snap, rest.join(' '));
      if (!p) { console.log('player not found'); process.exit(2); }
      const town = findCodeTown(snap, p.id, code);
      console.log(town ? `VERIFIED: ${p.name} owns "${town.name}" containing ${code}` : `not verified: no town of ${p.name} contains ${code} (towns: ${(snap.townsByPlayer.get(p.id) ?? []).map((x) => x.name).join(' | ')})`);
      return;
    }
    case 'refresh': {
      const ev = await ctx.worlds.refresh(world);
      const snap = ev.snapshot;
      console.log(`# ${world}: ${snap.players.size} players, ${snap.alliances.size} alliances, ${snap.towns.size} towns, ${snap.conquers.length} conquests total`);
      console.log(`# changed files this run: ${ev.changedFiles.join(', ') || '(none)'}${ev.firstLoad ? ' (first load: baseline stored)' : ''}`);
      // Dry-run convenience: also show conquests from the last N hours (default 3) even on first load.
      const sinceH = num('since-hours') ?? 3;
      const since = Math.floor(Date.now() / 1000) - sinceH * 3600;
      const shown = { ...ev, conquests: ev.conquests.length ? ev.conquests : newConquests(snap.conquers, since) };
      const filter: FeedFilter = {};
      const aq = flags.get('alliance');
      if (aq) { const a = resolveAlliance(snap, aq); if (a) filter.allianceIds = [a.id]; }
      const oc = parseOceanList(flags.get('ocean'));
      if (oc.length) filter.oceans = oc;
      const feeds: FeedConfig[] = [
        { id: 1, guildId: 'dry', channelId: '#conquests', world, type: 'conquests', filter },
        { id: 2, guildId: 'dry', channelId: '#alliance', world, type: 'alliance', filter: { allianceIds: filter.allianceIds } },
        { id: 3, guildId: 'dry', channelId: '#bp', world, type: 'bp', filter: { allianceIds: filter.allianceIds, minBp: num('min-bp') ?? 1000 } },
      ];
      const posts = planFeedPosts(feeds, shown, () => lang);
      console.log(`# conquests shown: ${shown.conquests.length} (since ${sinceH}h or since last run) · alliance changes: ${ev.allianceChanges.length} · bp deltas: ${ev.bp.length}`);
      for (const p of posts) {
        console.log(`\n=== would post to ${p.channelId} (${p.embeds.length} embed(s)) ===`);
        for (const e of p.embeds.slice(0, num('max') ?? 5)) console.log(embedToText(e));
        if (p.embeds.length > (num('max') ?? 5)) console.log(`... ${p.embeds.length - (num('max') ?? 5)} more`);
      }
      if (!posts.length) console.log('\n(no feed posts for this refresh)');
      return;
    }
    case 'top-today': console.log(embedToText(await topScoreboard(ctx, world, kind, flags.has('yesterday'), lang))); return;
    case 'top-hour': console.log(embedToText(await topHour(ctx, world, num('hour'), lang))); return;
    case 'ranking': console.log(embedToText(await topRanking(ctx, world, kind, (flags.get('sort') ?? 'Points') as RankSort, num('page'), lang))); return;
    case 'wars': console.log(embedToText(await wars(ctx, world, rest.join(' '), lang))); return;
    case 'changes': {
      const [scope, ...name] = rest;
      console.log(embedToText(await changes(ctx, world, (scope ?? 'world') as 'alliance' | 'player' | 'world', name.join(' ') || null, num('page'), lang)));
      return;
    }
    case 'conquests': {
      const [scope, ...name] = rest;
      console.log(embedToText(await conquestHistory(ctx, world, scope as 'player' | 'alliance' | 'town', name.join(' '), (flags.get('filter') ?? 'all') as ConquestFilter, num('page'), lang)));
      return;
    }
    case 'town-search': console.log(embedToText(await townSearch(ctx, world, rest.join(' '), lang))); return;
    case 'town-info': console.log(embedToText(await townInfo(ctx, world, rest.join(' '), lang))); return;
    case 'town-radar': console.log(embedToText(await townRadar(ctx, world, { town: rest.join(' ') || null, x: num('x'), y: num('y'), radius: num('radius'), ghostsOnly: flags.has('ghosts') }, lang))); return;
    case 'intel': {
      // The CLI acts as its own pseudo-guild "cli"; the env token is stored only in the CLI database.
      const [scope, ...name] = rest;
      const existing = store.getGdToken('cli');
      if (config.grepodataToken && looksLikeJwt(config.grepodataToken) && existing?.accessToken !== config.grepodataToken) saveToken(store, 'cli', config.grepodataToken, config.grepodataRefreshToken || null, null, 'env');
      const r = scope === 'town' ? await intelTown(ctx, 'cli', 'cli', world, name.join(' '), lang) : await intelBrowse(ctx, 'cli', 'cli', world, scope as 'player' | 'alliance', name.join(' '), lang);
      console.log(embedToText(r.embed));
      return;
    }
    default: usage();
  }
}

main().catch((e) => {
  if (e instanceof UserError) { console.error(`! ${t(lang, e.key, e.vars)}`); process.exit(2); }
  console.error(e); process.exit(1);
});
