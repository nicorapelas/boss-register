import logoLight from '../assets/logo-text_bottom-light.png'
import logoDark from '../assets/logo-text_bottom1-dark.png'
import type { PosTheme } from './posTheme'

/** Light theme uses the light mark; dark, ubuntu, and elon use the dark mark. */
export function resolvePosLogoSrc(theme: PosTheme): string {
  return theme === 'light' ? logoLight : logoDark
}
