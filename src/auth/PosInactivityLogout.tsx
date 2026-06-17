import { useEffect } from 'react'
import {
  posSaleBlocksInactivityLogout,
  subscribePosSaleInactivityGuard,
} from '../register/posSaleInactivityGuard'
import { useAuth } from './AuthContext'
import { useSignOutAttendance } from '../attendance/SignOutAttendanceContext'

/** Sign out when the till has no pointer/keyboard activity for this long. */
export const POS_INACTIVITY_LOGOUT_MS = 20_000

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'click', 'wheel'] as const

/**
 * Auto-logout for shared tills: clears the session after idle timeout so the next
 * cashier must scan a badge or sign in again. Skipped while the cart has lines or
 * a split payment is in progress.
 */
export function PosInactivityLogout() {
  const { session, loading } = useAuth()
  const { requestSignOut } = useSignOutAttendance()

  useEffect(() => {
    if (loading || !session) return

    let timer = window.setTimeout(onIdleTimeout, POS_INACTIVITY_LOGOUT_MS)

    function armTimer() {
      window.clearTimeout(timer)
      timer = window.setTimeout(onIdleTimeout, POS_INACTIVITY_LOGOUT_MS)
    }

    function onIdleTimeout() {
      if (posSaleBlocksInactivityLogout()) {
        armTimer()
        return
      }
      void requestSignOut()
    }

    const onActivity = () => {
      armTimer()
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { capture: true, passive: true })
    }

    const unsubGuard = subscribePosSaleInactivityGuard(() => {
      if (posSaleBlocksInactivityLogout()) {
        armTimer()
      }
    })

    return () => {
      window.clearTimeout(timer)
      unsubGuard()
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity, { capture: true })
      }
    }
  }, [loading, session, requestSignOut])

  return null
}
