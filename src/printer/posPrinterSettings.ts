export type PrinterTransport =
  | { kind: 'usb'; path: string }
  | { kind: 'lan'; host: string; port: number }
  | { kind: 'serial'; path: string; baudRate: number }

export type PosPrinterSettings = {
  autoPrintReceipt: boolean
  autoOpenDrawer: boolean
  transport: PrinterTransport
  columns: number
  cut: boolean
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

const STORAGE_KEY = 'electropos-pos-printer-settings'

export const DEFAULT_PRINTER_SETTINGS: PosPrinterSettings = {
  autoPrintReceipt: true,
  autoOpenDrawer: true,
  transport: { kind: 'serial', path: '/dev/ttyS0', baudRate: 38400 },
  columns: 42,
  cut: true,
  receiptConfig: {
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
  },
}

export function readPosPrinterSettings(): PosPrinterSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PRINTER_SETTINGS
    const parsed = JSON.parse(raw) as Partial<PosPrinterSettings>
    const transport = parsed.transport
    const next: PosPrinterSettings = {
      ...DEFAULT_PRINTER_SETTINGS,
      ...parsed,
      transport: DEFAULT_PRINTER_SETTINGS.transport,
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
    next.receiptConfig = {
      ...DEFAULT_PRINTER_SETTINGS.receiptConfig,
      ...(parsed.receiptConfig ?? {}),
    }
    if (!Number.isFinite(next.receiptConfig.vatRatePct)) next.receiptConfig.vatRatePct = 15
    return next
  } catch {
    return DEFAULT_PRINTER_SETTINGS
  }
}

export function writePosPrinterSettings(settings: PosPrinterSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // ignore
  }
}

