import { apiFetch } from './client'
import type { ProductPresetsState } from './types'
import { clearLegacyProductPresetsStorage, readProductPresets } from '../register/posProductPresets'

export async function fetchProductPresets(): Promise<ProductPresetsState> {
  return apiFetch<ProductPresetsState>('/settings/product-presets')
}

export async function pushProductPresets(state: ProductPresetsState): Promise<ProductPresetsState> {
  return apiFetch<ProductPresetsState>('/settings/product-presets', {
    method: 'PUT',
    body: JSON.stringify(state),
  })
}

/**
 * Load presets from server. If the server has none but this device has legacy local data, upload once
 * and clear local storage.
 */
export async function loadProductPresetsWithMigration(): Promise<ProductPresetsState> {
  const server = await fetchProductPresets()
  if (server.entries.length > 0) return server
  const local = readProductPresets()
  if (local.entries.length === 0) return server
  const pushed = await pushProductPresets(local)
  clearLegacyProductPresetsStorage()
  return pushed
}
