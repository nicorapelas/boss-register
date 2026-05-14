import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { usePosTheme } from '../theme/PosThemeContext'
import { resolvePosLogoSrc } from '../theme/posLogo'
import { isPosManager } from '../auth/permissions'
import { useServerConnection } from '../network/useServerConnection'
import { IconCloseWindow, IconMinimize } from '../icons/windowChrome'

const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'

function CogIcon() {
  return (
    <svg
      className="shell-settings-icon"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.397-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.645-.87a7.52 7.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.075-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  )
}

export function PosShell({
  children,
  beforeSignOut,
}: {
  children: ReactNode
  /** Return false to keep the session (e.g. cart not empty). */
  beforeSignOut?: () => boolean
}) {
  const { session, logout } = useAuth()
  const { theme } = usePosTheme()
  const logoMark = resolvePosLogoSrc(theme)
  const location = useLocation()
  const isAdmin = isPosManager(session?.user)
  const { disconnected, recovered } = useServerConnection()
  const onSettings = location.pathname === '/settings'
  const shellSub = onSettings ? 'Settings' : 'Register'
  const settingsToggleLabel = onSettings ? 'Close settings' : 'Settings'
  const userLabel = session?.user.displayName?.trim() || session?.user.email

  function handleSignOut() {
    if (beforeSignOut && !beforeSignOut()) return
    void logout()
  }

  function handleQuitApp() {
    if (beforeSignOut && !beforeSignOut()) return
    void window.electronApp?.quit()
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">
          <Link to="/" className="shell-brand-link" aria-label="CogniPOS — Home">
            <img src={logoMark} alt="" className="shell-brand-logo" decoding="async" />
          </Link>
          <span className="shell-sub">{shellSub}</span>
          <span className="shell-version" title="App version">
            v{APP_VERSION}
          </span>
        </div>
        <div className="shell-header-center">
          {session ? (
            <button type="button" className="btn ghost" onClick={handleSignOut}>
              Sign out
            </button>
          ) : null}
        </div>
        <div className="shell-actions">
          {session && (
            <>
              {isAdmin && (
                <Link
                  to={onSettings ? '/' : '/settings'}
                  className="btn ghost shell-settings-link"
                  aria-label={settingsToggleLabel}
                  title={settingsToggleLabel}
                >
                  <CogIcon />
                </Link>
              )}
              <span className="shell-till-badge" title="POS till code">
                Till {POS_TILL_CODE}
              </span>
              <span className="shell-user">{userLabel}</span>
              {window.electronApp ? (
                <>
                  <button
                    type="button"
                    className="btn ghost shell-app-minimize"
                    aria-label="Minimize"
                    title="Minimize"
                    onClick={() => void window.electronApp?.minimize()}
                  >
                    <IconMinimize className="shell-window-icon" />
                  </button>
                  <button
                    type="button"
                    className="btn ghost shell-app-quit"
                    aria-label="Exit app"
                    title="Exit app"
                    onClick={handleQuitApp}
                  >
                    <IconCloseWindow className="shell-window-icon" />
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      </header>
      {disconnected ? (
        <div className="server-connection-banner server-connection-banner--offline" role="status" aria-live="polite">
          OFFLINE: Cannot reach server. Trying to reconnect...
        </div>
      ) : null}
      {!disconnected && recovered ? (
        <div className="server-connection-banner server-connection-banner--online" role="status" aria-live="polite">
          Connected to server again.
        </div>
      ) : null}
      <main className="shell-main">{children}</main>
    </div>
  )
}
