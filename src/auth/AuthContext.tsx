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
  configureApiAuth,
  loginBadgeRequest,
  loginRequest,
  logoutRequest,
  refreshRequest,
} from '../api/client'
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
    const data = await loginRequest(email, password)
    const bundle: SessionBundle = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    }
    setSession(bundle)
    await persistSession(bundle)
  }, [])

  const loginWithBadge = useCallback(async (badgeCode: string) => {
    const data = await loginBadgeRequest(badgeCode)
    const bundle: SessionBundle = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    }
    setSession(bundle)
    await persistSession(bundle)
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
