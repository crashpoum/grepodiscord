/**
 * Is the Activity app actually set up as an Activity? Discord's public app info (GET /applications/<id>/rpc, no auth)
 * carries the EMBEDDED flag (1 << 17) and `embedded_surfaces` once "Enable Activities" is switched on in the portal.
 * Without it, https://discord.com/activities/<id> links silently do nothing, so the bot hides the button and says why.
 */
import { config } from '../config.js';
import { log } from '../log.js';

export const EMBEDDED = 1 << 17;
export type ActivityState = 'enabled' | 'disabled' | 'unknown';
let state: ActivityState = 'unknown';
let checkedAt = 0;

export function activityState(): ActivityState { return state; }
/** For tests. */
export function setActivityState(s: ActivityState) { state = s; checkedAt = Date.now(); }

export function readActivityInfo(j: { flags?: number; embedded_surfaces?: unknown[] }): ActivityState {
  if (typeof j.flags !== 'number') return 'unknown';
  return (j.flags & EMBEDDED) !== 0 || (Array.isArray(j.embedded_surfaces) && j.embedded_surfaces.length > 0) ? 'enabled' : 'disabled';
}

export async function checkActivityApp(fetchImpl: typeof fetch = fetch, id = config.activityClientId): Promise<ActivityState> {
  if (!id) return (state = 'unknown');
  try {
    const res = await fetchImpl(`https://discord.com/api/v10/applications/${id}/rpc`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { log.warn(`web: could not read Activity app ${id} info (HTTP ${res.status})`); return state; }
    const prev = state;
    state = readActivityInfo((await res.json()) as { flags?: number; embedded_surfaces?: unknown[] });
    checkedAt = Date.now();
    if (state === 'disabled' && prev !== 'disabled') {
      log.warn(`web: Activity app ${id} does NOT have Activities enabled, so "Open in Discord" is hidden. Developer Portal → your Activity app → Activities → Settings → Enable Activities, then Activities → URL Mappings: "/" → ${config.publicUrl.replace(/^https?:\/\//, '') || '<your public host>'}`);
    } else if (state === 'enabled' && prev !== 'enabled') log.info(`web: Activity app ${id}: Activities enabled`);
  } catch (e) { log.warn(`web: Activity app check failed: ${(e as Error).message}`); }
  return state;
}

/** Re-check every 10 minutes (portal changes take effect without a restart). */
export function watchActivityApp(fetchImpl: typeof fetch = fetch) {
  void checkActivityApp(fetchImpl);
  const t = setInterval(() => { if (Date.now() - checkedAt > 9 * 60_000) void checkActivityApp(fetchImpl); }, 10 * 60_000);
  t.unref?.();
  return () => clearInterval(t);
}
