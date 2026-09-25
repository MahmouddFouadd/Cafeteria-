import { sb } from './supabase.js';
import { q } from './api.js';
import { lang } from './i18n.js';

export const refs = {
  loaded: false, units: [], locations: [], materials: [], materialUnits: [],
  matCats: [], prodCats: [], suppliers: [],
};

export async function loadRefs(force = false) {
  if (refs.loaded && !force) return refs;
  const [units, locations, materials, materialUnits, matCats, prodCats, suppliers] = await Promise.all([
    q(sb.from('units').select('*').order('id')),
    q(sb.from('stock_locations').select('*').order('id')),
    q(sb.from('materials').select('*').order('name_ar')),
    q(sb.from('material_units').select('*')),
    q(sb.from('material_categories').select('*').order('id')),
    q(sb.from('product_categories').select('*').order('sort')),
    q(sb.from('suppliers').select('*').order('name')),
  ]);
  Object.assign(refs, { units, locations, materials, materialUnits, matCats, prodCats, suppliers, loaded: true });
  return refs;
}

/** Localised name of any row that has name_ar / name_en */
export const nm = (o) => (!o ? '' : (lang() === 'en' && o.name_en ? o.name_en : o.name_ar));

export const material = (id) => refs.materials.find((m) => m.id === id);
export const location = (id) => refs.locations.find((l) => l.id === id);
export const locationByCode = (code) => refs.locations.find((l) => l.code === code);
export const unit = (id) => refs.units.find((u) => u.id === id);
export const unitLabel = (id) => { const u = unit(id); return u ? (lang() === 'en' ? u.code : u.name_ar) : ''; };

/** Units usable for a material: base unit first, then its conversions */
export function unitsForMaterial(materialId) {
  const m = material(materialId);
  if (!m) return [];
  const list = [{ unit_id: m.base_unit_id, factor: 1, purchase: false }];
  refs.materialUnits
    .filter((x) => x.material_id === materialId)
    .forEach((x) => list.push({ unit_id: x.unit_id, factor: Number(x.factor_to_base), purchase: x.is_purchase_unit }));
  return list;
}
export const purchaseUnit = (materialId) => unitsForMaterial(materialId).find((u) => u.purchase) || null;
export const factorOf = (materialId, unitId) => unitsForMaterial(materialId).find((u) => u.unit_id === unitId)?.factor ?? null;

// ---------- App settings (app_settings table) ----------
export const settings = { loaded: false, map: {} };
export async function loadSettings(force = false) {
  if (settings.loaded && !force) return settings.map;
  const rows = await q(sb.from('app_settings').select('key,value'));
  settings.map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  settings.loaded = true;
  try { if (settings.map.idle_minutes) localStorage.setItem('cafeteria-idle-min', String(settings.map.idle_minutes)); } catch (_) {}
  return settings.map;
}
export const setting = (k, d) => (settings.map[k] !== undefined && settings.map[k] !== null ? settings.map[k] : d);
/** Preparation stage (new → preparing → ready → served). Off = order, then one "served" tap. */
export const usePrep = () => setting('use_preparation', false) === true;
export async function saveSetting(k, v) {
  await q(sb.from('app_settings').upsert({ key: k, value: v }).select('key'));
  settings.map[k] = v;
  if (k === 'idle_minutes') { try { localStorage.setItem('cafeteria-idle-min', String(v)); } catch (_) {} }
}
