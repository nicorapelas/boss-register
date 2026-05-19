import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'

/** Sign out when the till has no pointer/keyboard activity for this long. */
export const POS_INACTIVITY_LOGOUT_MS = 10_000

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'click', 'wheel'] as const

/**
 * Auto-logout for shared tills: clears the session after idle timeout so the next
 * cashier must scan a badge or sign in again.
 */
export function PosInactivityLogout() {
  const { session, loading, logout } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (loading || !session) return

    let timer = window.setTimeout(() => {
      void (async () => {
        await logout()
        navigate('/login', { replace: true })
      })()
    }, POS_INACTIVITY_LOGOUT_MS)

    const onActivity = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void (async () => {
          await logout()
          navigate('/login', { replace: true })
        })()
      }, POS_INACTIVITY_LOGOUT_MS)
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { capture: true, passive: true })
    }

    return () => {
      window.clearTimeout(timer)
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity, { capture: true })
      }
    }
  }, [loading, session, logout, navigate])

  return null
}
