/** Map helpers. Coordinates are the island grid coordinates from towns.txt (0..~1000). */

/** Ocean number as shown in game: tens digit = x/100, units digit = y/100 (e.g. x=450,y=530 -> 45). */
export function oceanOf(x: number, y: number): number {
  return Math.floor(x / 100) * 10 + Math.floor(y / 100);
}

/**
 * Straight-line distance in island-grid units. Exact in-game distance also depends on the
 * town's slot inside the island (island templates are not public), so treat this as approximate.
 */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Parse "45" or "45, 46 ,55" into ocean numbers (0..99). Invalid entries are dropped. */
export function parseOceanList(s: string | null | undefined): number[] {
  if (!s) return [];
  return s.split(/[\s,;]+/).map((x) => Number.parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 99);
}
