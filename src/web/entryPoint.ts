/**
 * The Activity app's Entry Point command (type 4 PRIMARY_ENTRY_POINT, handler 2 DISCORD_LAUNCH_ACTIVITY): what the App
 * Launcher / 🚀 button runs. Registered with a client-credentials token of the Activity app (scope
 * applications.commands.update), created or edited in place: never a bulk overwrite, so other commands stay untouched.
 */
import { config } from '../config.js';

const API = 'https://discord.com/api/v10';

export const ENTRY_POINT = {
  type: 4,
  handler: 2,
  name: 'launch',
  name_localizations: { el: 'εκκίνηση' },
  description: 'Open GrepoCord Live: live incoming attacks and the world map',
  description_localizations: { el: 'Άνοιγμα GrepoCord Live: ζωντανές επιθέσεις και χάρτης του κόσμου' },
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

interface Cmd { id: string; type?: number; name: string; handler?: number; description?: string; name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null; integration_types?: number[]; contexts?: number[] | null }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sorted = (x?: number[] | null) => (x ? [...x].sort() : null);
export function entryPointUpToDate(c: Cmd): boolean {
  return c.name === ENTRY_POINT.name && c.handler === ENTRY_POINT.handler && c.description === ENTRY_POINT.description
    && same(c.name_localizations, ENTRY_POINT.name_localizations) && same(c.description_localizations, ENTRY_POINT.description_localizations)
    && same(sorted(c.integration_types), ENTRY_POINT.integration_types) && same(sorted(c.contexts), ENTRY_POINT.contexts);
}

async function call<T>(f: typeof fetch, method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await f(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j as T;
}

export type EntryPointResult = { status: 'skipped' | 'created' | 'updated' | 'unchanged'; message: string };

export async function ensureEntryPoint(f: typeof fetch = fetch, id = config.activityClientId, secret = config.activityClientSecret): Promise<EntryPointResult> {
  if (!id || !secret) return { status: 'skipped', message: 'Entry Point command skipped: set ACTIVITY_CLIENT_ID and ACTIVITY_CLIENT_SECRET in .env to register the Activity\'s "launch" command.' };
  const tr = await f(`${API}/oauth2/token`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'applications.commands.update' }),
  });
  const tj = (await tr.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tr.ok || !tj.access_token) {
    throw new Error(`Activity app token failed: HTTP ${tr.status} ${tj.error ?? ''} ${tj.error_description ?? ''}`.trim()
      + (tj.error === 'invalid_client' ? ' (check ACTIVITY_CLIENT_ID / ACTIVITY_CLIENT_SECRET)' : ''));
  }
  const token = tj.access_token;
  const cmds = await call<Cmd[]>(f, 'GET', `/applications/${id}/commands`, token);
  const ep = cmds.find((c) => c.type === 4);
  if (!ep) {
    const c = await call<Cmd>(f, 'POST', `/applications/${id}/commands`, token, ENTRY_POINT);
    return { status: 'created', message: `Entry Point command /${c.name} created (id ${c.id}) for Activity app ${id}; ${cmds.length} other command(s) left untouched.` };
  }
  if (entryPointUpToDate(ep)) return { status: 'unchanged', message: `Entry Point command /${ep.name} already up to date (id ${ep.id}) for Activity app ${id}.` };
  const c = await call<Cmd>(f, 'PATCH', `/applications/${id}/commands/${ep.id}`, token, ENTRY_POINT);
  return { status: 'updated', message: `Entry Point command updated: /${ep.name} → /${c.name} (id ${c.id}) for Activity app ${id}; ${cmds.length - 1} other command(s) left untouched.` };
}
