import type { CartLine } from '../api/types'

const STORAGE_KEY = 'electropos-sale-hold-v2'

export type SaleHoldSlots = {
  slots: [CartLine[], CartLine[]]
  activeSlot: 0 | 1
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function cloneCartLines(lines: CartLine[]): CartLine[] {
  return JSON.parse(JSON.stringify(lines)) as CartLine[]
}

function isCartLineArray(value: unknown): value is CartLine[] {
  return Array.isArray(value)
}

function isSaleHoldSlots(value: unknown): value is SaleHoldSlots {
  if (!value || typeof value !== 'object') return false
  const row = value as SaleHoldSlots
  return (
    Array.isArray(row.slots) &&
    row.slots.length === 2 &&
    isCartLineArray(row.slots[0]) &&
    isCartLineArray(row.slots[1]) &&
    (row.activeSlot === 0 || row.activeSlot === 1)
  )
}

export function emptySaleHoldSlots(): SaleHoldSlots {
  return { slots: [[], []], activeSlot: 0 }
}

export function otherSaleHoldSlot(active: 0 | 1): 0 | 1 {
  return active === 0 ? 1 : 0
}

export function loadSaleHoldSlots(): SaleHoldSlots {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptySaleHoldSlots()
    const parsed = JSON.parse(raw) as unknown
    if (!isSaleHoldSlots(parsed)) return emptySaleHoldSlots()
    return {
      activeSlot: parsed.activeSlot,
      slots: [cloneCartLines(parsed.slots[0]), cloneCartLines(parsed.slots[1])],
    }
  } catch {
    return emptySaleHoldSlots()
  }
}

export function persistSaleHoldSlots(state: SaleHoldSlots): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeSlot: state.activeSlot,
        slots: [cloneCartLines(state.slots[0]), cloneCartLines(state.slots[1])],
      }),
    )
  } catch {
    /* quota / private mode */
  }
}

export function parkedSlotLines(state: SaleHoldSlots): CartLine[] {
  return state.slots[otherSaleHoldSlot(state.activeSlot)]
}

export function heldSaleCartTotal(lines: CartLine[]): number {
  let total = 0
  for (const line of lines) {
    if (line.volumeSegments?.length) {
      total += line.volumeSegments.reduce((sum, seg) => sum + seg.lineTotal, 0)
    } else {
      total += line.quantity * line.unitPrice
    }
  }
  return roundMoney(total)
}

export function canSwitchSaleHold(state: SaleHoldSlots, currentCartLineCount: number): boolean {
  return currentCartLineCount > 0 || parkedSlotLines(state).length > 0
}

/** Save the on-screen cart to the active slot and load the other slot. */
export function swapSaleHoldSlots(
  state: SaleHoldSlots,
  currentCartLines: CartLine[],
): { next: SaleHoldSlots; loadedCart: CartLine[] } {
  const active = state.activeSlot
  const nextActive = otherSaleHoldSlot(active)
  const nextSlots: [CartLine[], CartLine[]] = [
    cloneCartLines(state.slots[0]),
    cloneCartLines(state.slots[1]),
  ]
  nextSlots[active] = cloneCartLines(currentCartLines)
  const loadedCart = cloneCartLines(nextSlots[nextActive])
  const next: SaleHoldSlots = { slots: nextSlots, activeSlot: nextActive }
  persistSaleHoldSlots(next)
  return { next, loadedCart }
}

/** Clear the active slot after checkout (parked slot unchanged). */
export function clearActiveSaleHoldSlot(state: SaleHoldSlots): SaleHoldSlots {
  const active = state.activeSlot
  const nextSlots: [CartLine[], CartLine[]] = [
    cloneCartLines(state.slots[0]),
    cloneCartLines(state.slots[1]),
  ]
  nextSlots[active] = []
  const next: SaleHoldSlots = { slots: nextSlots, activeSlot: active }
  persistSaleHoldSlots(next)
  return next
}
