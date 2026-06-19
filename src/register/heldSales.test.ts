import { describe, expect, it, beforeEach } from 'vitest'
import type { CartLine } from '../api/types'
import {
  canSwitchSaleHold,
  clearActiveSaleHoldSlot,
  emptySaleHoldSlots,
  loadSaleHoldSlots,
  persistSaleHoldSlots,
  swapSaleHoldSlots,
} from './heldSales'

const sampleLine: CartLine = {
  productId: 'p1',
  name: 'Test item',
  quantity: 2,
  unitPrice: 10,
}

describe('heldSales two-slot swap', () => {
  beforeEach(() => {
    localStorage.clear()
    persistSaleHoldSlots(emptySaleHoldSlots())
  })

  it('parks the active cart and opens an empty slot', () => {
    const state = emptySaleHoldSlots()
    const swapped = swapSaleHoldSlots(state, [sampleLine])
    expect(swapped.loadedCart).toHaveLength(0)
    expect(swapped.next.slots[0]).toHaveLength(1)
    expect(swapped.next.activeSlot).toBe(1)
    expect(loadSaleHoldSlots().slots[0]).toHaveLength(1)
  })

  it('switches back to the parked cart', () => {
    const first = swapSaleHoldSlots(emptySaleHoldSlots(), [sampleLine])
    const second = swapSaleHoldSlots(first.next, [{ ...sampleLine, productId: 'p2', quantity: 1 }])
    expect(second.loadedCart).toHaveLength(1)
    expect(second.loadedCart[0]?.productId).toBe('p1')
    expect(second.next.slots[1]).toHaveLength(1)
    expect(second.next.slots[1][0]?.productId).toBe('p2')
  })

  it('allows switch when only the parked slot has lines', () => {
    const parked = swapSaleHoldSlots(emptySaleHoldSlots(), [sampleLine]).next
    expect(canSwitchSaleHold(parked, 0)).toBe(true)
  })

  it('clears only the active slot after checkout', () => {
    const parked = swapSaleHoldSlots(emptySaleHoldSlots(), [sampleLine]).next
    const cleared = clearActiveSaleHoldSlot(parked)
    expect(cleared.slots[1]).toHaveLength(0)
    expect(cleared.slots[0]).toHaveLength(1)
  })
})
