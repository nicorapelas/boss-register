import logoLight from '../assets/logo-text_bottom-light.png'
import logoDark from '../assets/logo-text_bottom1-dark.png'
import type { PosTheme } from './posTheme'

/** `light` = white/light panel; `dark` = coloured or dark chrome (e.g. blue header). */
export type PosLogoSurface = 'light' | 'dark'

function isLightHexBackground(hex: string): boolean {
  const h = hex.trim().replace(/^#/, '')
  if (h.length !== 3 && h.length !== 6) return false
  const full =
    h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return false
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72
}

/**
 * Logo mark for UI chrome.
 * Light theme and Jacobs on white panels use the dark-coloured mark (`logo-text_bottom-light.png`).
 */
export function resolvePosLogoSrc(theme: PosTheme, surface: PosLogoSurface = 'dark'): string {
  if (theme === 'light') return logoLight
  if (theme === 'jacobs' && surface === 'light') return logoLight
  return logoDark
}

/** Pick logo for customer display from the configured background colour. */
export function resolvePosLogoForBackground(backgroundColor: string): string {
  return isLightHexBackground(backgroundColor) ? logoLight : logoDark
}
