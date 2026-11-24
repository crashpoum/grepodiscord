import { describe, expect, it } from 'vitest';
import { activeCommands, selectCommands } from '../src/web/live.js';
import { describeCommand, GP_CMD_ICONS } from '../src/web/cmdKind.js';
import { filterCommands, infoOf, totalUnits } from '../web/src/liveView.js';
import { emptyFilters } from '../web/src/views.js';
import type { GdSharedCommand } from '../src/data/grepodata.js';

const NOW = 1_795_600_000; // 2026-11-24 ~23:46 Athens
/** A command exactly as GrepoData's /commands/get returns it (Commands::AddCommands + RenderCommandDocument). */
const gd = (id: string, over: Partial<GdSharedCommand> & Record<string, unknown> = {}): GdSharedCommand => ({
  es_id: `${NOW + 600}${id}team1`, team: 'team1', updated_at: NOW - 30, arrival_at: NOW + 600, arrival_human: '23:56:44 Nov 24', cancel_human: '', started_at: NOW - 1200,
  upload_uid: 7, upload_id: 1001, upload_n: 'crashpoum99', cmd_id: id, type: 'attack_land', subtype: 'default', own_command: true, is_planned: false, return: false,
  attacking_strategy: 'regular', units: '{"sword":120,"slinger":300}', comments: [], delete_status: '',
  src_twn_id: 501, src_all_id: 10, src_ply_id: 1001, src_twn_n: "16. Urj'Annish", src_all_n: 'OURS', src_ply_n: 'crashpoum99',
  trg_twn_id: 777, trg_all_id: 20, trg_ply_id: 2002, trg_twn_n: '005.', trg_all_n: 'ENEMY', trg_ply_n: 'Gregoryy',
  ...over,
} as GdSharedCommand);
const OURS = new Set([10]);

describe('/live shows every command GrepoData shows (root cause of the missing row)', () => {
  it('keeps fresh own commands: cancel_human is "cancelable until", not a cancellation', () => {
    // The reported row: 16. Urj'Annish (crashpoum99) -> 005. (Gregoryy), arriving 23:56:44, sent a few minutes ago.
    const fresh = gd('attack_84512', { started_at: NOW - 240, cancel_human: '23:50:04 Nov 24', cancelable: true });
    const out = activeCommands([fresh], OURS, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ src: { town: "16. Urj'Annish", player: 'crashpoum99' }, trg: { town: '005.', player: 'Gregoryy' }, side: 'out', by: 'crashpoum99', own: true });
    expect(infoOf(out[0], NOW)).toMatchObject({ kind: 'attack', icon: 'attack_land', label: 'arrival' });
  });
  it('own support to an enemy town is shown as outgoing support (no side/type filtering in the data path)', () => {
    const sup = gd('support_9', { type: 'support', cancel_human: '23:55:00 Nov 24', units: '{"hoplite":200}' });
    const internal = gd('support_10', { type: 'support', trg_all_id: 10, trg_all_n: 'OURS' });
    const theirs = gd('attack_11', { src_all_id: 30, trg_all_id: 40, own_command: false });
    const out = activeCommands([sup, internal, theirs], OURS, NOW);
    expect(out.map((c) => [c.id.replace(/^\d+|team1$/g, ''), c.side, infoOf(c, NOW).kind])).toEqual(expect.arrayContaining([
      ['support_9', 'out', 'support'], ['support_10', 'other', 'support'], ['attack_11', 'other', 'attack'],
    ]));
    expect(out).toHaveLength(3);
    // and nothing is hidden by the default view either
    expect(filterCommands(out, emptyFilters())).toHaveLength(3);
  });
  it('only drops what GrepoData drops, and says why', () => {
    const r = selectCommands([
      gd('a'), gd('hard', { delete_status: 'hard' }), gd('soft', { delete_status: 'soft' }), gd('old', { arrival_at: NOW - 61 }),
      gd('pcmd1', { is_planned: true, started_at: NOW - 5, cancel_human: '23:45 Nov 24' }), gd('pcmd2', { is_planned: true, started_at: NOW + 300 }),
      gd('weird', { type: 'brand_new_type', subtype: 'whatever' }), gd('noid', { es_id: '' }), gd('noUnits', { units: '[]' }),
    ], OURS, NOW);
    expect(r.fetched).toBe(9);
    expect(r.dropped).toEqual({ deleted: 1, arrived: 1, departed: 1 });
    expect(r.commands.map((c) => c.id)).toHaveLength(6);
    const soft = r.commands.find((c) => c.id.includes('soft'))!;
    expect(soft.deleted).toBe(true);
    expect(infoOf(r.commands.find((c) => c.type === 'brand_new_type')!, NOW).kind).toBe('other');
    expect(r.commands.find((c) => c.id === 'noid:' + (NOW + 600))).toBeTruthy();
    expect(infoOf(r.commands.find((c) => c.planned)!, NOW)).toMatchObject({ label: 'planned' });
  });
  it('the same command shared in two of our teams is shown once; no hidden row cap', () => {
    const a = gd('x1'), b = { ...gd('x1'), es_id: `${NOW + 600}x1team2`, team: 'team2' };
    expect(activeCommands([a, b], OURS, NOW)).toHaveLength(1);
    const many = Array.from({ length: 450 }, (_, i) => gd(`m${i}`, { arrival_at: NOW + 100 + i }));
    expect(activeCommands(many, OURS, NOW)).toHaveLength(450);
  });
});

describe('command kinds match GrepoData', () => {
  const k = (type: string, sub = 'default', extra: Partial<Parameters<typeof describeCommand>[0]> = {}) =>
    describeCommand({ type, sub, ret: false, planned: false, started: NOW - 100, arrival: NOW + 1000, ...extra }, NOW);
  it('colonization vs running conquest vs travelling colony ship', () => {
    expect(k('foundation', 'cs_eta')).toMatchObject({ kind: 'colonize', icon: 'foundation', label: 'colonized' });
    expect(k('colonization')).toMatchObject({ kind: 'colonize', icon: 'colonization', label: 'arrival' });
    expect(k('attack_takeover', 'attack_takeover')).toMatchObject({ kind: 'siege', icon: 'attack_takeover', label: 'conquered', badges: ['siege'] });
    expect(k('attack_takeover', 'command')).toMatchObject({ kind: 'conquest', icon: 'attack_takeover', label: 'arrival' });
  });
  it('revolts: arising counts down to phase 2 start, running to its end', () => {
    expect(k('revolt', 'ongoing_revolt', { started: NOW + 300 })).toMatchObject({ kind: 'revolt', icon: 'revolt_arising', label: 'revoltP2', countdownAt: NOW + 300, badges: ['revoltArising'] });
    expect(k('revolt', 'ongoing_revolt', { started: NOW - 300 })).toMatchObject({ icon: 'revolt_running', countdownAt: NOW + 1000, badges: ['revoltRunning'] });
    expect(k('revolt', 'default', { strat: 'revolt_arising' })).toMatchObject({ kind: 'revolt', icon: 'revolt_arising', label: 'arrival' });
  });
  it('every other type, returns, portals, quests and planned', () => {
    expect(k('attack')).toMatchObject({ kind: 'attack', icon: 'attack' });
    expect(k('attack_sea')).toMatchObject({ kind: 'attack', icon: 'attack_sea' });
    expect(k('breakthrough')).toMatchObject({ kind: 'attack', icon: 'breakthrough' });
    expect(k('attack_spy')).toMatchObject({ kind: 'spy', icon: 'attack_spy' });
    expect(k('farm_attack')).toMatchObject({ kind: 'farm', icon: 'farm_attack' });
    expect(k('abort')).toMatchObject({ kind: 'return', icon: 'abort' });
    expect(k('support', 'default', { ret: true })).toMatchObject({ kind: 'return', icon: 'support', badges: ['returning'] });
    expect(k('portal_attack_olympus', 'portal')).toMatchObject({ kind: 'attack', icon: 'portal_attack_olympus', label: 'arrivalPortal', badges: ['portal'] });
    expect(k('portal_support_olympus', 'portal')).toMatchObject({ kind: 'support', icon: 'portal_support_olympus' });
    expect(k('attack_land', 'quest').badges).toEqual(['quest']);
    expect(k('attack_land', 'default', { planned: true })).toMatchObject({ label: 'planned', badges: ['planned'] });
    expect(k('mystery')).toMatchObject({ kind: 'other', icon: null });
    for (const t of ['attack', 'attack_land', 'attack_sea', 'attack_spy', 'attack_takeover', 'support', 'abort', 'farm_attack', 'revolt', 'breakthrough', 'colonization', 'foundation', 'portal_attack_olympus', 'portal_support_olympus'])
      expect(GP_CMD_ICONS).toContain(t);
  });
  it('spy commands carry silver, not units', () => {
    const [c] = activeCommands([gd('esp', { type: 'attack_spy', units: '15000' })], OURS, NOW);
    expect(c).toMatchObject({ silver: 15000, units: [] });
  });
});

describe('Total units bar', () => {
  it('sums the filtered commands, skips hidden ones, counts unknown-unit commands', () => {
    const cmds = activeCommands([
      gd('a', { units: '{"sword":100,"bireme":5}' }), gd('b', { units: '{"sword":50}', type: 'support' }), gd('c', { units: '[]' }),
      gd('d', { units: '{"sword":999}', delete_status: 'soft' }), gd('e', { type: 'attack_spy', units: '2000' }),
    ], OURS, NOW);
    const t = totalUnits(cmds);
    expect(Object.fromEntries(t.units)).toEqual({ sword: 150, bireme: 5 });
    expect(t.unknown).toBe(1);
    const noSupport = filterCommands(cmds, { ...emptyFilters(), support: false });
    expect(Object.fromEntries(totalUnits(noSupport).units)).toEqual({ sword: 100, bireme: 5 });
    const onlyBireme = filterCommands(cmds, { ...emptyFilters(), units: ['bireme'] });
    expect(Object.fromEntries(totalUnits(onlyBireme).units)).toEqual({ sword: 100, bireme: 5 });
  });
});
