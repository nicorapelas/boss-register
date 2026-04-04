export type UserRole = 'admin' | 'cashier'

export interface AuthUser {
  id: string
  email: string
  role: UserRole
}

export interface SessionBundle {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}
