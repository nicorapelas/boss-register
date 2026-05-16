import type { Product } from '../api/types'
import { productTracksInventory } from '../utils/productInventory'

export type CartStockLine = { productId: string; quantity: number }

function qtyByProductId(lines: CartStockLine[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const line of lines) {
    const qty = Math.max(0, Number(line.quantity) || 0)
    if (!qty) continue
    map.set(line.productId, (map.get(line.productId) ?? 0) + qty)
  }
  return map
}

/** Update in-memory catalog stock for sold/refunded lines without refetching the full catalog. */
export function patchProductsStock(
  products: Product[],
  lines: CartStockLine[],
  direction: 'sale' | 'refund',
): Product[] {
  const deltas = qtyByProductId(lines)
  if (deltas.size === 0) return products

  const sign = direction === 'sale' ? -1 : 1
  let changed = false
  const next = products.slice()

  for (let i = 0; i < next.length; i++) {
    const p = next[i]
    const qty = deltas.get(p._id)
    if (!qty || !productTracksInventory(p)) continue

    changed = true
    const nextStock = Math.max(0, Math.round((Number(p.stock ?? 0) + sign * qty) * 1000) / 1000)
    const nextAvailableRaw =
      p.availableQty == null
        ? null
        : Math.round((Number(p.availableQty ?? 0) + sign * qty) * 1000) / 1000
    const nextAvailable = nextAvailableRaw == null ? null : Math.max(0, nextAvailableRaw)

    next[i] = {
      ...p,
      stock: nextStock,
      availableQty: nextAvailable,
    }
  }

  return changed ? next : products
}
