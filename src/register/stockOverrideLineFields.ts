import type { CartLine } from '../api/types'
import type { StockOverrideApprover } from './managerStockOverrideVerify'

export function stockOverrideLineFields(
  scope: 'offline' | 'online',
  availableQty: number,
  approver?: StockOverrideApprover,
): Pick<
  CartLine,
  | 'stockOverrideApproved'
  | 'stockOverrideScope'
  | 'stockOverrideAvailableQty'
  | 'stockOverrideApprovedByUserId'
  | 'stockOverrideApprovedByDisplayName'
> {
  return {
    stockOverrideApproved: true,
    stockOverrideScope: scope,
    stockOverrideAvailableQty: Math.max(0, availableQty),
    ...(approver
      ? {
          stockOverrideApprovedByUserId: approver.userId,
          stockOverrideApprovedByDisplayName: approver.displayName,
        }
      : {}),
  }
}

export function stockOverridePayloadFromLine(l: CartLine) {
  if (l.stockOverrideApproved !== true) return {}
  return {
    stockOverrideApproved: true as const,
    ...(l.stockOverrideScope ? { stockOverrideScope: l.stockOverrideScope } : {}),
    ...(l.stockOverrideAvailableQty !== undefined
      ? { stockOverrideAvailableQty: l.stockOverrideAvailableQty }
      : {}),
    ...(l.stockOverrideApprovedByUserId
      ? { stockOverrideApprovedByUserId: l.stockOverrideApprovedByUserId }
      : {}),
    ...(l.stockOverrideApprovedByDisplayName
      ? { stockOverrideApprovedByDisplayName: l.stockOverrideApprovedByDisplayName }
      : {}),
  }
}
