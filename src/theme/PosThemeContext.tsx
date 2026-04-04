import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { applyPosThemeToDocument, readStoredPosTheme, writeStoredPosTheme, type PosTheme } from './posTheme'

type PosThemeContextValue = {
  theme: PosTheme
  setTheme: (theme: PosTheme) => void
}

const PosThemeContext = createContext<PosThemeContextValue | null>(null)

export function PosThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<PosTheme>(() => readStoredPosTheme())

  const setTheme = useCallback((next: PosTheme) => {
    writeStoredPosTheme(next)
    applyPosThemeToDocument(next)
    setThemeState(next)
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])

  return <PosThemeContext.Provider value={value}>{children}</PosThemeContext.Provider>
}

export function usePosTheme(): PosThemeContextValue {
  const ctx = useContext(PosThemeContext)
  if (!ctx) {
    throw new Error('usePosTheme must be used within PosThemeProvider')
  }
  return ctx
}
