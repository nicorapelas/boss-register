import { describe, expect, it } from 'vitest'
import type { Product } from '../api/types'
import { patchProductsStock } from './catalogStockPatch'

function product(id: string, stock: number): Product {
  return { _id: id, name: 'Item', sku: id, price: 1, stock }
}

describe('patchProductsStock', () => {
  it('deducts stock on sale without scanning unrelated products', () => {
    const catalog = [product('a', 10), product('b', 5)]
    const next = patchProductsStock(catalog, [{ productId: 'a', quantity: 2 }], 'sale')
    expect(next[0].stock).toBe(8)
    expect(next[1]).toBe(catalog[1])
  })

  it('adds stock on refund', () => {
    const catalog = [product('a', 3)]
    const next = patchProductsStock(catalog, [{ productId: 'a', quantity: 1 }], 'refund')
    expect(next[0].stock).toBe(4)
  })
})
