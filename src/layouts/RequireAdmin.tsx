import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { isPosManager } from '../auth/permissions'

export function RequireAdmin() {
  const { session, loading } = useAuth()
  if (loading) {
    return (
      <div className="screen">
        <p>Loading…</p>
      </div>
    )
  }
  if (!session || !isPosManager(session.user)) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}
