import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { registerRequest } from '../api/client'
import { useAuth } from '../auth/AuthContext'

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

  if (!loading && session) {
    return <Navigate to="/" replace />
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
        <form onSubmit={(e) => void onSubmit(e)} className="form">
          {mode === 'badge' ? (
            <label>
              QR badge code
              <input
                type="text"
                autoComplete="off"
                autoFocus
                placeholder="Scan badge or type code"
                value={badgeCode}
                onChange={(e) => setBadgeCode(e.target.value)}
                required
              />
            </label>
          ) : (
            <>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          )}
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
