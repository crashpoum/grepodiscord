/**
 * Official Grepolis divine-power ids → EN/GR labels for the Troops tab.
 * Unknown ids fall back to a sanitized optional `name`, then the id; never String(object).
 */
import { sanitizeName } from './ggCore.js';

export const HOSTILE_SPELLS: ReadonlySet<string> = new Set([
  'bolt', 'earthquake', 'sea_storm', 'pest', 'desire', 'transformation',
  'demoralizing_plague', 'demoralized_army', 'olympus_mortal_curse',
]);

const EN: Record<string, string> = {
  divine_sign: 'Divine Sign',
  bolt: 'Lightning Bolt',
  fair_wind: 'Favorable Wind',
  rage: "Zeus' Rage",
  transformation: 'Transformation',
  kingly_gift: 'Kingly Gift',
  call_of_the_ocean: 'Call of the Ocean',
  earthquake: 'Earthquake',
  sea_storm: 'Sea Storm',
  patroness: 'Patroness',
  wisdom: 'Wisdom',
  town_protection: 'City Protection',
  strength_of_heroes: 'Heroic Power',
  heroic_power: 'Heroic Power',
  wedding: 'Wedding',
  happiness: 'Happiness',
  fertility_improvement: 'Population Growth',
  desire: 'Desire',
  pest: 'Plague',
  resurrection: 'Return from the Underworld',
  underworld_treasures: 'Treasures of the Underworld',
  cap_of_invisibility: 'Helmet of Invisibility',
  natures_gift: "Nature's Gift",
  illusion: 'Illusion',
  cleanse: 'Purification',
  spartan_training: 'Spartan Training',
  bloodlust: 'Bloodlust',
  ares_sacrifice: "Ares' Sacrifice",
  chain_lightning: 'Chain Lightning',
  demoralizing_plague: 'Demoralizing Plague',
  sudden_aid: 'Sudden Support',
  demoralized_army: 'Demoralized Army',
  wedding_of_the_aristocrats: 'Marriage of the Aristocrats',
  summoning_of_the_nereids: 'Invocation of the Nereids',
  help_of_the_nereids: 'Help of the Nereids',
  olympus_mortal_curse: 'Olympus Mortal Curse',
};

const EL: Record<string, string> = {
  divine_sign: 'Θεϊκό σημάδι',
  bolt: 'Κεραυνός',
  fair_wind: 'Ούριος άνεμος',
  rage: 'Οργή του Δία',
  transformation: 'Μεταμόρφωση',
  kingly_gift: 'Βασιλικό δώρο',
  call_of_the_ocean: 'Κάλεσμα του ωκεανού',
  earthquake: 'Σεισμός',
  sea_storm: 'Θύελλα στη θάλασσα',
  patroness: 'Προστάτιδα',
  wisdom: 'Σοφία',
  town_protection: 'Προστασία πόλης',
  strength_of_heroes: 'Ηρωική δύναμη',
  heroic_power: 'Ηρωική δύναμη',
  wedding: 'Γάμος',
  happiness: 'Ευτυχία',
  fertility_improvement: 'Αύξηση πληθυσμού',
  desire: 'Πόθος',
  pest: 'Πανούκλα',
  resurrection: 'Επιστροφή από τον Άδη',
  underworld_treasures: 'Θησαυροί του Κάτω Κόσμου',
  cap_of_invisibility: 'Κράνος της αορατότητας',
  natures_gift: 'Δώρο της φύσης',
  illusion: 'Ψευδαίσθηση',
  cleanse: 'Εξαγνισμός',
  spartan_training: 'Σπαρτιατική εκπαίδευση',
  bloodlust: 'Δίψα για αίμα',
  ares_sacrifice: 'Θυσία του Άρη',
  chain_lightning: 'Αλυσιδωτός κεραυνός',
  demoralizing_plague: 'Αποθαρρυντική πανούκλα',
  sudden_aid: 'Αιφνίδια υποστήριξη',
  demoralized_army: 'Αποθαρρυμένος στρατός',
  wedding_of_the_aristocrats: 'Γάμος των αριστοκρατών',
  summoning_of_the_nereids: 'Επίκληση των Νηρηίδων',
  help_of_the_nereids: 'Βοήθεια των Νηρηίδων',
  olympus_mortal_curse: 'Κατάρα του Ολύμπου',
};

export const SPELL_NAMES = { en: EN, el: EL } as const;

/** Compact count: 15000 → "15k", 18600 → "18.6k", 3000 → "3k". */
export function fmtK(n: number): string {
  const x = Math.round(Number(n) || 0);
  if (x >= 1000) return (x / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(x);
}

/** `HH:MM:SS` remaining. */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return `${pad(h)}:${pad(m)}:${pad(x)}`;
}

export function spellLabel(id: string, name: unknown, lang: 'en' | 'el'): string {
  const mapped = (lang === 'el' ? EL : EN)[id];
  if (mapped) return mapped;
  if (typeof name === 'string') {
    const n = sanitizeName(name, 40);
    if (n && n !== '[object Object]') return n;
  }
  if (typeof id === 'string' && id) return id.replace(/_/g, ' ');
  return 'spell';
}
