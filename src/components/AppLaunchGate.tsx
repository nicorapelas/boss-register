import { useEffect, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hideAppSplash } from '../launch/appSplash'

export function AppLaunchGate({ children }: { children: ReactNode }) {
  const { loading } = useAuth()

  useEffect(() => {
    if (!loading) hideAppSplash()
  }, [loading])

  return children
}
