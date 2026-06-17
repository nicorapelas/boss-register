import { createContext, useContext, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useSignOutWithAttendance } from './useSignOutWithAttendance'

type SignOutAttendanceContextValue = {
  requestSignOut: (options?: { beforeSignOut?: () => boolean }) => Promise<void>
  requestClockOut: (options?: { beforeSignOut?: () => boolean }) => Promise<void>
}

const SignOutAttendanceContext = createContext<SignOutAttendanceContextValue | null>(null)

export function SignOutAttendanceProvider({ children }: { children: ReactNode }) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { requestSignOut, requestClockOut, clockOutModal } = useSignOutWithAttendance({
    onSignOut: async () => {
      await logout()
      navigate('/login', { replace: true })
    },
  })

  return (
    <SignOutAttendanceContext.Provider value={{ requestSignOut, requestClockOut }}>
      {children}
      {clockOutModal}
    </SignOutAttendanceContext.Provider>
  )
}

export function useSignOutAttendance() {
  const ctx = useContext(SignOutAttendanceContext)
  if (!ctx) {
    throw new Error('useSignOutAttendance must be used within SignOutAttendanceProvider')
  }
  return ctx
}
