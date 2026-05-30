import type { AuthResponse } from '../auth/types'

const base = () => import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

export type ApiErrorBody = { message?: string; error?: string }
type ReachabilityListener = (reachable: boolean) => void

let getAccessToken: () => string | null = () => null
let runRefresh: () => Promise<boolean> = async () => false
const reachabilityListeners = new Set<ReachabilityListener>()
let serverReachable = true

export type ServerEvent =
  | { type: 'catalog.revision'; catalogRevision: number }
  | { type: 'unknown'; event: string; data: unknown }

function setServerReachable(next: boolean) {
  if (serverReachable === next) return
  serverReachable = next
  for (const listener of reachabilityListeners) listener(next)
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')
}

export function subscribeServerReachability(listener: ReachabilityListener): () => void {
  reachabilityListeners.add(listener)
  listener(serverReachable)
  return () => {
    reachabilityListeners.delete(listener)
  }
}

export function markServerReachable() {
  setServerReachable(true)
}

export function markServerUnreachable() {
  setServerReachable(false)
}

export function getServerHealthUrl(): string | null {
  const b = base()
  if (!b) return null
  try {
    const u = new URL(b)
    u.pathname = '/health'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

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
  headers.set('X-Client-App', 'pos')

  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (err) {
    if (isNetworkError(err)) setServerReachable(false)
    throw err
  }
  setServerReachable(true)
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

function apiBaseOrThrow(): string {
  const b = base()
  if (!b) throw new Error('Set VITE_API_BASE_URL (e.g. http://localhost:4000/api)')
  return b
}

function eventsUrlOrThrow(): string {
  const b = apiBaseOrThrow()
  return `${b}/events`
}

function parseSseLines(block: string): { event: string; data: unknown } | null {
  const lines = block.split('\n')
  let event = 'message'
  let dataText = ''
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataText += line.slice(5).trim()
  }
  if (!dataText) return null
  try {
    return { event, data: JSON.parse(dataText) as unknown }
  } catch {
    return { event, data: dataText }
  }
}

export function subscribeServerEvents(onEvent: (ev: ServerEvent) => void): () => void {
  const abort = new AbortController()

  const start = async () => {
    let retryMs = 500
    while (!abort.signal.aborted) {
      const token = getAccessToken()
      if (!token) {
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      try {
        const res = await fetch(eventsUrlOrThrow(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Client-App': 'pos',
          },
          signal: abort.signal,
        })

        if (res.status === 401) {
          const refreshed = await runRefresh()
          if (!refreshed) {
            await new Promise((r) => setTimeout(r, 2000))
          }
          continue
        }
        if (!res.ok || !res.body) throw new Error(`Events stream failed (${res.status})`)

        retryMs = 500
        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buf = ''
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          while (true) {
            const idx = buf.indexOf('\n\n')
            if (idx < 0) break
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const parsed = parseSseLines(block)
            if (!parsed) continue
            if (parsed.event === 'catalog.revision') {
              const rev =
                typeof (parsed.data as { catalogRevision?: unknown } | null)?.catalogRevision === 'number'
                  ? (parsed.data as { catalogRevision: number }).catalogRevision
                  : null
              if (rev != null) onEvent({ type: 'catalog.revision', catalogRevision: rev })
            } else {
              onEvent({ type: 'unknown', event: parsed.event, data: parsed.data })
            }
          }
        }
      } catch {
        // ignore; retry below
      }
      await new Promise((r) => setTimeout(r, retryMs))
      retryMs = Math.min(retryMs * 2, 15_000)
    }
  }

  void start()
  return () => abort.abort()
}

/** Caller must `URL.revokeObjectURL` when done. Used for authenticated product images. */
export async function fetchProductPhotoObjectUrl(productId: string, revision: number): Promise<string> {
  const u = `${apiBaseOrThrow()}/products/${encodeURIComponent(productId)}/photo?rev=${encodeURIComponent(String(revision))}`
  const tryGet = async (token: string | null) => {
    const headers = new Headers()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(u, { headers })
  }
  let res = await tryGet(getAccessToken())
  if (res.status === 401) {
    const refreshed = await runRefresh()
    if (refreshed) res = await tryGet(getAccessToken())
  }
  if (!res.ok) {
    const text = await res.text()
    let msg = res.statusText
    try {
      const j = text ? (JSON.parse(text) as ApiErrorBody) : null
      msg = j?.message ?? j?.error ?? msg
    } catch {
      // ignore
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
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
