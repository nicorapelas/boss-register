import { useCallback, useState } from 'react'
import {
  attendanceClockOutSelf,
  fetchAttendanceMyStatus,
  isServerReachable,
  type AttendanceMyStatus,
} from '../api/client'

function formatClockInTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

type ClockOutModalState =
  | { kind: 'confirm'; status: AttendanceMyStatus }
  | { kind: 'not-clocked-in' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

type UseSignOutWithAttendanceOptions = {
  onSignOut: () => void | Promise<void>
}

export function useSignOutWithAttendance({ onSignOut }: UseSignOutWithAttendanceOptions) {
  const [clockOutModal, setClockOutModal] = useState<ClockOutModalState | null>(null)
  const [busy, setBusy] = useState(false)

  const finishSignOut = useCallback(async () => {
    setClockOutModal(null)
    await onSignOut()
  }, [onSignOut])

  const requestSignOut = useCallback(
    async (options?: { beforeSignOut?: () => boolean }) => {
      if (options?.beforeSignOut && !options.beforeSignOut()) return
      await finishSignOut()
    },
    [finishSignOut],
  )

  const requestClockOut = useCallback(
    async (options?: { beforeSignOut?: () => boolean }) => {
      if (options?.beforeSignOut && !options.beforeSignOut()) return
      if (!isServerReachable()) {
        setClockOutModal({ kind: 'offline' })
        return
      }
      try {
        const status = await fetchAttendanceMyStatus()
        if (!status.attendance.enabled) return
        if (!status.clockedIn) {
          setClockOutModal({ kind: 'not-clocked-in' })
          return
        }
        setClockOutModal({ kind: 'confirm', status })
      } catch (err) {
        setClockOutModal({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not check attendance',
        })
      }
    },
    [],
  )

  const confirmClockOut = useCallback(async () => {
    setBusy(true)
    try {
      await attendanceClockOutSelf()
      await finishSignOut()
    } catch (err) {
      setClockOutModal({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Clock out failed',
      })
    } finally {
      setBusy(false)
    }
  }, [finishSignOut])

  const closeClockOutModal = useCallback(() => {
    if (!busy) setClockOutModal(null)
  }, [busy])

  const clockOutModalUi =
    clockOutModal != null ? (
      <div
        className="modal-backdrop modal-backdrop--pos-top"
        role="presentation"
        onMouseDown={closeClockOutModal}
      >
        <div
          className="modal-panel panel confirm-preset-delete-modal confirm-message-modal attendance-signout-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="attendance-clockout-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {clockOutModal.kind === 'confirm' ? (
            <>
              <h2 id="attendance-clockout-title" className="confirm-preset-delete-title">
                Clock out?
              </h2>
              <div className="confirm-preset-delete-body">
                <p>
                  You are clocked in
                  {clockOutModal.status.clockInAt
                    ? ` since ${formatClockInTime(clockOutModal.status.clockInAt)}`
                    : ''}
                  . End your shift and log out?
                </p>
              </div>
              <div className="assign-preset-actions confirm-message-modal-actions attendance-signout-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={closeClockOutModal}>
                  Cancel
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void confirmClockOut()}>
                  {busy ? 'Clocking out…' : 'Clock out & log out'}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="attendance-clockout-title" className="confirm-preset-delete-title">
                {clockOutModal.kind === 'not-clocked-in'
                  ? 'Not clocked in'
                  : clockOutModal.kind === 'offline'
                    ? 'Offline'
                    : 'Clock out'}
              </h2>
              <div className="confirm-preset-delete-body">
                <p>
                  {clockOutModal.kind === 'not-clocked-in'
                    ? 'You are not clocked in right now.'
                    : clockOutModal.kind === 'offline'
                      ? 'Cannot clock out while offline. Reconnect to the server and try again.'
                      : clockOutModal.message}
                </p>
              </div>
              <div className="assign-preset-actions confirm-message-modal-actions attendance-signout-actions">
                <button type="button" className="btn primary" disabled={busy} onClick={closeClockOutModal}>
                  OK
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    ) : null

  return { requestSignOut, requestClockOut, clockOutModal: clockOutModalUi }
}
