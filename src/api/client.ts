import type { AuthResponse } from '../auth/types'

const base = () => import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

export type ApiErrorBody = { message?: string; error?: string }

let getAccessToken: () => string | null = () => null
let runRefresh: () => Promise<boolean> = async () => false

/** Called from AuthProvider so apiFetch can attach tokens and refresh on 401. */
export function configureApiAuth(handlers: {
  getAccessToken: () => string | null
  runRefresh: () => Promise<boolean>
}) {
  getAccessToken = handlers.getAccessToken
  runRefresh = handlers.runRefresh
}

function isPublicAuthPath(path: string) {
  return (
    path.startsWith('/auth/login') ||
    path.startsWith('/auth/login-badge') ||
    path.startsWith('/auth/register') ||
    path.startsWith('/auth/refresh')
  )
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { _retry?: boolean } = {},
): Promise<T> {
  const url = `${base()}${path.startsWith('/') ? path : `/${path}`}`
  if (!base()) {
    throw new Error('Set VITE_API_BASE_URL (e.g. http://localhost:4000/api)')
  }

  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  const token = isPublicAuthPath(path) ? null : getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(url, { ...init, headers })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  if (res.status === 401 && !init._retry && !isPublicAuthPath(path)) {
    const refreshed = await runRefresh()
    if (refreshed) {
      return apiFetch<T>(path, { ...init, _retry: true })
    }
  }

  if (!res.ok) {
    const err = data as ApiErrorBody | null
    throw new Error(err?.message ?? err?.error ?? res.statusText)
  }
  return data as T
}

export async function registerRequest(email: string, password: string) {
  return apiFetch<{ id: string; email: string; role: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function loginRequest(email: string, password: string) {
  return apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function loginBadgeRequest(badgeCode: string) {
  return apiFetch<AuthResponse>('/auth/login-badge', {
    method: 'POST',
    body: JSON.stringify({ badgeCode }),
  })
}

export async function refreshRequest(refreshToken: string) {
  return apiFetch<AuthResponse>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  })
}

export async function logoutRequest() {
  await apiFetch('/auth/logout', { method: 'POST' })
}
