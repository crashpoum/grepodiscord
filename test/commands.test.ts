import { describe, expect, it } from 'vitest';
import { commandJson } from '../src/bot/commands.js';
import { STRINGS } from '../src/i18n.js';

type Node = { name: string; description?: string; type?: number; name_localizations?: Record<string, string>; description_localizations?: Record<string, string>; options?: Node[]; choices?: { name: string; value: unknown; name_localizations?: Record<string, string> }[] };
const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;

function* walk(nodes: Node[], path: string[] = []): Generator<[Node, string[]]> {
  for (const n of nodes) { yield [n, path]; if (n.options) yield* walk(n.options, [...path, n.name]); }
}

describe('slash commands: Greek localization', () => {
  const cmds = commandJson() as unknown as Node[];

  it('every command, subcommand and option has a valid Greek name and description', () => {
    const missing: string[] = [];
    for (const [n, path] of walk(cmds)) {
      const id = [...path, n.name].join('/');
      const el = n.name_localizations?.el;
      const d = n.description_localizations?.el;
      if (!el || !d) { missing.push(id); continue; }
      for (const name of [n.name, el]) {
        expect(name, id).toMatch(NAME_RE);
        expect(name, id).toBe(name.toLowerCase());
      }
      expect(d.length, id).toBeLessThanOrEqual(100);
      expect(n.description!.length, id).toBeLessThanOrEqual(100);
    }
    expect(missing).toEqual([]);
  });

  it('every choice has a Greek name', () => {
    const missing: string[] = [];
    for (const [n, path] of walk(cmds)) for (const c of n.choices ?? []) {
      if (!c.name_localizations?.el) missing.push(`${[...path, n.name].join('/')}=${String(c.value)}`);
      else expect(c.name_localizations.el.length).toBeLessThanOrEqual(100);
    }
    expect(missing).toEqual([]);
  });

  it('required options come before optional ones (Discord rejects the command otherwise)', () => {
    for (const [n, path] of walk(cmds)) {
      const opts = (n.options ?? []).filter((o) => o.type !== 1 && o.type !== 2) as (Node & { required?: boolean })[];
      const firstOptional = opts.findIndex((o) => !o.required);
      if (firstOptional >= 0) expect(opts.slice(firstOptional).some((o) => o.required), [...path, n.name].join('/')).toBe(false);
    }
  });

  it('names are unique per level in both languages', () => {
    const levels: Node[][] = [cmds];
    for (const [n] of walk(cmds)) if (n.options) levels.push(n.options);
    for (const lvl of levels) {
      for (const pick of [(x: Node) => x.name, (x: Node) => x.name_localizations?.el ?? x.name]) {
        const names = lvl.map(pick);
        expect(new Set(names).size, names.join(',')).toBe(names.length);
      }
    }
  });

  it('all texts mention only commands that exist (English names in EN, Greek names in EL)', () => {
    const en = new Set(cmds.map((c) => c.name));
    const el = new Set(cmds.map((c) => c.name_localizations!.el));
    const refs = (s: string) => [...s.matchAll(/`\/([^\s`|]+)/g)].map((m) => m[1]);
    for (const v of Object.values(STRINGS.en)) for (const r of refs(v)) expect(en.has(r), r).toBe(true);
    for (const v of Object.values(STRINGS.el)) for (const r of refs(v)) expect(el.has(r), r).toBe(true);
  });
});
