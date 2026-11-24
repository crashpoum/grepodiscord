/**
 * Downloads the official, public world data files (https://{world}.grepolis.com/data/*.txt.gz).
 * Uses ETag / If-Modified-Since so polling is nearly free; bodies of unchanged files come from the store.
 * This is public data published by InnoGames for external tools; no game login, no internal game API.
 */
import { gunzipSync } from 'node:zlib';
import { config } from '../config.js';
import { log } from '../log.js';
import { WORLD_FILE_NAMES, type WorldFileName } from './snapshot.js';
import { backoffMs, sleep } from './ratelimit.js';

export interface CachedFile { etag: string | null; lastModified: string | null; body: string; fetchedAt: number }
export interface FileStore {
  getFile(world: string, file: string): CachedFile | null;
  /** Previous body (before the latest change) for diffing. */
  putFile(world: string, file: string, f: CachedFile): void;
}

export const WORLD_ID_RE = /^([a-z]{2})(\d{1,4})$/;
export function isValidWorldId(w: string, markets = config.markets): boolean {
  const m = WORLD_ID_RE.exec(w);
  return !!m && markets.includes(m[1]);
}

export const fileUrl = (world: string, file: string) => `https://${world}.grepolis.com/data/${file}.txt.gz`;

export interface FetchResult { changed: Set<WorldFileName>; previous: Partial<Record<WorldFileName, string>>; current: Record<WorldFileName, string> }

async function getWithRetry(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(backoffMs(i, 2000)); continue; }
      return res;
    } catch (e) { last = e; await sleep(backoffMs(i, 2000)); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** True if HTTP date `a` is strictly older than `b` (unparseable dates are never "older"). */
export function isOlder(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta < tb;
}

/** Fetch all files for a world; returns which changed plus previous bodies for diffing. */
export async function fetchWorldFiles(world: string, store: FileStore, fetchImpl: typeof fetch = fetch): Promise<FetchResult> {
  const changed = new Set<WorldFileName>();
  const previous: Partial<Record<WorldFileName, string>> = {};
  const current = {} as Record<WorldFileName, string>;
  for (const file of WORLD_FILE_NAMES) {
    const cached = store.getFile(world, file);
    const headers: Record<string, string> = { 'User-Agent': config.userAgent };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await getWithRetry(fileUrl(world, file), headers, fetchImpl);
    if (res.status === 304 && cached) { current[file] = cached.body; continue; }
    if (res.status === 400 || res.status === 404) {
      if (file.startsWith('alliance_kills')) { current[file] = cached?.body ?? ''; continue; }
      throw new Error(`World ${world} not available (${file}: HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    // grepolis.com serves the files from several backends that are not always in sync: a later request can
    // return an OLDER version. Never go backwards, or diffs would emit reversed events (join, then leave).
    if (cached && isOlder(res.headers.get('last-modified'), cached.lastModified)) {
      log.debug(`[${world}] ${file}: ignoring stale copy (${res.headers.get('last-modified')} < ${cached.lastModified})`);
      current[file] = cached.body;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    let body: string;
    try { body = gunzipSync(buf).toString('utf8'); } catch { body = buf.toString('utf8'); }
    current[file] = body;
    if (!cached || cached.body !== body) {
      changed.add(file);
      if (cached) previous[file] = cached.body;
    }
    store.putFile(world, file, { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), body, fetchedAt: Date.now() });
  }
  if (changed.size) log.info(`[${world}] changed: ${[...changed].join(', ')}`);
  return { changed, previous, current };
}

/** Cheap existence check for a world (200 = live, 400 = unknown/closed). */
export async function worldExists(world: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://${world}.grepolis.com/data/world_settings.json`, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch { return false; }
}

/** In-memory FileStore (CLI / tests). */
export class MemoryFileStore implements FileStore {
  private m = new Map<string, CachedFile>();
  getFile(w: string, f: string) { return this.m.get(`${w}/${f}`) ?? null; }
  putFile(w: string, f: string, c: CachedFile) { this.m.set(`${w}/${f}`, c); }
}
