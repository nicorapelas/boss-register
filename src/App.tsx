import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { RequireAdmin } from './layouts/RequireAdmin'
import { RequireAuth } from './layouts/RequireAuth'
import { Login } from './pages/Login'
import { PosSettings } from './pages/PosSettings'
import { Register } from './pages/Register'
import { PosThemeProvider } from './theme/PosThemeContext'
import './App.css'

export default function App() {
  return (
    <PosThemeProvider>
      <div className="pos-app-fill pos-touch">
        <AuthProvider>
          <BrowserRouter>
            <div className="pos-route">
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route element={<RequireAuth />}>
                  <Route path="/" element={<Register />} />
                  <Route element={<RequireAdmin />}>
                    <Route path="/settings" element={<PosSettings />} />
                  </Route>
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </BrowserRouter>
        </AuthProvider>
      </div>
    </PosThemeProvider>
  )
}
