import type { PosTheme } from '../theme/posTheme'
import type { CustomerDisplayStoreConfig } from './types'

/** Solid colours aligned with each POS register theme (customer display cannot use CSS gradients). */
const POS_THEME_CUSTOMER_DISPLAY: Record<
  PosTheme,
  { backgroundColor: string; accentColor: string; textColor: string }
> = {
  dark: { backgroundColor: '#1e1e1e', accentColor: '#3b82f6', textColor: '#f4f4f5' },
  light: { backgroundColor: '#e8e0d4', accentColor: '#1d4ed8', textColor: '#120f0a' },
  ubuntu: { backgroundColor: '#1e1b4b', accentColor: '#22d3ee', textColor: '#f5f3ff' },
  elon: { backgroundColor: '#0a1628', accentColor: '#b22234', textColor: '#f8fafc' },
  lego: { backgroundColor: '#0c1929', accentColor: '#ffd502', textColor: '#fffef5' },
  jacobs: { backgroundColor: '#ffffff', accentColor: '#0909e8', textColor: '#000000' },
}

/** Per-till: customer display colours follow POS Appearance (overrides Back Office theme colours). */
export function applyPosThemeToCustomerDisplayConfig(
  storeConfig: CustomerDisplayStoreConfig,
  posTheme: PosTheme,
): CustomerDisplayStoreConfig {
  const theme = POS_THEME_CUSTOMER_DISPLAY[posTheme]
  return {
    ...storeConfig,
    theme: { ...theme },
  }
}
