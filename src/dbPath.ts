/**
 * Resolve the SQLite path with backwards compatibility for the pre-rename file name.
 * v1 (GrepoDiscord) stored `grepodiscord.sqlite`; v1.1 (GrepoCord) uses `grepocord.sqlite`.
 * If the new file does not exist but the legacy one does (same directory), it is renamed in place
 * together with its -wal/-shm companions. If the rename fails, the legacy file is used as-is.
 */
import { existsSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const LEGACY_DB_NAME = 'grepodiscord.sqlite';
export const DB_NAME = 'grepocord.sqlite';

export function resolveDbPath(configured: string, log: (m: string) => void = () => undefined): string {
  if (configured === ':memory:' || basename(configured) !== DB_NAME || existsSync(configured)) return configured;
  const legacy = join(dirname(configured), LEGACY_DB_NAME);
  if (!existsSync(legacy)) return configured;
  try {
    for (const suffix of ['-wal', '-shm']) if (existsSync(legacy + suffix)) renameSync(legacy + suffix, configured + suffix);
    renameSync(legacy, configured);
    log(`Migrated database ${legacy} -> ${configured}`);
    return configured;
  } catch (e) {
    log(`Could not rename legacy database (${e}); using ${legacy}`);
    return legacy;
  }
}
