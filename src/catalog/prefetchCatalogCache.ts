import { apiFetch } from '../api/client'
import type { Product } from '../api/types'
import { saveCatalogCache } from '../offline/catalogCache'

type CatalogSyncResponse = {
  catalogRevision: number
  catalogPushedAt: string | null
}

/** Best-effort full catalog download for the next login (call while session is still valid). */
export async function prefetchCatalogCache(): Promise<void> {
  try {
    const [list, sync] = await Promise.all([
      apiFetch<Product[]>('/products'),
      apiFetch<CatalogSyncResponse>('/settings/catalog-sync'),
    ])
    const rev = typeof sync.catalogRevision === 'number' ? sync.catalogRevision : 0
    await saveCatalogCache(list, rev)
  } catch {
    // Non-blocking: next login falls back to existing cache or online fetch.
  }
}
