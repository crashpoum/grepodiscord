import { describe, expect, it } from 'vitest';
import { findCodeTown, generateCode, isExpired, CODE_TTL_HOURS } from '../src/verify.js';
import { roleChanges } from '../src/roles.js';
import { snap } from './helpers.js';

describe('verification', () => {
  it('generates GD + 4 unambiguous chars', () => {
    let k = 0;
    const code = generateCode(() => k++);
    expect(code).toBe('GDABCD');
    for (let n = 0; n < 200; n++) expect(generateCode()).toMatch(/^GD[A-HJ-NP-Z2-9]{4}$/);
  });
  it('finds the code in a town name owned by the player, case/space-insensitive', () => {
    const s = snap();
    expect(findCodeTown(s, 3, 'GDK7Q2')?.id).toBe(300);
    expect(findCodeTown(s, 3, 'gd-k7q2')?.id).toBe(300);
    expect(findCodeTown(s, 1, 'GDK7Q2')).toBeNull(); // another player's town doesn't count
    expect(findCodeTown(s, 999, 'GDK7Q2')).toBeNull();
  });
  it('expires codes after TTL', () => {
    expect(isExpired(0, CODE_TTL_HOURS * 3600)).toBe(false);
    expect(isExpired(0, CODE_TTL_HOURS * 3600 + 1)).toBe(true);
  });
});

describe('roleChanges', () => {
  const cfg = { verifiedRoleId: 'V', allianceRoles: new Map([[10, 'R10'], [20, 'R20']]) };
  const player = (allianceId: number | null) => ({ id: 1, name: 'A', allianceId, points: 1, rank: 1, towns: 1 });
  it('adds verified + alliance role', () => {
    expect(roleChanges(cfg, ['other'], player(10))).toEqual({ add: ['V', 'R10'], remove: [] });
  });
  it('swaps alliance role on switch and never touches unmanaged roles', () => {
    expect(roleChanges(cfg, ['V', 'R10', 'mod'], player(20))).toEqual({ add: ['R20'], remove: ['R10'] });
  });
  it('removes alliance role when player leaves; removes all managed roles when account gone', () => {
    expect(roleChanges(cfg, ['V', 'R10'], player(null))).toEqual({ add: [], remove: ['R10'] });
    expect(roleChanges(cfg, ['V', 'R10', 'mod'], null)).toEqual({ add: [], remove: ['V', 'R10'] });
  });
  it('works without verified role', () => {
    expect(roleChanges({ verifiedRoleId: null, allianceRoles: new Map([[10, 'R10']]) }, [], player(10))).toEqual({ add: ['R10'], remove: [] });
  });
});
