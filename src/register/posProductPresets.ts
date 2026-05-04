import type { Product } from '../api/types'

/** Maximum number of preset products (leaves) per till. */
export const PRESET_ENTRY_MAX = 200

/** @deprecated use PRESET_ENTRY_MAX */
export const PRESET_SLOT_COUNT = PRESET_ENTRY_MAX

const STORAGE_KEY = 'electropos-pos-product-presets'

/** Clears legacy local-only preset storage after a successful server migration. */
export function clearLegacyProductPresetsStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* quota / private mode */
  }
}

export type PresetEntry = {
  productId: string
  category: string
  subCategory: string
  /** Fallback if product is removed from catalog. */
  label: string
}

export type ProductPresetsState = {
  entries: PresetEntry[]
  categories: string[]
  subCategoriesByCategory: Record<string, string[]>
}

function emptyState(): ProductPresetsState {
  return {
    entries: [],
    categories: [],
    subCategoriesByCategory: {},
  }
}

function parseEntry(o: Record<string, unknown>): PresetEntry | null {
  const productId = typeof o.productId === 'string' ? o.productId : ''
  const category = typeof o.category === 'string' ? o.category : ''
  const subCategory = typeof o.subCategory === 'string' ? o.subCategory : ''
  const label = typeof o.label === 'string' ? o.label : ''
  if (productId && category && subCategory && label) {
    return { productId, category, subCategory, label }
  }
  return null
}

function normalizeEntriesArray(raw: unknown): PresetEntry[] {
  if (!Array.isArray(raw)) return []
  const out: PresetEntry[] = []
  for (const x of raw) {
    if (x == null || typeof x !== 'object') continue
    const e = parseEntry(x as Record<string, unknown>)
    if (e) out.push(e)
    if (out.length >= PRESET_ENTRY_MAX) break
  }
  return out
}

/** Migrate legacy fixed-slot array to compact entries list. */
function migrateSlotsToEntries(slots: unknown): PresetEntry[] {
  if (!Array.isArray(slots)) return []
  const out: PresetEntry[] = []
  for (const x of slots) {
    if (x == null || typeof x !== 'object') continue
    const e = parseEntry(x as Record<string, unknown>)
    if (e) out.push(e)
    if (out.length >= PRESET_ENTRY_MAX) break
  }
  return out
}

function normalizeTaxonomy(
  categories: unknown,
  subMap: unknown,
): Pick<ProductPresetsState, 'categories' | 'subCategoriesByCategory'> {
  const cats =
    Array.isArray(categories) && categories.every((c) => typeof c === 'string')
      ? [...new Set(categories as string[])].filter(Boolean).sort()
      : []
  const subCategoriesByCategory: Record<string, string[]> = {}
  if (subMap && typeof subMap === 'object' && !Array.isArray(subMap)) {
    for (const [k, v] of Object.entries(subMap as Record<string, unknown>)) {
      if (!k || !Array.isArray(v)) continue
      const subs = [...new Set(v.filter((s): s is string => typeof s === 'string'))].filter(Boolean).sort()
      if (subs.length) subCategoriesByCategory[k] = subs
    }
  }
  return { categories: cats, subCategoriesByCategory }
}

export function readProductPresets(): ProductPresetsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const data = JSON.parse(raw) as Record<string, unknown>
    let entries: PresetEntry[]
    if (Array.isArray(data.entries)) {
      entries = normalizeEntriesArray(data.entries)
    } else if (data.slots != null) {
      entries = migrateSlotsToEntries(data.slots)
    } else {
      entries = []
    }
    const tax = normalizeTaxonomy(data.categories, data.subCategoriesByCategory)
    return { entries, ...tax }
  } catch {
    return emptyState()
  }
}

export function writeProductPresets(state: ProductPresetsState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        entries: state.entries,
        categories: state.categories,
        subCategoriesByCategory: state.subCategoriesByCategory,
      }),
    )
  } catch {
    /* quota / private mode */
  }
}

/** Short label stored as fallback (product name trimmed, ellipsis if long). */
export function autoPresetLabel(p: Product): string {
  const base = (p.name || '').trim() || p.sku.trim() || 'Item'
  const max = 26
  if (base.length <= max) return base
  return `${base.slice(0, max - 1)}…`
}

export function uniquePresetCategories(entries: PresetEntry[]): string[] {
  return [...new Set(entries.map((e) => e.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

export function uniquePresetSubCategories(entries: PresetEntry[], category: string): string[] {
  const c = category.trim()
  return [
    ...new Set(entries.filter((e) => e.category === c).map((e) => e.subCategory).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export type PresetEntryWithIndex = { entry: PresetEntry; index: number }

export function presetEntriesForPath(
  entries: PresetEntry[],
  category: string,
  subCategory: string,
): PresetEntryWithIndex[] {
  const c = category.trim()
  const s = subCategory.trim()
  const out: PresetEntryWithIndex[] = []
  entries.forEach((entry, index) => {
    if (entry.category === c && entry.subCategory === s) {
      out.push({ entry, index })
    }
  })
  return out
}

/**
 * Add a new preset, or replace an existing entry when already at {@link PRESET_ENTRY_MAX}.
 * When full, `replaceAtIndex` must be a valid index in `state.entries`.
 */
export function assignPresetEntry(
  state: ProductPresetsState,
  product: Product,
  category: string,
  subCategory: string,
  replaceAtIndex: number | null,
): ProductPresetsState {
  const cat = category.trim()
  const sub = subCategory.trim()
  if (!cat || !sub) return state
  const label = autoPresetLabel(product)
  const newEntry: PresetEntry = {
    productId: product._id,
    category: cat,
    subCategory: sub,
    label,
  }

  let nextEntries: PresetEntry[]
  if (state.entries.length < PRESET_ENTRY_MAX) {
    nextEntries = [...state.entries, newEntry]
  } else {
    if (
      replaceAtIndex == null ||
      replaceAtIndex < 0 ||
      replaceAtIndex >= state.entries.length
    ) {
      return state
    }
    nextEntries = [...state.entries]
    nextEntries[replaceAtIndex] = newEntry
  }

  const categories = new Set(state.categories)
  categories.add(cat)
  const subMap = { ...state.subCategoriesByCategory }
  const subs = new Set(subMap[cat] ?? [])
  subs.add(sub)
  subMap[cat] = [...subs].sort()

  return {
    entries: nextEntries,
    categories: [...categories].sort(),
    subCategoriesByCategory: subMap,
  }
}

export function removePresetAt(state: ProductPresetsState, entryIndex: number): ProductPresetsState {
  if (entryIndex < 0 || entryIndex >= state.entries.length) return state
  const nextEntries = state.entries.filter((_, i) => i !== entryIndex)
  return { ...state, entries: nextEntries }
}

/**
 * Ranked preset category names for datalist quick-pick (same behaviour as BackOffice → Products category field).
 * Dedupes case-insensitively; when `typed` is empty, shows the first `limit` names; otherwise prefix matches first,
 * then substring matches.
 */
/**
 * Sub-category pool for a preset category: catalog products with that `category`, plus preset map and entries.
 * Matches BackOffice Products sub-category datalist sources.
 */
export function mergePresetSubCategoryOptions(
  products: readonly Product[],
  presets: Pick<ProductPresetsState, 'entries' | 'subCategoriesByCategory'>,
  cat: string,
): string[] {
  const c = cat.trim()
  const fromProd = new Set<string>()
  for (const p of products) {
    if ((p.category?.trim() ?? '') !== c) continue
    const s = p.subCategory?.trim()
    if (s) fromProd.add(s)
  }
  const fromMap = presets.subCategoriesByCategory[c] ?? []
  const fromEntries = presets.entries.filter((e) => e.category === c).map((e) => e.subCategory)
  return [...new Set([...fromProd, ...fromMap, ...fromEntries].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Ranked sub-category names for datalist (same ranking rules as {@link quickPresetCategorySuggestions}).
 */
export function quickPresetSubCategorySuggestions(
  mergedSorted: readonly string[],
  typed: string,
  limit = 12,
): string[] {
  const q = typed.trim().toLowerCase()
  if (!q) return [...mergedSorted].slice(0, limit)

  const starts = mergedSorted.filter((name) => name.toLowerCase().startsWith(q))
  const contains = mergedSorted.filter(
    (name) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q),
  )
  return [...starts, ...contains].slice(0, limit)
}

export function quickPresetCategorySuggestions(
  categoryNames: readonly string[],
  typed: string,
  limit = 12,
): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const raw of categoryNames) {
    const name = raw.trim()
    if (!name) continue
    if (name.toLowerCase() === 'uncategorized') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(name)
  }

  const q = typed.trim().toLowerCase()
  if (!q) return merged.slice(0, limit)

  const starts = merged.filter((name) => name.toLowerCase().startsWith(q))
  const contains = merged.filter(
    (name) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q),
  )
  return [...starts, ...contains].slice(0, limit)
}
