import { describe, expect, it } from 'vitest'
import type { Product } from '../api/types'
import { buildProductLookup, findProductInLookup } from './productLookup'

function product(overrides: Partial<Product> & Pick<Product, '_id' | 'sku'>): Product {
  return {
    _id: overrides._id,
    name: overrides.name ?? 'Item',
    sku: overrides.sku,
    price: overrides.price ?? 1,
    stock: overrides.stock ?? 1,
    barcode: overrides.barcode,
    photoRevision: overrides.photoRevision,
    category: overrides.category,
  }
}

describe('productLookup', () => {
  it('finds by sku and leading-zero numeric key', () => {
    const lookup = buildProductLookup([
      product({ _id: '1', sku: '8632', barcode: '008632' }),
    ])
    expect(findProductInLookup(lookup, '8632')?.sku).toBe('8632')
    expect(findProductInLookup(lookup, '008632')?.sku).toBe('8632')
  })
})
