/**
 * Turn any failure into a specific, localized message, and log the underlying cause.
 * Known causes (GrepoData status codes, grepolis.com outages, missing Discord permissions) get their own
 * message; only truly unexpected errors fall back to "something went wrong" (logged with stack).
 */
import type { APIEmbed } from 'discord.js';
import { GrepoDataError } from '../data/grepodata.js';
import { UserError } from '../gdServices.js';
import type { StringKey } from '../i18n.js';
import { log } from '../log.js';

export interface Classified { key: StringKey; vars: Record<string, string | number>; expected: boolean }

export function classifyError(e: unknown): Classified {
  if (e instanceof UserError) return { key: e.key, vars: e.vars, expected: true };
  if (e instanceof GrepoDataError) {
    if (e.status === 429 || e.status === 503) return { key: 'gd.rateLimited', vars: {}, expected: true };
    if (e.status === 401 || e.status === 403) return { key: 'gd.auth', vars: {}, expected: true };
    if (e.status === 404) return { key: 'gd.notFound', vars: {}, expected: true };
    return { key: 'gd.unavailable', vars: {}, expected: true };
  }
  const err = e as { name?: string; message?: string; code?: unknown; cause?: unknown };
  const code = typeof err?.code === 'number' ? err.code : undefined;
  // discord.js DiscordAPIError: 50001 Missing Access, 50013 Missing Permissions
  if (code === 50001 || code === 50013) return { key: 'err.discordPerms', vars: {}, expected: true };
  const msg = String(err?.message ?? '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|not available \(|HTTP 5\d\d/.test(msg)) {
    return { key: 'err.worldData', vars: {}, expected: true };
  }
  return { key: 'err.generic', vars: {}, expected: false };
}

/** Log with the right severity: expected causes as a one-line warning, the rest with stack. */
export function logError(where: string, e: unknown, c = classifyError(e)) {
  if (c.expected) log.warn(`${where}: ${c.key} (${e instanceof Error ? e.message : String(e)})`);
  else log.error(`${where} failed`, e);
}

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Clamp an embed to Discord's limits so a long GrepoData answer can never make the reply fail. */
export function safeEmbed(e: APIEmbed): APIEmbed {
  const out: APIEmbed = { ...e, title: clip(e.title, 256), description: clip(e.description, 4096) };
  if (e.footer) out.footer = { ...e.footer, text: clip(e.footer.text, 2048) ?? '' };
  if (e.fields) {
    out.fields = e.fields.slice(0, 25).map((f) => ({ ...f, name: clip(f.name || '\u200b', 256)!, value: clip(f.value || '-', 1024)! }));
  }
  // Total text across title/description/fields/footer must stay ≤ 6000.
  const size = () => (out.title?.length ?? 0) + (out.description?.length ?? 0) + (out.footer?.text.length ?? 0) + (out.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
  while (size() > 6000 && out.fields && out.fields.length) out.fields.pop();
  if (size() > 6000 && out.description) out.description = clip(out.description, Math.max(1, out.description.length - (size() - 6000)));
  return out;
}
