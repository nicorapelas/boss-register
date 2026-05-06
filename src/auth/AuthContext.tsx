import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  apiFetch,
  configureApiAuth,
  loginBadgeRequest,
  loginRequest,
  logoutRequest,
  refreshRequest,
} from '../api/client'
import {
  cacheOfflineLoginPack,
  rememberBadgeLogin,
  rememberPasswordLogin,
  tryOfflineBadgeLogin,
  tryOfflinePasswordLogin,
} from './offlineAuth'
import { loadStoredSession, persistSession } from './session'
import type { SessionBundle } from './types'

type AuthContextValue = {
  session: SessionBundle | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  loginWithBadge: (badgeCode: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function isLikelyNetworkError(err: unknown): boolean {
  const text =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message ?? '')
        : String(err ?? '')
  const msg = text.toLowerCase()
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')
}

type OfflineLoginPackResponse = {
  users: Array<{
    user: SessionBundle['user']
    email: string
    badgeCode: string | null
    passwordHash: string
    updatedAt?: string
  }>
}

async function syncOfflineLoginPack(accessToken: string): Promise<void> {
  if (!accessToken) return
  try {
    const pack = await apiFetch<OfflineLoginPackResponse>('/auth/offline-login-pack', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
    cacheOfflineLoginPack(pack.users ?? [])
  } catch {
    // Non-blocking: auth flow must continue even if pack sync fails.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<SessionBundle | null>(null)
  sessionRef.current = session

  const runRefresh = useCallback(async () => {
    const s = sessionRef.current
    if (!s?.refreshToken) return false
    try {
      const data = await refreshRequest(s.refreshToken)
      const next: SessionBundle = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      }
      await syncOfflineLoginPack(next.accessToken)
      setSession(next)
      await persistSession(next)
      return true
    } catch {
      setSession(null)
      await persistSession(null)
      return false
    }
  }, [])

  useEffect(() => {
    configureApiAuth({
      getAccessToken: () => sessionRef.current?.accessToken ?? null,
      runRefresh,
    })
  }, [runRefresh])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await loadStoredSession()
      if (cancelled) return
      // Avoid race: if user logs in before storage bootstrap resolves,
      // never overwrite the fresh in-memory session with stale/null stored data.
      setSession((prev) => prev ?? stored)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    try {
      const data = await loginRequest(email, password)
      const bundle: SessionBundle = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      }
      await rememberPasswordLogin(email, password, data.user)
      await syncOfflineLoginPack(bundle.accessToken)
      setSession(bundle)
      await persistSession(bundle)
      return
    } catch (err) {
      if (!navigator.onLine || isLikelyNetworkError(err)) {
        const offlineBundle = await tryOfflinePasswordLogin(email, password)
        if (offlineBundle) {
          setSession(offlineBundle)
          await persistSession(offlineBundle)
          return
        }
        throw new Error('Offline login unavailable for these credentials. Login online once first.')
      }
      throw err
    }
  }, [])

  const loginWithBadge = useCallback(async (badgeCode: string) => {
    try {
      const data = await loginBadgeRequest(badgeCode)
      const bundle: SessionBundle = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      }
      await rememberBadgeLogin(badgeCode, data.user)
      await syncOfflineLoginPack(bundle.accessToken)
      setSession(bundle)
      await persistSession(bundle)
      return
    } catch (err) {
      if (!navigator.onLine || isLikelyNetworkError(err)) {
        const offlineBundle = await tryOfflineBadgeLogin(badgeCode)
        if (offlineBundle) {
          setSession(offlineBundle)
          await persistSession(offlineBundle)
          return
        }
        throw new Error('Offline badge login unavailable for this badge. Scan online once first.')
      }
      throw err
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutRequest()
    } catch {
      // clear locally even if server unreachable
    }
    setSession(null)
    await persistSession(null)
  }, [])

  const value = useMemo(
    () => ({ session, loading, login, loginWithBadge, logout }),
    [session, loading, login, loginWithBadge, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
