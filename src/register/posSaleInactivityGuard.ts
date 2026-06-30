/** Shared till state: block auto-logout while a sale is in progress (Register updates this). */

let cartLineCount = 0
let hasPendingSplit = false
let parkedSaleLineCount = 0
let layByModalOpen = false
const listeners = new Set<() => void>()

export function setPosSaleInactivityGuard(patch: {
  cartLineCount?: number
  hasPendingSplit?: boolean
  parkedSaleLineCount?: number
  layByModalOpen?: boolean
}) {
  let changed = false
  if (patch.cartLineCount !== undefined && patch.cartLineCount !== cartLineCount) {
    cartLineCount = patch.cartLineCount
    changed = true
  }
  if (patch.hasPendingSplit !== undefined && patch.hasPendingSplit !== hasPendingSplit) {
    hasPendingSplit = patch.hasPendingSplit
    changed = true
  }
  if (patch.parkedSaleLineCount !== undefined && patch.parkedSaleLineCount !== parkedSaleLineCount) {
    parkedSaleLineCount = patch.parkedSaleLineCount
    changed = true
  }
  if (patch.layByModalOpen !== undefined && patch.layByModalOpen !== layByModalOpen) {
    layByModalOpen = patch.layByModalOpen
    changed = true
  }
  if (changed) {
    for (const l of listeners) l()
  }
}

export function posSaleBlocksInactivityLogout(): boolean {
  return cartLineCount > 0 || hasPendingSplit || parkedSaleLineCount > 0 || layByModalOpen
}

export function subscribePosSaleInactivityGuard(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
