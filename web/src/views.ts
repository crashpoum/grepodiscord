/**
 * Saved views for /live (GrepoData-style tabs): each view keeps its filters, grouping tab and unit filter.
 * Pure state helpers (unit-tested); persistence is a plain Storage (localStorage per user + world).
 */
export type Group = 'none' | 'target' | 'attacker' | 'ours';
export interface Sel { values: string[]; include: boolean }
export interface ViewFilters {
  text: string; towns: Sel; players: Sel; alliances: Sel; uploaders: Sel; target: number | null; units: string[];
  returns: boolean; support: boolean; outgoing: boolean; other: boolean;
}
export interface SavedView { id: string; name: string; f: ViewFilters; group: Group }
export interface ViewState { v: 1; active: string; views: SavedView[] }

export const DEFAULT_ID = 'default';
const sel = (): Sel => ({ values: [], include: true });
export const emptyFilters = (): ViewFilters => ({ text: '', towns: sel(), players: sel(), alliances: sel(), uploaders: sel(), target: null, units: [], returns: true, support: true, outgoing: true, other: true });
export const initialViews = (): ViewState => ({ v: 1, active: DEFAULT_ID, views: [{ id: DEFAULT_ID, name: '', f: emptyFilters(), group: 'none' }] });

const GROUPS: Group[] = ['none', 'target', 'attacker', 'ours'];
const MAX_VIEWS = 12, MAX_NAME = 24, MAX_VALUES = 200;
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').slice(0, MAX_VALUES) : []);
const cleanSel = (x: unknown): Sel => { const o = (x ?? {}) as Partial<Sel>; return { values: strs(o.values), include: o.include !== false }; };
const cleanFilters = (x: unknown): ViewFilters => {
  const o = (x ?? {}) as Partial<ViewFilters>; const e = emptyFilters();
  return {
    text: typeof o.text === 'string' ? o.text.slice(0, 100) : '', towns: cleanSel(o.towns), players: cleanSel(o.players), alliances: cleanSel(o.alliances), uploaders: cleanSel(o.uploaders),
    target: typeof o.target === 'number' && Number.isFinite(o.target) ? o.target : null, units: strs(o.units),
    returns: o.returns ?? e.returns, support: o.support ?? e.support, outgoing: o.outgoing ?? e.outgoing, other: o.other ?? e.other,
  };
};
/** Parse stored JSON defensively (old/garbled data → defaults; the Default view always exists and comes first). */
export function parseViews(raw: string | null | undefined): ViewState {
  let o: Partial<ViewState> | null = null;
  try { o = raw ? JSON.parse(raw) : null; } catch { o = null; }
  const st = initialViews();
  if (!o || !Array.isArray(o.views)) return st;
  const seen = new Set<string>();
  const views: SavedView[] = [];
  for (const v of o.views.slice(0, MAX_VIEWS)) {
    if (!v || typeof v.id !== 'string' || seen.has(v.id)) continue;
    seen.add(v.id);
    views.push({ id: v.id, name: v.id === DEFAULT_ID ? '' : String(v.name ?? '').slice(0, MAX_NAME), f: cleanFilters(v.f), group: GROUPS.includes(v.group) ? v.group : 'none' });
  }
  if (!seen.has(DEFAULT_ID)) views.unshift(st.views[0]); else views.sort((a, b) => (a.id === DEFAULT_ID ? -1 : b.id === DEFAULT_ID ? 1 : 0));
  return { v: 1, active: views.some((v) => v.id === o!.active) ? String(o.active) : DEFAULT_ID, views };
}
export const activeView = (s: ViewState) => s.views.find((v) => v.id === s.active) ?? s.views[0];
export function createView(s: ViewState, name: string, id = `v${Date.now().toString(36)}`): ViewState {
  if (s.views.length >= MAX_VIEWS) return s;
  const n = name.trim().slice(0, MAX_NAME) || `${s.views.length}`;
  return { ...s, active: id, views: [...s.views, { id, name: n, f: emptyFilters(), group: 'none' }] };
}
export function renameView(s: ViewState, id: string, name: string): ViewState {
  const n = name.trim().slice(0, MAX_NAME);
  if (id === DEFAULT_ID || !n) return s;
  return { ...s, views: s.views.map((v) => (v.id === id ? { ...v, name: n } : v)) };
}
export function closeView(s: ViewState, id: string): ViewState {
  if (id === DEFAULT_ID) return s;
  const i = s.views.findIndex((v) => v.id === id);
  if (i < 0) return s;
  const views = s.views.filter((v) => v.id !== id);
  return { ...s, views, active: s.active === id ? views[Math.max(0, i - 1)].id : s.active };
}
export function updateActive(s: ViewState, patch: Partial<Pick<SavedView, 'f' | 'group'>>): ViewState {
  return { ...s, views: s.views.map((v) => (v.id === s.active ? { ...v, ...patch } : v)) };
}
export const selectView = (s: ViewState, id: string): ViewState => (s.views.some((v) => v.id === id) ? { ...s, active: id } : s);
export const storageKey = (user: string | null, world: string | null) => `gc.liveViews.${user ?? 'anon'}.${world ?? 'any'}`;
export function loadViews(store: Pick<Storage, 'getItem'> | null, key: string): ViewState { try { return parseViews(store?.getItem(key)); } catch { return initialViews(); } }
export function saveViews(store: Pick<Storage, 'setItem'> | null, key: string, s: ViewState) { try { store?.setItem(key, JSON.stringify(s)); } catch { /* storage full/blocked (e.g. some Activity webviews): keep in memory */ } }
