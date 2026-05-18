import { app, BrowserWindow, ipcMain, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type CustomerDisplayTillSettings = {
  enabled: boolean
  displayId: number | null
}

export type CustomerDisplaySnapshot = {
  mode: 'idle' | 'ready' | 'cart' | 'spotlight' | 'complete'
  storeName: string
  idle?: {
    headline: string
    subtext: string
    imageUrl: string
    backgroundColor: string
    accentColor: string
    footerText: string
  }
  lines?: Array<{ name: string; quantity: number; lineTotal: number }>
  total?: number
  footerText?: string
  theme?: { backgroundColor: string; accentColor: string }
  spotlight?: { name: string; imageUrl: string }
  complete?: {
    totalPaid: number
    changeDue?: number
    paymentLabel?: string
    token: number
  }
}

const DEFAULT_TILL: CustomerDisplayTillSettings = { enabled: false, displayId: null }

let customerWin: BrowserWindow | null = null
let tillSettings: CustomerDisplayTillSettings = { ...DEFAULT_TILL }
let rendererDist = ''
let viteDevServerUrl: string | undefined
let preloadPath = ''

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'customer-display-till.json')
}

export function initCustomerDisplayModule(opts: {
  rendererDist: string
  viteDevServerUrl?: string
  preloadPath: string
}) {
  rendererDist = opts.rendererDist
  viteDevServerUrl = opts.viteDevServerUrl
  preloadPath = opts.preloadPath
  loadTillSettings()
  registerCustomerDisplayIpc()
}

function loadTillSettings(): void {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CustomerDisplayTillSettings>
    tillSettings = {
      enabled: parsed.enabled === true,
      displayId: typeof parsed.displayId === 'number' ? parsed.displayId : null,
    }
  } catch {
    tillSettings = { ...DEFAULT_TILL }
  }
}

function saveTillSettings(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(tillSettings, null, 2), 'utf8')
  } catch (e) {
    console.error('[customer-display] save settings failed', e)
  }
}

function pickDisplay(): Electron.Display | undefined {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) return undefined
  if (tillSettings.displayId != null) {
    const found = displays.find((d) => d.id === tillSettings.displayId)
    if (found) return found
  }
  const primary = screen.getPrimaryDisplay()
  const external = displays.find((d) => d.id !== primary.id)
  return external ?? primary
}

function customerDisplayUrl(): string {
  const hash = '#/customer-display'
  if (viteDevServerUrl) return `${viteDevServerUrl}${hash}`
  return `file://${path.join(rendererDist, 'index.html')}${hash}`
}

function createCustomerWindow(): void {
  if (customerWin && !customerWin.isDestroyed()) return
  if (!tillSettings.enabled) return
  const display = pickDisplay()
  if (!display) return

  const { x, y, width, height } = display.bounds
  customerWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  customerWin.on('closed', () => {
    customerWin = null
  })

  void customerWin.loadURL(customerDisplayUrl()).then(() => {
    customerWin?.show()
  })
}

function destroyCustomerWindow(): void {
  if (customerWin && !customerWin.isDestroyed()) {
    customerWin.close()
  }
  customerWin = null
}

function syncCustomerWindow(): void {
  if (tillSettings.enabled) createCustomerWindow()
  else destroyCustomerWindow()
}

export function publishCustomerDisplaySnapshot(snapshot: CustomerDisplaySnapshot): void {
  if (!tillSettings.enabled) return
  if (!customerWin || customerWin.isDestroyed()) createCustomerWindow()
  if (customerWin && !customerWin.isDestroyed()) {
    customerWin.webContents.send('customer-display:snapshot', snapshot)
  }
}

function registerCustomerDisplayIpc(): void {
  ipcMain.handle('customer-display:list-displays', () => {
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label || `Display ${d.id}`,
      bounds: d.bounds,
      primary: d.id === screen.getPrimaryDisplay().id,
    }))
  })

  ipcMain.handle('customer-display:get-till-settings', () => ({ ...tillSettings }))

  ipcMain.handle('customer-display:set-till-settings', (_evt, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid settings' }
    const o = raw as Record<string, unknown>
    tillSettings = {
      enabled: o.enabled === true,
      displayId: typeof o.displayId === 'number' ? o.displayId : null,
    }
    saveTillSettings()
    syncCustomerWindow()
    return { ok: true, settings: { ...tillSettings } }
  })

  ipcMain.handle('customer-display:publish', (_evt, snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false }
    publishCustomerDisplaySnapshot(snapshot as CustomerDisplaySnapshot)
    return { ok: true }
  })

  ipcMain.handle('customer-display:test', (_evt, mode: unknown) => {
    const m = mode === 'idle' || mode === 'ready' || mode === 'cart' || mode === 'complete' ? mode : 'idle'
    const sample: CustomerDisplaySnapshot =
      m === 'cart'
        ? {
            mode: 'cart',
            storeName: 'CogniPOS',
            lines: [
              { name: 'Sample item A', quantity: 2, lineTotal: 199.0 },
              { name: 'Sample item B', quantity: 1, lineTotal: 49.5 },
            ],
            total: 248.5,
            footerText: 'All prices include VAT',
            theme: { backgroundColor: '#0f1419', accentColor: '#3b82f6' },
          }
        : m === 'complete'
          ? {
              mode: 'complete',
              storeName: 'CogniPOS',
              complete: { totalPaid: 248.5, changeDue: 1.5, paymentLabel: 'Cash', token: Date.now() },
              theme: { backgroundColor: '#0f1419', accentColor: '#3b82f6' },
            }
          : m === 'ready'
            ? {
                mode: 'ready',
                storeName: 'CogniPOS',
                theme: { backgroundColor: '#0f1419', accentColor: '#3b82f6' },
              }
            : {
                mode: 'idle',
                storeName: 'CogniPOS',
                idle: {
                  headline: 'Welcome',
                  subtext: 'Please wait to be served',
                  imageUrl: '',
                  backgroundColor: '#0f1419',
                  accentColor: '#3b82f6',
                  footerText: 'All prices include VAT',
                },
              }
    publishCustomerDisplaySnapshot(sample)
    return { ok: true }
  })
}

export function onAppReadyCustomerDisplay(): void {
  screen.on('display-added', () => syncCustomerWindow())
  screen.on('display-removed', () => syncCustomerWindow())
  if (tillSettings.enabled) createCustomerWindow()
}
