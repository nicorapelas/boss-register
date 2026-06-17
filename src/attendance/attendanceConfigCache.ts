import type { StaffAttendanceSettings } from '../api/client'

const DEFAULT: StaffAttendanceSettings = {
  enabled: true,
  logoutClockOutPromptEnabled: true,
  logoutPromptAfterMinutes: 0,
}

let cached: StaffAttendanceSettings = { ...DEFAULT }

export function setCachedStaffAttendanceSettings(next: StaffAttendanceSettings | undefined) {
  cached = next
    ? {
        enabled: next.enabled !== false,
        logoutClockOutPromptEnabled: next.logoutClockOutPromptEnabled !== false,
        logoutPromptAfterMinutes:
          typeof next.logoutPromptAfterMinutes === 'number' && next.logoutPromptAfterMinutes >= 0
            ? next.logoutPromptAfterMinutes
            : 0,
      }
    : { ...DEFAULT }
}

export function getCachedStaffAttendanceSettings(): StaffAttendanceSettings {
  return cached
}
