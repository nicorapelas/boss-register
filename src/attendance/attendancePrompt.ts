import type { AttendanceMyStatus } from '../api/client'

export function shouldPromptClockOutOnLogout(status: AttendanceMyStatus): boolean {
  if (!status.attendance.enabled || !status.attendance.logoutClockOutPromptEnabled) return false
  if (!status.clockedIn) return false
  const minMinutes = status.attendance.logoutPromptAfterMinutes
  if (minMinutes <= 0) return true
  return status.elapsedMinutes >= minMinutes
}
