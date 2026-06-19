import type { AuthUser } from './types'

/** Store user with the `admin` role (full access; distinct from POS register.manager). */
export function isRoleAdmin(user: AuthUser | null | undefined): boolean {
  return user?.role === 'admin'
}

/** POS “manager” features (settings entry, lay-by overrides, etc.). */
export function isPosManager(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('register.manager')
}

export function canOverridePriceOnPos(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('register.price_override')
}

export function canRefundSales(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('sales.refund')
}

export function canExchangeSales(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('sales.exchange')
}

export function canManageShifts(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('shifts.manage')
}

function hasPermissionId(user: AuthUser | null | undefined, permission: string): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes(permission)
}

/** Back Office / manager sales history (also enables POS sale lookup without manager scan). */
export function canReadSalesHistory(user: AuthUser | null | undefined): boolean {
  return hasPermissionId(user, 'sales.read')
}

/** Admin or manager may browse recent sales when customer has no receipt / sale id. */
export function canBrowseSalesForAdjustment(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('register.manager') || p.includes('sales.read')
}
