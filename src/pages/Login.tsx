import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { fetchPosLoginConfig, registerRequest } from '../api/client'
import { setCachedStaffAttendanceSettings } from '../attendance/attendanceConfigCache'
import { clockInBeforeTillSignIn } from '../attendance/attendanceTillSignIn'
import { StaffClockPanel } from '../attendance/StaffClockPanel'
import { usePosTheme } from '../theme/PosThemeContext'
import { resolvePosLogoSrc } from '../theme/posLogo'
import { useAuth } from '../auth/AuthContext'
import { getOfflineLoginCacheStatus } from '../auth/offlineAuth'
import { useBadgeScanInputFocus } from '../auth/useBadgeScanInputFocus'
import {
  FaceLoginPanel,
  ScreenKeyboard,
  retainInputFocusOnKeyPointerDown,
  type ScreenKeyboardAction,
} from '../components'
import { useQuitAppConfirm } from '../components/useQuitAppConfirm'
import { IconCloseWindow } from '../icons/windowChrome'
import { buildCustomerDisplaySnapshot } from '../customerDisplay/buildSnapshot'
import { readCachedStoreName } from '../customerDisplay/configCache'
import { publishCustomerDisplay } from '../customerDisplay/publish'
import { getInitialCustomerDisplayConfig } from '../customerDisplay/useCustomerDisplaySync'

export function Login() {
  const { theme } = usePosTheme()
  const logoMark = resolvePosLogoSrc(theme, 'light')
  const { session, loading, login, loginWithBadge, loginWithFace } = useAuth()
  const navigate = useNavigate()
  const [posLoginMethod, setPosLoginMethod] = useState<'badge' | 'face'>('badge')
  const [staffAttendanceEnabled, setStaffAttendanceEnabled] = useState(true)
  const [clockPanelVisible, setClockPanelVisible] = useState(false)
  const [clockPanelDismissed, setClockPanelDismissed] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [mode, setMode] = useState<'badge' | 'login' | 'register' | 'face'>('badge')
  const [badgeCode, setBadgeCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offlineCacheStatus, setOfflineCacheStatus] = useState<{
    ready: boolean
    userCount: number
    fetchedAt?: string
    stale: boolean
  }>(() => getOfflineLoginCacheStatus())
  const [screenKeyboardOpen, setScreenKeyboardOpen] = useState(false)
  const [activeInput, setActiveInput] = useState<'badge' | 'email' | 'password'>('badge')
  const formRef = useRef<HTMLFormElement | null>(null)
  const badgeInputRef = useRef<HTMLInputElement>(null)
  const clockBadgeInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const faceUiPointerRef = useRef(false)
  const shouldRedirect = !loading && !!session
  const { requestQuit, quitConfirmModal } = useQuitAppConfirm()

  useEffect(() => {
    let cancelled = false
    void fetchPosLoginConfig()
      .then((cfg) => {
        if (cancelled) return
        const method = cfg.posLoginMethod === 'face' ? 'face' : 'badge'
        setPosLoginMethod(method)
        setMode(method)
        setStaffAttendanceEnabled(cfg.staffAttendance?.enabled !== false)
        setCachedStaffAttendanceSettings(cfg.staffAttendance)
        setConfigLoaded(true)
      })
      .catch(() => {
        if (!cancelled) {
          setPosLoginMethod('badge')
          setMode('badge')
          setConfigLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (loading || session) return
    const storeConfig = getInitialCustomerDisplayConfig()
    publishCustomerDisplay(
      buildCustomerDisplaySnapshot({
        session: null,
        storeConfig,
        storeName: readCachedStoreName(),
        cart: [],
        cartTotal: 0,
        productsById: new Map(),
        showChangeView: false,
        lastTotal: null,
        lastChangeDue: null,
        lastCardAmount: null,
        lastTendered: null,
        pendingSplit: false,
        refundSession: false,
        jobCardLabourActive: false,
      }),
    )
  }, [loading, session])

  async function handleBadgeLogin(code: string) {
    const trimmed = code.trim()
    if (!trimmed || busy) return
    setError(null)
    setNotice(null)
    setBusy(true)
    setBadgeCode('')
    try {
      await clockInBeforeTillSignIn({ staffAttendanceEnabled, badgeCode: trimmed })
      await loginWithBadge(trimmed)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Badge login failed')
    } finally {
      setBusy(false)
      window.setTimeout(() => badgeInputRef.current?.focus(), 0)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      if (mode === 'register') {
        await registerRequest(email.trim(), password)
        setMode('login')
        setNotice('Account created. Sign in with the same email and password.')
      } else if (mode === 'badge') {
        const code = badgeCode.trim()
        setBadgeCode('')
        await clockInBeforeTillSignIn({ staffAttendanceEnabled, badgeCode: code })
        await loginWithBadge(code)
        navigate('/', { replace: true })
      } else {
        await login(email.trim(), password)
        navigate('/', { replace: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      if (mode === 'badge') {
        setBadgeCode('')
        window.setTimeout(() => badgeInputRef.current?.focus(), 0)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleClockedIn = useCallback(
    async (opts: { badgeCode?: string; embedding?: number[] }) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        if (opts.embedding?.length) await loginWithFace(opts.embedding)
        else if (opts.badgeCode) await loginWithBadge(opts.badgeCode)
        else throw new Error('Missing sign-in credentials')
        navigate('/', { replace: true })
      } finally {
        setBusy(false)
      }
    },
    [loginWithBadge, loginWithFace, navigate],
  )

  const tillBadgeFocusActive =
    configLoaded &&
    !loading &&
    !session &&
    !clockPanelVisible &&
    (mode === 'badge' || mode === 'face') &&
    !busy &&
    !screenKeyboardOpen

  useBadgeScanInputFocus(badgeInputRef, tillBadgeFocusActive, {
    pauseRefocus: () => faceUiPointerRef.current,
  })

  function applyKeyboardAction(value: string, action: ScreenKeyboardAction): string {
    if (action.type === 'char') return value + action.char
    if (action.type === 'space') return value + ' '
    if (action.type === 'backspace') return value.slice(0, -1)
    return value
  }

  function focusActiveInput(next: 'badge' | 'email' | 'password') {
    if (next === 'badge') badgeInputRef.current?.focus()
    if (next === 'email') emailInputRef.current?.focus()
    if (next === 'password') passwordInputRef.current?.focus()
  }

  function scrollActiveInputIntoView(next: 'badge' | 'email' | 'password') {
    const target = next === 'badge' ? badgeInputRef.current : next === 'email' ? emailInputRef.current : passwordInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  useEffect(() => {
    if (!screenKeyboardOpen) return
    const t = window.setTimeout(() => scrollActiveInputIntoView(activeInput), 40)
    return () => window.clearTimeout(t)
  }, [screenKeyboardOpen, activeInput])

  useEffect(() => {
    const refresh = () => setOfflineCacheStatus(getOfflineLoginCacheStatus())
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [])

  function appendActiveInput(extra: string) {
    if (!extra) return
    if (activeInput === 'badge') setBadgeCode((v) => v + extra)
    if (activeInput === 'email') setEmail((v) => v + extra)
    if (activeInput === 'password') setPassword((v) => v + extra)
  }

  function handleLoginKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'enter') {
      formRef.current?.requestSubmit()
      return
    }
    if (action.type === 'done') {
      setScreenKeyboardOpen(false)
      return
    }
    if (activeInput === 'badge') {
      setBadgeCode((v) => applyKeyboardAction(v, action))
      return
    }
    if (activeInput === 'email') {
      setEmail((v) => applyKeyboardAction(v, action))
      return
    }
    setPassword((v) => applyKeyboardAction(v, action))
  }

  if (shouldRedirect) {
    return <Navigate to="/" replace />
  }

  const showPosElectronChrome = Boolean(window.electronApp && (mode === 'badge' || mode === 'face'))

  async function handleFaceLogin(embedding: number[]) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await clockInBeforeTillSignIn({ staffAttendanceEnabled, embedding })
      await loginWithFace(embedding)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Face login failed')
    } finally {
      setBusy(false)
    }
  }

  if (!configLoaded && !loading) {
    return (
      <div className="screen auth-screen">
        <div className="panel">
          <p className="muted">Loading login…</p>
        </div>
      </div>
    )
  }

  return (
    <>
    <div className={`screen auth-screen${mode === 'face' ? ' auth-screen--face' : ''}${staffAttendanceEnabled && !clockPanelDismissed ? ' auth-screen--with-clock' : ''}`}>
      {showPosElectronChrome ? (
        <div className="auth-window-actions" role="toolbar" aria-label="Window">
          <button
            type="button"
            className="btn ghost window-chrome-action"
            aria-label="Exit application"
            title="Exit app"
            onClick={requestQuit}
          >
            <IconCloseWindow className="window-chrome-action-icon" />
          </button>
        </div>
      ) : null}
      <div className="auth-screen-layout auth-screen-layout--portrait">
      <StaffClockPanel
        enabled={staffAttendanceEnabled && !clockPanelDismissed}
        badgeInputRef={clockBadgeInputRef}
        busy={busy}
        onClockedIn={handleClockedIn}
        onVisibilityChange={setClockPanelVisible}
      />
      <div className={`panel auth-panel-main${mode === 'face' ? ' auth-panel--face' : ''}`}>
        {mode === 'face' ? (
          <>
            <div className="auth-brand-logo-wrap">
              <img src={logoMark} alt="CogniPOS" className="auth-brand-logo" decoding="async" />
            </div>
            <h1>Face sign-in</h1>
            <p className="muted">
              Cash register · CogniPOS
              <br />
              Scan your badge anytime — or look at the camera.
            </p>
            <p className="muted auth-offline-hint-compact">
              Offline cache:{' '}
              {offlineCacheStatus.ready
                ? `ready (${offlineCacheStatus.userCount} user${offlineCacheStatus.userCount === 1 ? '' : 's'})`
                : 'not ready'}
              {offlineCacheStatus.stale ? ' · stale' : ''}
            </p>
            <input
              ref={badgeInputRef}
              type="text"
              className="auth-badge-scan-input"
              autoComplete="off"
              aria-label="Scan staff badge to sign in"
              value={badgeCode}
              disabled={busy}
              onChange={(e) => setBadgeCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleBadgeLogin(e.currentTarget.value)
                }
              }}
            />
            {error ? <p className="error">{error}</p> : null}
            <div
              className="auth-face-panel-wrap"
              onPointerDown={() => {
                faceUiPointerRef.current = true
                window.setTimeout(() => {
                  faceUiPointerRef.current = false
                }, 400)
              }}
            >
              <FaceLoginPanel
                busy={busy}
                onLogin={handleFaceLogin}
                onUseBadge={() => {
                  faceUiPointerRef.current = false
                  setClockPanelDismissed(true)
                  setMode('badge')
                  setError(null)
                  setNotice(null)
                  window.setTimeout(() => badgeInputRef.current?.focus(), 0)
                }}
              />
            </div>
          </>
        ) : (
          <>
        <div className="auth-brand-logo-wrap">
          <img src={logoMark} alt="CogniPOS" className="auth-brand-logo" decoding="async" />
        </div>
        <h1>
          {mode === 'register'
            ? 'Create account'
            : mode === 'badge'
              ? clockPanelVisible
                ? 'Till sign-in'
                : 'Scan staff badge'
              : 'Sign in'}
        </h1>
        <p className="muted">
          Cash register · CogniPOS
          {mode === 'register' && (
            <>
              <br />
              First user becomes <strong>admin</strong> (catalog + users). Later signups are cashiers.
            </>
          )}
          {mode === 'badge' && (
            <>
              <br />
              {clockPanelVisible
                ? 'Already clocked in? Scan badge here to open the till.'
                : 'Scan QR badge to unlock this register for your shift.'}
            </>
          )}
        </p>
        <p className="muted" style={{ marginTop: '-0.25rem' }}>
          Offline login cache:{' '}
          {offlineCacheStatus.ready
            ? `ready (${offlineCacheStatus.userCount} allowed user${offlineCacheStatus.userCount === 1 ? '' : 's'})`
            : 'not ready'}
          {offlineCacheStatus.fetchedAt ? ` · last sync ${new Date(offlineCacheStatus.fetchedAt).toLocaleString()}` : ''}
          {offlineCacheStatus.stale ? ' · stale (>24h)' : ''}
        </p>
        <form ref={formRef} onSubmit={(e) => void onSubmit(e)} className="form">
          {mode === 'badge' ? (
            <label>
              QR badge code
              <input
                ref={badgeInputRef}
                type="text"
                autoComplete="off"
                autoFocus={!clockPanelVisible}
                placeholder="Scan badge or type code"
                value={badgeCode}
                onChange={(e) => setBadgeCode(e.target.value)}
                onFocus={() => {
                  setActiveInput('badge')
                  if (screenKeyboardOpen) window.setTimeout(() => scrollActiveInputIntoView('badge'), 20)
                }}
                required
              />
            </label>
          ) : (
            <>
              <label>
                Email
                <input
                  ref={emailInputRef}
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => {
                    setActiveInput('email')
                    if (screenKeyboardOpen) window.setTimeout(() => scrollActiveInputIntoView('email'), 20)
                  }}
                  required
                />
              </label>
              <label>
                Password
                <input
                  ref={passwordInputRef}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => {
                    setActiveInput('password')
                    if (screenKeyboardOpen) window.setTimeout(() => scrollActiveInputIntoView('password'), 20)
                  }}
                  required
                />
              </label>
            </>
          )}
          <div className="login-kb-toolbar">
            <button
              type="button"
              className="btn ghost btn small"
              onClick={() => {
                setScreenKeyboardOpen((v) => !v)
                focusActiveInput(activeInput)
              }}
            >
              {screenKeyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
            </button>
            {screenKeyboardOpen && mode !== 'badge' ? (
              <div className="login-kb-shortcuts">
                <button
                  type="button"
                  className="btn ghost btn small"
                  onPointerDown={retainInputFocusOnKeyPointerDown}
                  onClick={() => appendActiveInput('@')}
                >
                  @
                </button>
                <button
                  type="button"
                  className="btn ghost btn small"
                  onPointerDown={retainInputFocusOnKeyPointerDown}
                  onClick={() => appendActiveInput('.')}
                >
                  .
                </button>
                <button
                  type="button"
                  className="btn ghost btn small"
                  onPointerDown={retainInputFocusOnKeyPointerDown}
                  onClick={() => appendActiveInput('_')}
                >
                  _
                </button>
              </div>
            ) : null}
          </div>
          <ScreenKeyboard visible={screenKeyboardOpen} onAction={handleLoginKeyboardAction} className="open-tabs-screen-keyboard" />
          {notice && <p className="success">{notice}</p>}
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy
              ? mode === 'register'
                ? 'Creating…'
                : mode === 'badge'
                  ? 'Unlocking…'
                : 'Signing in…'
              : mode === 'register'
                ? 'Create account'
                : mode === 'badge'
                  ? 'Unlock register'
                  : 'Sign in'}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              if (mode === 'badge') {
                if (posLoginMethod === 'face') {
                  setClockPanelDismissed(false)
                  setMode('face')
                } else {
                  setMode('login')
                }
                setActiveInput(posLoginMethod === 'face' ? 'badge' : 'email')
              } else if (mode === 'login') {
                setMode('register')
              } else if (mode === 'register') {
                setClockPanelDismissed(false)
                setMode(posLoginMethod === 'face' ? 'face' : 'badge')
                setActiveInput('badge')
              }
              setError(null)
              setNotice(null)
            }}
          >
            {mode === 'badge'
              ? posLoginMethod === 'face'
                ? 'Use face sign-in'
                : 'Use email/password'
              : mode === 'login'
                ? 'Create first account…'
                : posLoginMethod === 'face'
                  ? 'Back to face sign-in'
                  : 'Back to badge scan'}
          </button>
          {window.electronApp && (mode === 'login' || mode === 'register') ? (
            <button
              type="button"
              className="btn ghost auth-app-quit"
              aria-label="Exit app"
              title="Exit app"
              onClick={requestQuit}
            >
              <IconCloseWindow className="auth-window-icon" />
            </button>
          ) : null}
        </form>
          </>
        )}
      </div>
      </div>
    </div>
    {quitConfirmModal}
    </>
  )
}
