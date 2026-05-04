export type PosTheme = 'dark' | 'light' | 'ubuntu' | 'elon'

const STORAGE_KEY = 'electropos-pos-theme'

function migrateStoredTheme(v: string | null): PosTheme | null {
  if (v === 'usa' || v === 'trump') {
    try {
      localStorage.setItem(STORAGE_KEY, 'elon')
    } catch {
      /* ignore */
    }
    return 'elon'
  }
  if (v === 'colorful') {
    try {
      localStorage.setItem(STORAGE_KEY, 'ubuntu')
    } catch {
      /* ignore */
    }
    return 'ubuntu'
  }
  return null
}

export function readStoredPosTheme(): PosTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    const migrated = migrateStoredTheme(v)
    if (migrated) return migrated
    if (v === 'light' || v === 'dark' || v === 'ubuntu' || v === 'elon') return v
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
  } else if (theme === 'ubuntu') {
    document.documentElement.setAttribute('data-pos-theme', 'ubuntu')
    document.documentElement.style.colorScheme = 'dark'
  } else if (theme === 'elon') {
    document.documentElement.setAttribute('data-pos-theme', 'elon')
    document.documentElement.style.colorScheme = 'dark'
  } else {
    document.documentElement.removeAttribute('data-pos-theme')
    document.documentElement.style.colorScheme = 'dark'
  }
}
