import type { Product } from '../api/types'

export type CatalogCacheSnapshot = {
  products: Product[]
  syncedAt: string | null
  catalogRevision: number | null
}

/** In-memory copy so CatalogProvider can hydrate on remount before async IPC returns. */
let warmSnapshot: CatalogCacheSnapshot | null = null

export function getWarmCatalogSnapshot(): CatalogCacheSnapshot | null {
  return warmSnapshot
}

export function isCatalogSnapshotStale(syncedAt: string | null, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!syncedAt) return false
  const ts = Date.parse(syncedAt)
  if (!Number.isFinite(ts)) return false
  return Date.now() - ts > maxAgeMs
}

export async function saveCatalogCache(
  products: Product[],
  catalogRevision?: number | null,
): Promise<void> {
  const syncedAt = new Date().toISOString()
  const rev =
    catalogRevision != null && Number.isFinite(catalogRevision) ? catalogRevision : null
  warmSnapshot = { products, syncedAt, catalogRevision: rev }
  if (!window.electronOffline) return
  const resp = await window.electronOffline.setCatalog(products, syncedAt, rev ?? undefined)
  if (!resp.ok) throw new Error(resp.error ?? 'Failed to cache catalog')
}

export async function loadCatalogCache(): Promise<CatalogCacheSnapshot> {
  if (warmSnapshot && warmSnapshot.products.length > 0) {
    return warmSnapshot
  }
  if (!window.electronOffline) {
    return { products: [], syncedAt: null, catalogRevision: null }
  }
  const resp = await window.electronOffline.getCatalog()
  if (!resp.ok) {
    return { products: [], syncedAt: null, catalogRevision: null }
  }
  const snapshot: CatalogCacheSnapshot = {
    products: Array.isArray(resp.products) ? (resp.products as Product[]) : [],
    syncedAt: resp.syncedAt,
    catalogRevision:
      typeof resp.catalogRevision === 'number' && Number.isFinite(resp.catalogRevision)
        ? resp.catalogRevision
        : null,
  }
  if (snapshot.products.length > 0) {
    warmSnapshot = snapshot
  }
  return snapshot
}
