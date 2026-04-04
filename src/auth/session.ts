import type { SessionBundle } from './types'

export async function loadStoredSession(): Promise<SessionBundle | null> {
  if (typeof window === 'undefined' || !window.electronAuth) return null
  const raw = await window.electronAuth.getBundle()
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionBundle
  } catch {
    return null
  }
}

export async function persistSession(bundle: SessionBundle | null) {
  if (typeof window === 'undefined' || !window.electronAuth) return
  if (!bundle) {
    await window.electronAuth.clear()
    return
  }
  await window.electronAuth.setBundle(JSON.stringify(bundle))
}
