import type { Product } from '../api/types'
import { numericSkuKey } from '../utils/skuNormalize'

export type ProductLookup = {
  bySkuLower: Map<string, Product>
  byBarcodeLower: Map<string, Product>
  byNumericKey: Map<string, Product>
}

export function buildProductLookup(products: Product[]): ProductLookup {
  const bySkuLower = new Map<string, Product>()
  const byBarcodeLower = new Map<string, Product>()
  const byNumericKey = new Map<string, Product>()

  for (const p of products) {
    bySkuLower.set(p.sku.toLowerCase(), p)
    const skuNum = numericSkuKey(p.sku)
    if (!byNumericKey.has(skuNum)) byNumericKey.set(skuNum, p)

    const bc = p.barcode?.trim()
    if (!bc) continue
    byBarcodeLower.set(bc.toLowerCase(), p)
    const bcNum = numericSkuKey(bc)
    if (!byNumericKey.has(bcNum)) byNumericKey.set(bcNum, p)
  }

  return { bySkuLower, byBarcodeLower, byNumericKey }
}

export function findProductInLookup(lookup: ProductLookup, raw: string): Product | undefined {
  const q = raw.trim()
  if (!q) return undefined
  const qLower = q.toLowerCase()
  return (
    lookup.bySkuLower.get(qLower) ??
    lookup.byBarcodeLower.get(qLower) ??
    lookup.byNumericKey.get(numericSkuKey(q))
  )
}
