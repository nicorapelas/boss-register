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

export function canManageShifts(user: AuthUser | null | undefined): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const p = user.permissions ?? []
  if (p.includes('*')) return true
  return p.includes('shifts.manage')
}
