import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function RequireAdmin() {
  const { session, loading } = useAuth()
  if (loading) {
    return (
      <div className="screen">
        <p>Loading…</p>
      </div>
    )
  }
  if (!session || session.user.role !== 'admin') {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}
