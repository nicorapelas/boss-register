import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AuthProvider } from './auth/AuthContext'
import { RequireAdmin } from './layouts/RequireAdmin'
import { RequireAuth } from './layouts/RequireAuth'
import { Login } from './pages/Login'
import { PosSettings } from './pages/PosSettings'
import { Register } from './pages/Register'
import { GlobalPosButtonSound } from './audio/GlobalPosButtonSound'
import { PosThemeProvider } from './theme/PosThemeContext'
import './App.css'

type RuntimeErrorBoundaryState = {
  hasError: boolean
  message: string
  details?: string
}

class RuntimeErrorBoundary extends Component<{ children: ReactNode }, RuntimeErrorBoundaryState> {
  state: RuntimeErrorBoundaryState = { hasError: false, message: '', details: '' }

  static getDerivedStateFromError(error: unknown): RuntimeErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error)
    return { hasError: true, message }
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // Keep this in development builds to avoid silent white screens.
    console.error('[renderer-crash]', error, errorInfo)
    const stack = error instanceof Error ? error.stack ?? '' : ''
    this.setState({
      details: [errorInfo.componentStack?.trim(), stack.trim()].filter(Boolean).join('\n\n'),
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="screen">
          <div className="panel" style={{ maxWidth: 720, margin: '0 auto' }}>
            <h2>Something went wrong</h2>
            <p className="error" style={{ whiteSpace: 'pre-wrap' }}>
              {this.state.message || 'Unknown renderer error'}
            </p>
            <p className="muted">Please share this message so we can fix the crash quickly.</p>
            {this.state.details ? (
              <pre
                className="muted"
                style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem', marginTop: '0.75rem', maxHeight: 220, overflow: 'auto' }}
              >
                {this.state.details}
              </pre>
            ) : null}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <PosThemeProvider>
      <div className="pos-app-fill pos-touch">
        <GlobalPosButtonSound />
        <AuthProvider>
          <RuntimeErrorBoundary>
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
          </RuntimeErrorBoundary>
        </AuthProvider>
      </div>
    </PosThemeProvider>
  )
}
