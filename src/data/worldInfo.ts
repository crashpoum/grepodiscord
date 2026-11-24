/**
 * Per-world static data for calculators: official units.json (unit speeds incl. the world's unit speed)
 * and world_settings.json (world speed). Public files at https://{world}.grepolis.com/data/, cached in the
 * file_cache table and re-checked at most every 12 hours (conditional GET).
 */
import { config } from '../config.js';
import { log } from '../log.js';
import type { FileStore } from './official.js';
import { parseUnits, parseWorldSpeeds, type WorldInfo } from '../planner.js';

const MAX_AGE_MS = 12 * 3_600_000;
const mem = new Map<string, { info: WorldInfo; at: number }>();

async function getJsonFile(world: string, name: string, store: FileStore, fetchImpl: typeof fetch): Promise<string> {
  const cached = store.getFile(world, name);
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached.body;
  try {
    const headers: Record<string, string> = { 'User-Agent': config.userAgent };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await fetchImpl(`https://${world}.grepolis.com/data/${name}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.status === 304 && cached) { store.putFile(world, name, { ...cached, fetchedAt: Date.now() }); return cached.body; }
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = await res.text();
    JSON.parse(body); // validate before caching
    store.putFile(world, name, { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), body, fetchedAt: Date.now() });
    return body;
  } catch (e) {
    if (cached) { log.warn(`[${world}] ${name} refresh failed, using cache: ${e}`); return cached.body; }
    throw e;
  }
}

export async function getWorldInfo(world: string, store: FileStore, fetchImpl: typeof fetch = fetch): Promise<WorldInfo> {
  const m = mem.get(world);
  if (m && Date.now() - m.at < MAX_AGE_MS) return m.info;
  const [units, settings] = await Promise.all([getJsonFile(world, 'units.json', store, fetchImpl), getJsonFile(world, 'world_settings.json', store, fetchImpl)]);
  const info: WorldInfo = { units: parseUnits(units), ...parseWorldSpeeds(settings) };
  mem.set(world, { info, at: Date.now() });
  return info;
}

/** Cached-only lookup (autocomplete must answer in < 3 s). */
export function peekWorldInfo(world: string): WorldInfo | undefined { return mem.get(world)?.info; }
