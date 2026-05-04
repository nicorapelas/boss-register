export interface AuthUser {
  id: string
  email: string
  displayName?: string
  role: string
  permissions?: string[]
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
