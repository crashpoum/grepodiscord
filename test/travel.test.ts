import { describe, expect, it } from 'vitest';
import { fallbackSpeeds, fmtHms, islandPx, mapBoostedSpeed, mapRangeRadius, mapTownTravel, parseMapQuery } from '../src/web/travel.js';
import { WEB_STRINGS } from '../src/web/strings.js';

describe('map travel time ruler', () => {
  const sp = fallbackSpeeds(3, 2); // world 3x, unit 2x

  it('computes travel time and same-island uncertainty per unit and transport', () => {
    const a = { ix: 500, iy: 500 }, b = { ix: 505, iy: 503 };
    const ls = mapTownTravel(a, b, 'attack_ship', sp)!;
    const cs = mapTownTravel(a, b, 'colonize_ship', sp)!;
    expect(ls.sameIsland).toBe(false);
    expect(ls.viaTransport).toBeNull();
    expect(cs.seconds).toBeGreaterThan(ls.seconds * 2);

    // Land unit off-island travels by transport boat; fast transport cuts travel time.
    const slowLand = mapTownTravel(a, b, 'slinger', sp)!;
    const fastLand = mapTownTravel(a, b, 'slinger', sp, { transport: 'small_transporter' })!;
    expect(slowLand.viaTransport).toBe('big_transporter');
    expect(fastLand.viaTransport).toBe('small_transporter');
    expect(fastLand.seconds).toBeLessThan(slowLand.seconds);

    // Same island uses intra-island spread without transport boat.
    const same = mapTownTravel(a, a, 'hoplite', sp)!;
    expect(same.sameIsland).toBe(true);
    expect(same.viaTransport).toBeNull();
    expect(same.uncertainty).toBeGreaterThan(0);
    expect(fmtHms(3661)).toBe('1:01:01');
  });

  it('applies speed bonuses correctly (meteorology=land/fly, cartography/lighthouse=naval, boost%=all)', () => {
    const uNav = sp.units.attack_ship;
    const uLand = sp.units.rider;
    expect(mapBoostedSpeed(uNav, { meteorology: true })).toBe(uNav.speed);
    expect(mapBoostedSpeed(uNav, { cartography: true, lighthouse: true })).toBeCloseTo(uNav.speed * 1.25);
    expect(mapBoostedSpeed(uLand, { cartography: true, lighthouse: true })).toBe(uLand.speed);
    expect(mapBoostedSpeed(uLand, { meteorology: true, boost: 20 })).toBeCloseTo(uLand.speed * 1.1 * 1.2);
  });

  it('range radius is the exact inverse of mapTownTravel along axis', () => {
    const r = mapRangeRadius('attack_ship', 3600, sp, { cartography: true });
    expect(r).toBeGreaterThan(0);
    // A town at (500 + r, 500) on an even-x-parity island has ~3600s travel time.
    const ix = Math.round(500 + r);
    const est = mapTownTravel({ ix: 500, iy: 500 }, { ix: ix % 2 === 0 ? ix : ix - 1, iy: 500 }, 'attack_ship', sp, { cartography: true })!;
    expect(Math.abs(est.seconds - 3600)).toBeLessThan(200);
    expect(islandPx(501, 500).y - islandPx(500, 500).y).toBe(64);
    expect(mapRangeRadius('attack_ship', 200, sp)).toBe(0); // <= 900/worldSpeed = 300s
  });
});

describe('smart map search query parser & strings', () => {
  it('parses oceans (EN+GR) and coordinates', () => {
    expect(parseMapQuery('45')).toEqual({ kind: 'ocean', ocean: 45 });
    expect(parseMapQuery('o45')).toEqual({ kind: 'ocean', ocean: 45 });
    expect(parseMapQuery('Ocean 55')).toEqual({ kind: 'ocean', ocean: 55 });
    expect(parseMapQuery('ωκεανός 34')).toEqual({ kind: 'ocean', ocean: 34 });
    expect(parseMapQuery('450|530')).toEqual({ kind: 'xy', ix: 450, iy: 530 });
    expect(parseMapQuery('450, 530')).toEqual({ kind: 'xy', ix: 450, iy: 530 });
    expect(parseMapQuery('Sparta')).toBeNull();
  });

  it('has EN and GR strings for all map tools', () => {
    for (const k of ['mapRuler', 'mapRange', 'mapMovements', 'mapSearchPlaceholder', 'mapMeteorology', 'mapCartography', 'mapLighthouse'] as const) {
      expect(WEB_STRINGS.en[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).not.toBe(WEB_STRINGS.en[k]);
    }
  });
});
