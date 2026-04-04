export type PosTheme = 'dark' | 'light'

const STORAGE_KEY = 'electropos-pos-theme'

export function readStoredPosTheme(): PosTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* private mode / quota */
  }
  return 'dark'
}

export function writeStoredPosTheme(theme: PosTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Syncs `<html>` for CSS (`data-pos-theme`) and `color-scheme` (form controls / scrollbars). */
export function applyPosThemeToDocument(theme: PosTheme): void {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-pos-theme', 'light')
    document.documentElement.style.colorScheme = 'light'
  } else {
    document.documentElement.removeAttribute('data-pos-theme')
    document.documentElement.style.colorScheme = 'dark'
  }
}
