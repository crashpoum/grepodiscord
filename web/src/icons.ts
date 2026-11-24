/**
 * GrepoCord's own icon set: a tiny inline SVG sprite drawn for this project (MIT, like the repo). No InnoGames or
 * GrepoData art is bundled or hot-linked. Every Grepolis unit id maps to a category (land, naval, mythical, hero) and a
 * glyph or a two-letter code on the category colour, so any unit (including new heroes) still gets an icon.
 */
export type UnitCat = 'land' | 'naval' | 'myth' | 'hero';
interface UnitDef { cat: UnitCat; glyph?: string; code: string }

const LAND: Record<string, UnitDef> = {
  militia: { cat: 'land', glyph: 'militia', code: 'Mi' }, sword: { cat: 'land', glyph: 'sword', code: 'Sw' }, slinger: { cat: 'land', glyph: 'sling', code: 'Sl' },
  archer: { cat: 'land', glyph: 'bow', code: 'Ar' }, hoplite: { cat: 'land', glyph: 'shield', code: 'Ho' }, rider: { cat: 'land', glyph: 'horse', code: 'Ri' },
  chariot: { cat: 'land', glyph: 'wheel', code: 'Ch' }, catapult: { cat: 'land', glyph: 'catapult', code: 'Ca' },
};
const NAVAL: Record<string, UnitDef> = {
  big_transporter: { cat: 'naval', glyph: 'transport', code: 'Tr' }, small_transporter: { cat: 'naval', glyph: 'fastboat', code: 'Ft' },
  bireme: { cat: 'naval', glyph: 'bireme', code: 'Bi' }, attack_ship: { cat: 'naval', glyph: 'lightship', code: 'Ls' },
  demolition_ship: { cat: 'naval', glyph: 'fireship', code: 'Fs' }, trireme: { cat: 'naval', glyph: 'trireme', code: 'Tri' },
  colonize_ship: { cat: 'naval', glyph: 'colony', code: 'Co' },
};
const MYTH: Record<string, string> = {
  minotaur: 'Mn', manticore: 'Ma', zyklop: 'Cy', harpy: 'Ha', medusa: 'Me', centaur: 'Ce', pegasus: 'Pe', cerberus: 'Cb', fury: 'Er',
  griffin: 'Gr', calydonian_boar: 'Bo', sea_monster: 'Hy', siren: 'Si', satyr: 'Sa', spartoi: 'Sp', ladon: 'La', godsent: 'Gs',
};
const HEROES = ['achilles', 'agamemnon', 'ajax', 'alexandrios', 'andromeda', 'anysia', 'apheledes', 'argus', 'aristotle', 'atalanta', 'cheiron', 'christopholus',
  'daidalos', 'deimos', 'democritus', 'deryntes', 'ephialtes', 'eurybia', 'ferkyon', 'hector', 'helen', 'hercules', 'iason', 'leonidas', 'lysippe', 'medea',
  'melousa', 'mihalis', 'odysseus', 'orpheus', 'pariphaistes', 'pelops', 'perseus', 'philoctetes', 'rekonos', 'telemachos', 'terylea', 'themistokles',
  'theseus', 'urephon', 'vedouma', 'xanthos', 'ylestres', 'zuretha', 'hippolyta', 'heroes'];

export function unitDef(id: string): UnitDef {
  const k = id.toLowerCase();
  if (LAND[k]) return LAND[k];
  if (NAVAL[k]) return NAVAL[k];
  if (MYTH[k]) return { cat: 'myth', code: MYTH[k] };
  if (HEROES.includes(k)) return { cat: 'hero', glyph: 'star', code: k.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) };
  return { cat: /ship|boat|transport|reme/.test(k) ? 'naval' : 'myth', code: k.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) };
}
export const UNIT_ORDER = [...Object.keys(LAND), ...Object.keys(MYTH), ...Object.keys(NAVAL), ...HEROES];
export const UNIT_IDS = { land: Object.keys(LAND), naval: Object.keys(NAVAL), myth: Object.keys(MYTH), hero: HEROES };

// 24×24 white glyphs (stroke/fill paths), drawn for this project.
const G: Record<string, string> = {
  sword: '<path d="M17 3l4 0 0 4-9 9-3-3z" fill="#fff"/><path d="M5 15l4 4M4 20l3-3M7 13l4 4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  sling: '<path d="M5 4c3 6 5 8 7 9 2-1 4-3 7-9" stroke="#fff" stroke-width="2" fill="none"/><circle cx="12" cy="17" r="3" fill="#fff"/>',
  bow: '<path d="M7 3c8 4 8 14 0 18" stroke="#fff" stroke-width="2" fill="none"/><path d="M7 3v18M5 12h14M16 9l3 3-3 3" stroke="#fff" stroke-width="1.6" fill="none"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" fill="#fff"/><path d="M12 6v12" stroke="#7a5230" stroke-width="2"/>',
  horse: '<path d="M6 20l2-7-3-2 4-6 6 1 4 4-2 2-3-1-1 4 2 5h-2l-2-4-2 4z" fill="#fff"/>',
  wheel: '<circle cx="12" cy="12" r="8" stroke="#fff" stroke-width="2" fill="none"/><path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3L6.3 17.7" stroke="#fff" stroke-width="1.4"/>',
  catapult: '<path d="M4 19h16M7 19l3-6h4l3 6" stroke="#fff" stroke-width="2" fill="none"/><path d="M12 13L18 4" stroke="#fff" stroke-width="2"/><circle cx="18.5" cy="4.5" r="2" fill="#fff"/>',
  militia: '<path d="M12 21V8M8 3v5c0 2 8 2 8 0V3M12 3v5" stroke="#fff" stroke-width="2" fill="none"/>',
  transport: '<path d="M3 14h18l-3 5H6z" fill="#fff"/><rect x="7" y="8" width="10" height="5" fill="#fff"/>',
  fastboat: '<path d="M3 15h18l-4 4H6z" fill="#fff"/><path d="M12 14V5l5 7z" fill="#fff"/>',
  bireme: '<path d="M3 13h18l-3 4H6z" fill="#fff"/><path d="M8 17l-2 4M12 17v4M16 17l2 4" stroke="#fff" stroke-width="1.6"/>',
  lightship: '<path d="M2 14h17l3-2-4 6H5z" fill="#fff"/><path d="M11 13V3l6 8z" fill="#fff"/>',
  fireship: '<path d="M3 16h18l-3 4H6z" fill="#fff"/><path d="M12 3c3 4 4 6 2 10h-4c-2-3 0-5 2-10z" fill="#ffd27a"/>',
  trireme: '<path d="M2 12h20l-3 4H5z" fill="#fff"/><path d="M6 16l-2 5M10 16l-1 5M14 16l1 5M18 16l2 5" stroke="#fff" stroke-width="1.4"/><path d="M12 11V3l5 7z" fill="#fff"/>',
  colony: '<path d="M3 15h18l-3 4H6z" fill="#fff"/><path d="M11 14V3" stroke="#fff" stroke-width="2"/><path d="M11 3h7l-2 3 2 3h-7z" fill="#fff"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" fill="#fff"/>',
};
const CAT_BG: Record<UnitCat, string> = { land: '#7a5230', naval: '#2d6a9f', myth: '#7b4bb0', hero: '#b8892a' };

// Command type icons.
const T: Record<string, [string, string]> = {
  attack: ['#b3261e', '<path d="M5 5l9 9M19 5l-9 9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M4 16l4 4M16 20l4-4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'],
  support: ['#2a6fb5', G.shield.replace('#7a5230', '#2a6fb5')],
  revolt: ['#d06a16', '<path d="M12 3c4 5 6 8 4 13-1 3-7 3-8 0-2-4 1-6 2-9 1 2 2 3 2 5 1-2 1-5 0-9z" fill="#fff"/>'],
  conquest: ['#6b2fa0', '<path d="M6 21V4" stroke="#fff" stroke-width="2"/><path d="M6 4h12l-3 4 3 4H6z" fill="#fff"/>'],
  return: ['#6b6f76', '<path d="M19 12H6M10 7l-5 5 5 5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>'],
  spy: ['#3a3f47', '<path d="M2 12c4-6 16-6 20 0-4 6-16 6-20 0z" fill="#fff"/><circle cx="12" cy="12" r="3" fill="#3a3f47"/>'],
  other: ['#6b6f76', '<circle cx="12" cy="12" r="4" fill="#fff"/>'],
};
export type CmdKind = keyof typeof T;
export function cmdKind(type: string, sub: string, ret: boolean): CmdKind {
  const t = `${type} ${sub}`.toLowerCase();
  if (ret || t.includes('return') || t.includes('abort')) return 'return';
  if (t.includes('takeover') || t.includes('conquer') || t.includes('colon')) return 'conquest';
  if (t.includes('revolt')) return 'revolt';
  if (t.includes('support')) return 'support';
  if (t.includes('espionage') || t.includes('spy')) return 'spy';
  if (t.includes('attack') || t.includes('breach') || t.includes('siege')) return 'attack';
  return 'other';
}

let injected = false;
/** Inject the sprite once (~6 KB of SVG text); icons are then cheap <use> references. */
export function injectSprite(doc: Document = document) {
  if (injected) return;
  injected = true;
  const sym: string[] = [];
  for (const [k, g] of Object.entries(G)) sym.push(`<symbol id="g-${k}" viewBox="0 0 24 24">${g}</symbol>`);
  for (const [k, [bg, g]] of Object.entries(T)) sym.push(`<symbol id="t-${k}" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="${bg}"/>${g}</symbol>`);
  sym.push('<symbol id="i-player" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c0-5 4-7 8-7s8 2 8 7z" fill="currentColor"/></symbol>');
  const div = doc.createElement('div');
  div.style.display = 'none';
  div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${sym.join('')}</svg>`;
  doc.body.appendChild(div);
}

// ---------------------------------------------------------------- official Grepolis icons (runtime only)
/**
 * Cell [column, row] of each unit in the official 9×9 sprite of 40 px icons (unit_icons_40x40_<GP_UNITS_VERSION>.png on
 * InnoGames' CDN), served by the bot at /gpcdn/units.jpg. Found by matching every cell against named copies, so these
 * belong to that exact sprite version. Units not listed (or a failed load) use the own SVG icon above.
 */
export const GP_UNITS_VERSION = '66aaef2';
export const GP_POS: Record<string, [number, number]> = {
  achilles: [0, 0], agamemnon: [1, 0], andromeda: [2, 0], aristotle: [3, 0], centaur: [4, 0], demolition_ship: [5, 0], hercules: [6, 0], odysseus: [7, 0], sword: [8, 0],
  ajax: [0, 1], alexandrios: [1, 1], anysia: [2, 1], atalanta: [3, 1], cerberus: [4, 1], deryntes: [5, 1], hoplite: [6, 1], orpheus: [7, 1], telemachos: [8, 1],
  apheledes: [0, 2], archer: [1, 2], argus: [2, 2], attack_ship: [3, 2], chariot: [4, 2], ephialtes: [5, 2], iason: [6, 2], pariphaistes: [7, 2], terylea: [8, 2],
  big_transporter: [0, 3], bireme: [1, 3], calydonian_boar: [2, 3], catapult: [3, 3], cheiron: [4, 3], eurybia: [5, 3], ladon: [6, 3], pegasus: [7, 3], themistokles: [8, 3],
  christopholus: [0, 4], colonize_ship: [1, 4], daidalos: [2, 4], deimos: [3, 4], democritus: [4, 4], ferkyon: [5, 4], leonidas: [6, 4], pelops: [7, 4], theseus: [8, 4],
  fury: [0, 5], godsent: [1, 5], griffin: [2, 5], harpy: [3, 5], hector: [4, 5], helen: [5, 5], lysippe: [6, 5], perseus: [7, 5], trireme: [8, 5],
  manticore: [0, 6], medea: [1, 6], medusa: [2, 6], melousa: [3, 6], mihalis: [4, 6], militia: [5, 6], minotaur: [6, 6], philoctetes: [7, 6], unknown: [8, 6],
  rekonos: [0, 7], rider: [1, 7], satyr: [2, 7], sea_monster: [3, 7], siren: [4, 7], slinger: [5, 7], small_transporter: [6, 7], spartoi: [7, 7], unknown_hero: [8, 7],
  unknown_naval: [0, 8], urephon: [1, 8], vedouma: [2, 8], xanthos: [3, 8], ylestres: [4, 8], zuretha: [5, 8], zyklop: [6, 8],
};
/** Order of the command-type strip at /gpcdn/cmds.png (src/web/gpcdn.ts GP_CMD_FILES). */
export const GP_CMD_ORDER: CmdKind[] = ['attack', 'support', 'revolt', 'conquest', 'return', 'spy'];
/** Which official sprites loaded in this browser (set by loadOfficialIcons; false = own SVGs). */
export const gp = { units: false, cmds: false };
const UNITS_URL = `/gpcdn/units.jpg?v=${GP_UNITS_VERSION}`, CMDS_URL = `/gpcdn/cmds.png?v=${GP_UNITS_VERSION}`;
/** Probe both sprites once (lazy, cached by the browser); resolves true if anything changed. Never throws. */
export function loadOfficialIcons(timeoutMs = 8000): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(false);
  const probe = (src: string) => new Promise<boolean>((res) => {
    const im = new Image(); const t = setTimeout(() => res(false), timeoutMs);
    im.onload = () => { clearTimeout(t); res(im.naturalWidth > 0); }; im.onerror = () => { clearTimeout(t); res(false); };
    im.src = src;
  });
  return Promise.all([probe(UNITS_URL), probe(CMDS_URL)]).then(([u, c]) => { gp.units = u; gp.cmds = c; return u || c; });
}
/** Official icon id for a unit id (a few aliases), or null. */
export function gpUnit(id: string): [number, number] | null {
  const k = id.toLowerCase();
  return GP_POS[k] ?? GP_POS[({ cyclops: 'zyklop', hydra: 'sea_monster', erinys: 'fury', fire_ship: 'demolition_ship', light_ship: 'attack_ship' } as Record<string, string>)[k] ?? ''] ?? null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function unitIcon(id: string, title: string, size = 20): string {
  const pos = gp.units ? gpUnit(id) : null;
  if (pos) return `<span class="gpu" role="img" aria-label="${esc(title)}" title="${esc(title)}" style="width:${size}px;height:${size}px;background:url(${UNITS_URL}) ${-pos[0] * size}px ${-pos[1] * size}px/${9 * size}px ${9 * size}px no-repeat"></span>`;
  const d = unitDef(id);
  const inner = d.glyph ? `<use href="#g-${d.glyph}"/>` : `<text x="12" y="16.5" text-anchor="middle" font-size="${d.code.length > 2 ? 9 : 11}" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">${esc(d.code)}</text>`;
  return `<svg class="ui u-${d.cat}" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><rect width="24" height="24" rx="4" fill="${CAT_BG[d.cat]}"/>${inner}</svg>`;
}
export function typeIcon(kind: CmdKind, title: string, size = 30): string {
  const i = gp.cmds ? GP_CMD_ORDER.indexOf(kind) : -1;
  if (i >= 0) return `<span class="gpt" role="img" aria-label="${esc(title)}" title="${esc(title)}" style="width:${size}px;height:${size}px;background:url(${CMDS_URL}) ${-i * size}px 0/${GP_CMD_ORDER.length * size}px ${size}px no-repeat"></span>`;
  return `<svg class="ti" width="${size}" height="${size}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><use href="#t-${kind}"/></svg>`;
}
export const playerIcon = '<svg class="pi" width="12" height="12" aria-hidden="true"><use href="#i-player"/></svg>';
