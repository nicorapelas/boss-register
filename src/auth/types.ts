import type { CashierSignInMethod } from './signInMethod'

export interface AuthUser {
  id: string
  email: string
  displayName?: string
  role: string
  permissions?: string[]
  allowOfflineLogin?: boolean
}

export interface SessionBundle {
  accessToken: string
  refreshToken: string
  user: AuthUser
  /** Set when the cashier signs in; sent on each sale for receipt / audit. */
  signInMethod?: CashierSignInMethod
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}
