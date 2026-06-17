import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  attendanceClockBadge,
  attendanceClockFace,
  fetchAttendancePending,
  type AttendanceClockResponse,
  type AttendancePendingStaff,
} from '../api/client'
import { useBadgeScanInputFocus } from '../auth/useBadgeScanInputFocus'
import { useServerConnection } from '../network/useServerConnection'
import { FaceLoginPanel } from '../components/FaceLoginPanel'

const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)
const PENDING_POLL_MS = 15_000

type StaffClockPanelProps = {
  enabled: boolean
  badgeInputRef: RefObject<HTMLInputElement>
  busy: boolean
  onClockedIn: (opts: { badgeCode?: string; embedding?: number[] }) => Promise<void>
  onVisibilityChange?: (visible: boolean) => void
}

export function StaffClockPanel({
  enabled,
  badgeInputRef,
  busy,
  onClockedIn,
  onVisibilityChange,
}: StaffClockPanelProps) {
  const [pending, setPending] = useState<AttendancePendingStaff[]>([])
  const [pendingLoaded, setPendingLoaded] = useState(false)
  const [faceOpen, setFaceOpen] = useState(false)
  const [badgeCode, setBadgeCode] = useState('')
  const [clockBusy, setClockBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { disconnected } = useServerConnection()
  const online = !disconnected
  const faceUiPointerRef = useRef(false)

  const refreshPending = useCallback(async () => {
    if (!enabled || !online) return
    try {
      const data = await fetchAttendancePending()
      setPending(data.pending)
    } catch {
      /* keep last list */
    } finally {
      setPendingLoaded(true)
    }
  }, [enabled, online])

  useEffect(() => {
    if (!enabled) {
      setPending([])
      setPendingLoaded(true)
      onVisibilityChange?.(false)
      return
    }
    void refreshPending()
    if (!online) return
    const timer = window.setInterval(() => void refreshPending(), PENDING_POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, online, refreshPending, onVisibilityChange])

  const visible = enabled && pendingLoaded && pending.length > 0

  useEffect(() => {
    onVisibilityChange?.(visible)
  }, [visible, onVisibilityChange])

  const clockBadgeFocusActive = visible && !faceOpen && !busy && !clockBusy

  useBadgeScanInputFocus(badgeInputRef, clockBadgeFocusActive, {
    pauseRefocus: () => faceUiPointerRef.current,
  })

  const afterClockIn = useCallback(
    async (opts: { badgeCode?: string; embedding?: number[] }, result: AttendanceClockResponse) => {
      setError(null)
      setBadgeCode('')
      await refreshPending()
      try {
        await onClockedIn(opts)
      } catch (err) {
        setError(
          err instanceof Error
            ? `${result.displayName} clocked in, but till sign-in failed: ${err.message}`
            : 'Clocked in, but till sign-in failed',
        )
      }
    },
    [onClockedIn, refreshPending],
  )

  const handleBadgeClock = useCallback(
    async (code: string) => {
      const trimmed = code.trim()
      if (!trimmed || busy || clockBusy) return
      if (!online) {
        setError('Staff clock requires an online connection to the server.')
        return
      }
      setClockBusy(true)
      setError(null)
      try {
        const result = await attendanceClockBadge(trimmed, POS_TILL_CODE)
        await afterClockIn({ badgeCode: trimmed }, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Clock in failed'
        if (message.toLowerCase().includes('already clocked in')) {
          try {
            await onClockedIn({ badgeCode: trimmed })
          } catch (loginErr) {
            setError(loginErr instanceof Error ? loginErr.message : 'Sign-in failed')
          }
        } else {
          setError(message)
        }
        setBadgeCode('')
      } finally {
        setClockBusy(false)
        window.setTimeout(() => badgeInputRef.current?.focus(), 40)
      }
    },
    [afterClockIn, badgeInputRef, busy, clockBusy, onClockedIn, online],
  )

  const handleFaceClock = useCallback(
    async (embedding: number[]) => {
      if (busy || clockBusy) return
      if (!online) {
        setError('Staff clock requires an online connection to the server.')
        return
      }
      setClockBusy(true)
      setError(null)
      try {
        const result = await attendanceClockFace(embedding, POS_TILL_CODE)
        setFaceOpen(false)
        await afterClockIn({ embedding }, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Clock in failed'
        if (message.toLowerCase().includes('already clocked in')) {
          try {
            await onClockedIn({ embedding })
          } catch (loginErr) {
            setError(loginErr instanceof Error ? loginErr.message : 'Sign-in failed')
          }
        } else {
          setError(message)
        }
      } finally {
        setClockBusy(false)
      }
    },
    [afterClockIn, busy, clockBusy, onClockedIn, online],
  )

  if (!visible) return null

  const panelBusy = busy || clockBusy

  return (
    <section
      className="panel staff-clock-panel staff-clock-panel--compact staff-clock-panel--active"
      aria-labelledby="staff-clock-heading"
    >
      <div className="staff-clock-compact-row">
        <div className="staff-clock-compact-main">
          <h2 id="staff-clock-heading" className="staff-clock-title">
            Clock in
          </h2>
          <span className="staff-clock-scan-badge" role="status">
            Scan badge to start shift
          </span>
        </div>
        <div className="staff-clock-compact-actions">
          <input
            ref={badgeInputRef}
            type="text"
            className="auth-badge-scan-input staff-clock-badge-input staff-clock-badge-input--compact"
            autoComplete="off"
            aria-label="Scan staff badge to clock in and sign in"
            value={badgeCode}
            disabled={panelBusy || !online}
            onChange={(e) => setBadgeCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleBadgeClock(e.currentTarget.value)
              }
            }}
          />
          <button
            type="button"
            className="btn ghost btn small staff-clock-face-toggle"
            disabled={panelBusy || !online}
            onClick={() => {
              setFaceOpen((v) => !v)
              setError(null)
            }}
          >
            {faceOpen ? 'Hide face' : 'Face'}
          </button>
        </div>
      </div>
      {!online ? (
        <p className="error small staff-clock-offline">Offline — clock in unavailable until server reconnects.</p>
      ) : null}
      <div className="staff-clock-pending">
        <span className="staff-clock-pending-label muted">Not clocked in yet</span>
        <ul className="staff-clock-pending-list">
          {pending.map((user) => (
            <li key={user.id} className="staff-clock-pending-item">
              {user.displayName}
              {user.roleName ? <span className="staff-clock-pending-role muted"> · {user.roleName}</span> : null}
            </li>
          ))}
        </ul>
      </div>
      {faceOpen ? (
        <div
          className="staff-clock-face-wrap staff-clock-face-wrap--compact"
          onPointerDown={() => {
            faceUiPointerRef.current = true
            window.setTimeout(() => {
              faceUiPointerRef.current = false
            }, 400)
          }}
        >
          <FaceLoginPanel
            busy={panelBusy || !online}
            onLogin={handleFaceClock}
            onUseBadge={() => setFaceOpen(false)}
          />
        </div>
      ) : null}
      {error ? <p className="error staff-clock-feedback">{error}</p> : null}
    </section>
  )
}
