import type { Product } from '../api/types'

/** Max line qty for non-inventory items (guards typos / abuse). */
export const PRODUCT_MAX_UNTRACKED_LINE_QTY = 9999

export function productTracksInventory(p: Pick<Product, 'trackInventory'>): boolean {
  return p.trackInventory !== false
}

/** Sellable units for cart / list (large cap when inventory is not tracked). */
export function productAvailableUnits(p: Product): number {
  if (!productTracksInventory(p)) return PRODUCT_MAX_UNTRACKED_LINE_QTY
  const a = p.availableQty
  if (a == null) return p.stock
  return a
}

export function productHasSellableStock(p: Product): boolean {
  return productAvailableUnits(p) >= 1
}

/** Short label for product list rows (price line). */
export function productAvailabilityCaption(p: Product): string {
  if (!productTracksInventory(p)) return 'No stock limit'
  return `${p.availableQty ?? p.stock} available`
}

/** Product availability with offline context marker for cashier awareness. */
export function productAvailabilityCaptionWithMode(p: Product, offlineCatalogMode: boolean): string {
  const base = productAvailabilityCaption(p)
  return offlineCatalogMode ? `${base} (cached/offline adjusted)` : base
}
