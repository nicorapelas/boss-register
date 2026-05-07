import type { Product } from '../api/types'

export type CatalogCacheSnapshot = {
  products: Product[]
  syncedAt: string | null
}

export function isCatalogSnapshotStale(syncedAt: string | null, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!syncedAt) return false
  const ts = Date.parse(syncedAt)
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts > maxAgeMs
}

export async function saveCatalogCache(products: Product[]): Promise<void> {
  if (!window.electronOffline) return
  const resp = await window.electronOffline.setCatalog(products, new Date().toISOString())
  if (!resp.ok) throw new Error(resp.error ?? 'Failed to cache catalog')
}

export async function loadCatalogCache(): Promise<CatalogCacheSnapshot> {
  if (!window.electronOffline) return { products: [], syncedAt: null }
  const resp = await window.electronOffline.getCatalog()
  if (!resp.ok) return { products: [], syncedAt: null }
  return {
    products: Array.isArray(resp.products) ? (resp.products as Product[]) : [],
    syncedAt: resp.syncedAt,
  }
}
