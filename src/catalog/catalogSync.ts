import { apiFetch } from '../api/client'

export type CatalogSyncResponse = {
  catalogRevision: number
  catalogPushedAt: string | null
}

export async function fetchCatalogRevision(): Promise<number | null> {
  try {
    const sync = await apiFetch<CatalogSyncResponse>('/settings/catalog-sync')
    return typeof sync.catalogRevision === 'number' ? sync.catalogRevision : 0
  } catch {
    return null
  }
}
