import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function RequireAuth() {
  const { session, loading } = useAuth()
  if (loading) {
    return (
      <div className="screen">
        <p>Loading…</p>
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace />
  return <Outlet />
}
