import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeName, parseAlliances, parseConquers, parseKills, parsePlayers, parseTowns } from '../src/data/parse.js';
import { oceanOf, parseOceanList, distance } from '../src/geo.js';
import { searchByName } from '../src/data/snapshot.js';
import { snap } from './helpers.js';

const fixture = (n: string) => gunzipSync(readFileSync(new URL(`./fixtures/${n}`, import.meta.url))).toString('utf8');

describe('decodeName', () => {
  it('decodes PHP urlencode', () => {
    expect(decodeName('Bob+the+Great')).toBe('Bob the Great');
    expect(decodeName('Cara%27s')).toBe("Cara's");
    expect(decodeName('firebird%2A')).toBe('firebird*');
    expect(decodeName('%CE%A0%CF%8C%CE%BB%CE%B7')).toBe('Πόλη');
    expect(decodeName('a%2Cb')).toBe('a,b'); // comma survives because we split before decoding
  });
  it('never throws on malformed escapes', () => {
    expect(decodeName('100%+sure%ZZ')).toBe('100% sure%ZZ');
    expect(decodeName('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('parsers', () => {
  it('parses players with and without alliance', () => {
    const p = parsePlayers('1,Alice,10,1000,1,2\n2,Bob,,500,2,1\n\n');
    expect(p).toEqual([
      { id: 1, name: 'Alice', allianceId: 10, points: 1000, rank: 1, towns: 2 },
      { id: 2, name: 'Bob', allianceId: null, points: 500, rank: 2, towns: 1 },
    ]);
  });
  it('parses alliances, towns (ghost), conquers (empty fields), kills', () => {
    expect(parseAlliances('464,GoldHunter,31200,4,1,26')[0]).toEqual({ id: 464, name: 'GoldHunter', points: 31200, towns: 4, members: 1, rank: 26 });
    expect(parseTowns('400,,Ghost,452,532,5,900')[0]).toMatchObject({ id: 400, playerId: null, islandX: 452, islandY: 532, slot: 5, points: 900 });
    expect(parseConquers('52,1777576061,1830978,,102,,562')[0]).toEqual({ townId: 52, time: 1777576061, newPlayerId: 1830978, oldPlayerId: null, newAllianceId: 102, oldAllianceId: null, townPoints: 562 });
    expect(parseKills('430,849019046,0\n')).toEqual([{ rank: 430, id: 849019046, points: 0 }]);
  });
  it('skips short/garbage lines and handles CRLF', () => {
    expect(parsePlayers('garbage\r\n1,A,,1,1,1\r\n')).toHaveLength(1);
  });
  it('parses real en180 files (captured 2026-11-24)', () => {
    const players = parsePlayers(fixture('en180_players.txt.gz'));
    const towns = parseTowns(fixture('en180_towns.txt.gz'));
    const conquers = parseConquers(fixture('en180_conquers.txt.gz'));
    expect(players.length).toBeGreaterThan(400);
    expect(towns.length).toBeGreaterThan(16000);
    expect(conquers.length).toBeGreaterThan(14000);
    expect(players.every((p) => p.id > 0 && !p.name.includes('+'))).toBe(true);
    expect(towns.some((t) => t.playerId === null)).toBe(true);
    expect(players.find((p) => p.id === 849084462)?.name).toBe('yetis 717');
  });
});

describe('geo', () => {
  it('computes ocean numbers', () => {
    expect(oceanOf(450, 530)).toBe(45);
    expect(oceanOf(438, 508)).toBe(45); // en180 town "45 Zero" lives at (438|508)
    expect(oceanOf(602, 574)).toBe(65);
    expect(oceanOf(5, 9)).toBe(0);
  });
  it('parses ocean lists and distances', () => {
    expect(parseOceanList('45, 46;55 x 120')).toEqual([45, 46, 55]);
    expect(parseOceanList(undefined)).toEqual([]);
    expect(distance(0, 0, 3, 4)).toBe(5);
  });
});

describe('snapshot', () => {
  it('builds indexes', () => {
    const s = snap();
    expect(s.players.get(2)?.name).toBe('Bob the Great');
    expect(s.townsByPlayer.get(1)?.map((t) => t.id)).toEqual([100, 101]);
    expect(s.playerAbp.get(1)).toBe(5000);
    expect(s.allianceAbp.get(10)).toBe(5000);
  });
  it('searchByName ranks prefix matches first, then by score', () => {
    const items = [{ name: 'xAlice', s: 9 }, { name: 'Alice', s: 1 }, { name: 'Alicia', s: 5 }];
    expect(searchByName(items, 'ali', 10, (x) => x.s).map((x) => x.name)).toEqual(['Alicia', 'Alice', 'xAlice']);
  });
});
