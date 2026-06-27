export type PrinterTransport =
  | { kind: 'usb'; path: string }
  | { kind: 'lan'; host: string; port: number }
  | { kind: 'serial'; path: string; baudRate: number }

export type PrintDensity = 'light' | 'normal' | 'dark'

export type ReceiptPrintOpts = {
  columns: number
  cut: boolean
  printDensity: PrintDensity
  lineSpacing: number
  headerBold: boolean
}

export type PosPrinterSettings = {
  autoPrintReceipt: boolean
  autoOpenDrawer: boolean
  transport: PrinterTransport
  columns: number
  cut: boolean
  printDensity: PrintDensity
  lineSpacing: number
  headerBold: boolean
  receiptConfig: {
    headerLine1: string
    headerLine2: string
    headerLine3: string
    phone: string
    vatNumber: string
    vatRatePct: number
    receiptTitle: string
    tillLabel: string
    slipLabel: string
    vatLabel: string
    subtotalLabel: string
    taxTotalLabel: string
    totalDueLabel: string
    cashTenderedLabel: string
    changeDueLabel: string
    thankYouLine: string
  }
}

/** Till hardware profile — baked at build via VITE_POS_TERMINAL_PROFILE or inferred from till code. */
export type PosTerminalPrinterProfile = 'ncr' | 'posiflex'

const STORAGE_KEY = 'electropos-pos-printer-settings'
/** Register quick-toggle — survives logout on this till (separate from settings autoPrintReceipt). */
const REGISTER_RECEIPT_ENABLED_KEY = 'electropos-register-receipt-enabled'

const DEFAULT_RECEIPT_CONFIG: PosPrinterSettings['receiptConfig'] = {
  headerLine1: 'JACOBS CYCLES',
  headerLine2: 'HALITE STREET',
  headerLine3: 'CARLETONVILLE',
  phone: '018 788 5292',
  vatNumber: '4480105321',
  vatRatePct: 15,
  receiptTitle: '--YOUR RECEIPT--',
  tillLabel: 'Till No',
  slipLabel: 'Slip No',
  vatLabel: 'Vat1',
  subtotalLabel: 'SUBTOTAL:',
  taxTotalLabel: 'TAX TOTAL:',
  totalDueLabel: 'TOTAL DUE:',
  cashTenderedLabel: 'CASH TENDERED:',
  changeDueLabel: 'CHANGE DUE:',
  thankYouLine: 'THANK YOU',
}

const DEFAULT_LAYOUT: Omit<PosPrinterSettings, 'transport'> = {
  autoPrintReceipt: true,
  autoOpenDrawer: true,
  columns: 42,
  cut: true,
  printDensity: 'normal',
  lineSpacing: 36,
  headerBold: true,
  receiptConfig: DEFAULT_RECEIPT_CONFIG,
}

/** Resolve NCR vs Posiflex printer defaults for this AppImage build. */
export function posTerminalPrinterProfile(): PosTerminalPrinterProfile {
  const explicit = import.meta.env.VITE_POS_TERMINAL_PROFILE?.trim().toLowerCase()
  if (explicit === 'ncr') return 'ncr'
  if (explicit === 'posiflex') return 'posiflex'
  const till = (import.meta.env.VITE_POS_TILL_CODE ?? '').trim().toUpperCase()
  if (till === 'T2') return 'ncr'
  return 'posiflex'
}

export function defaultPrinterTransportForProfile(
  profile: PosTerminalPrinterProfile = posTerminalPrinterProfile(),
): PrinterTransport {
  if (profile === 'ncr') {
    return { kind: 'usb', path: '/dev/usb/pos-printer' }
  }
  return { kind: 'serial', path: '/dev/ttyS0', baudRate: 38400 }
}

/** USB device path when switching connection type on this till. */
export function defaultUsbPrinterPath(
  profile: PosTerminalPrinterProfile = posTerminalPrinterProfile(),
): string {
  const transport = defaultPrinterTransportForProfile(profile)
  return transport.kind === 'usb' ? transport.path : '/dev/usb/lp0'
}

/** Full printer defaults for this till (connection + layout). */
export function defaultPrinterSettingsForTill(
  profile: PosTerminalPrinterProfile = posTerminalPrinterProfile(),
): PosPrinterSettings {
  return {
    ...DEFAULT_LAYOUT,
    transport: defaultPrinterTransportForProfile(profile),
  }
}

/** Reset layout / receipt text; keep current connection (USB path, serial port, etc.). */
export function resetPrinterLayoutKeepTransport(current: PosPrinterSettings): PosPrinterSettings {
  const defaults = defaultPrinterSettingsForTill()
  return {
    ...defaults,
    transport: current.transport,
  }
}

export function printerProfileLabel(profile: PosTerminalPrinterProfile = posTerminalPrinterProfile()): string {
  return profile === 'ncr' ? 'NCR (USB receipt printer)' : 'Posiflex (serial receipt printer)'
}

/** Posiflex serial baseline — used by tests and legacy imports. */
export const DEFAULT_PRINTER_SETTINGS: PosPrinterSettings = defaultPrinterSettingsForTill('posiflex')

export function readPosPrinterSettings(): PosPrinterSettings {
  const baseDefaults = defaultPrinterSettingsForTill()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return baseDefaults
    const parsed = JSON.parse(raw) as Partial<PosPrinterSettings>
    const transport = parsed.transport
    const next: PosPrinterSettings = {
      ...baseDefaults,
      ...parsed,
      transport: baseDefaults.transport,
    }
    if (transport && typeof transport === 'object') {
      const t = transport as Record<string, unknown>
      if (t.kind === 'usb' && typeof t.path === 'string' && t.path) next.transport = { kind: 'usb', path: t.path }
      if (
        t.kind === 'lan' &&
        typeof t.host === 'string' &&
        t.host &&
        typeof t.port === 'number' &&
        Number.isFinite(t.port) &&
        t.port > 0
      ) {
        next.transport = { kind: 'lan', host: t.host, port: t.port }
      }
      if (
        t.kind === 'serial' &&
        typeof t.path === 'string' &&
        t.path &&
        typeof t.baudRate === 'number' &&
        Number.isFinite(t.baudRate) &&
        t.baudRate > 0
      ) {
        next.transport = { kind: 'serial', path: t.path, baudRate: t.baudRate }
      }
    }
    if (typeof next.columns !== 'number' || !Number.isFinite(next.columns) || next.columns < 24) next.columns = 48
    if (next.printDensity !== 'light' && next.printDensity !== 'normal' && next.printDensity !== 'dark') {
      next.printDensity = DEFAULT_LAYOUT.printDensity
    }
    if (typeof next.lineSpacing !== 'number' || !Number.isFinite(next.lineSpacing) || next.lineSpacing < 20) {
      next.lineSpacing = DEFAULT_LAYOUT.lineSpacing
    }
    if (typeof next.headerBold !== 'boolean') next.headerBold = DEFAULT_LAYOUT.headerBold
    next.receiptConfig = {
      ...DEFAULT_RECEIPT_CONFIG,
      ...(parsed.receiptConfig ?? {}),
    }
    if (!Number.isFinite(next.receiptConfig.vatRatePct)) next.receiptConfig.vatRatePct = 15
    return next
  } catch {
    return baseDefaults
  }
}

export function writePosPrinterSettings(settings: PosPrinterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

/** Register RECEIPT ON/OFF toggle — persisted per till across cashier logout. */
export function readRegisterReceiptEnabled(): boolean {
  try {
    const raw = localStorage.getItem(REGISTER_RECEIPT_ENABLED_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    // ignore
  }
  return readPosPrinterSettings().autoPrintReceipt
}

export function writeRegisterReceiptEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(REGISTER_RECEIPT_ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // ignore
  }
}

export function receiptPrintOpts(settings: PosPrinterSettings): ReceiptPrintOpts {
  return {
    columns: settings.columns,
    cut: settings.cut,
    printDensity: settings.printDensity,
    lineSpacing: settings.lineSpacing,
    headerBold: settings.headerBold,
  }
}

/** Open cash drawer before receipt bytes are sent (same printer connection). */
export async function kickCashDrawerIfConfigured(
  settings: PosPrinterSettings,
): Promise<{ ok: boolean; error?: string }> {
  if (!settings.autoOpenDrawer) return { ok: true }
  if (typeof window === 'undefined' || !window.electronPos?.kickDrawer) return { ok: true }
  return window.electronPos.kickDrawer(settings.transport)
}
