import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { registerRequest } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { ScreenKeyboard, retainInputFocusOnKeyPointerDown, type ScreenKeyboardAction } from '../components'

export function Login() {
  const { session, loading, login, loginWithBadge } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'badge' | 'login' | 'register'>('badge')
  const [badgeCode, setBadgeCode] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [screenKeyboardOpen, setScreenKeyboardOpen] = useState(false)
  const [activeInput, setActiveInput] = useState<'badge' | 'email' | 'password'>('badge')
  const formRef = useRef<HTMLFormElement | null>(null)
  const badgeInputRef = useRef<HTMLInputElement | null>(null)
  const emailInputRef = useRef<HTMLInputElement | null>(null)
  const passwordInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRedirect = !loading && !!session

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
        await loginWithBadge(badgeCode.trim())
        navigate('/', { replace: true })
      } else {
        await login(email.trim(), password)
        navigate('/', { replace: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

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

  return (
    <div className="screen auth-screen">
      <div className="panel">
        <h1>{mode === 'register' ? 'Create account' : mode === 'badge' ? 'Scan staff badge' : 'Sign in'}</h1>
        <p className="muted">
          Cash register · ElectroPOS
          {mode === 'register' && (
            <>
              <br />
              First user becomes <strong>admin</strong> (catalog + users). Later signups are cashiers.
            </>
          )}
          {mode === 'badge' && (
            <>
              <br />
              Scan QR badge to unlock this register for your shift.
            </>
          )}
        </p>
        <form ref={formRef} onSubmit={(e) => void onSubmit(e)} className="form">
          {mode === 'badge' ? (
            <label>
              QR badge code
              <input
                ref={badgeInputRef}
                type="text"
                autoComplete="off"
                autoFocus
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
              setMode(mode === 'badge' ? 'login' : mode === 'login' ? 'register' : 'badge')
              setActiveInput(mode === 'badge' ? 'email' : 'badge')
              setError(null)
              setNotice(null)
            }}
          >
            {mode === 'badge'
              ? 'Use email/password'
              : mode === 'login'
                ? 'Create first account…'
                : 'Back to badge scan'}
          </button>
        </form>
      </div>
    </div>
  )
}
