import { attendanceClockBadge, attendanceClockFace, isServerReachable } from '../api/client'

const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)

function isAlreadyClockedInError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.toLowerCase().includes('already clocked in')
}

/** Clock in on the server when attendance is enabled; no-op if already clocked in. */
export async function clockInBeforeTillSignIn(opts: {
  staffAttendanceEnabled: boolean
  badgeCode?: string
  embedding?: number[]
}): Promise<void> {
  if (!opts.staffAttendanceEnabled || !isServerReachable()) return

  if (opts.embedding?.length) {
    try {
      await attendanceClockFace(opts.embedding, POS_TILL_CODE)
    } catch (err) {
      if (!isAlreadyClockedInError(err)) throw err
    }
    return
  }

  const badgeCode = opts.badgeCode?.trim()
  if (!badgeCode) return

  try {
    await attendanceClockBadge(badgeCode, POS_TILL_CODE)
  } catch (err) {
    if (!isAlreadyClockedInError(err)) throw err
  }
}
