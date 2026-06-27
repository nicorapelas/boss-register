import type { StaffAttendanceSettings } from '../api/client'

const DEFAULT: StaffAttendanceSettings = {
  enabled: true,
  logoutClockOutPromptEnabled: true,
  logoutPromptAfterMinutes: 0,
  autoClockOutEnabled: false,
  autoClockOutTime: '18:00',
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
        autoClockOutEnabled: next.autoClockOutEnabled === true,
        autoClockOutTime:
          typeof next.autoClockOutTime === 'string' && /^\d{2}:\d{2}$/.test(next.autoClockOutTime)
            ? next.autoClockOutTime
            : '18:00',
      }
    : { ...DEFAULT }
}

export function getCachedStaffAttendanceSettings(): StaffAttendanceSettings {
  return cached
}
