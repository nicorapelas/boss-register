import { app, BrowserWindow, ipcMain, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type DisplayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type CustomerDisplayTillSettings = {
  enabled: boolean
  displayId: number | null
  /** Stable fallback when OS assigns a new display id after reboot (common on Linux). */
  displayBounds: DisplayBounds | null
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

const DEFAULT_TILL: CustomerDisplayTillSettings = {
  enabled: false,
  displayId: null,
  displayBounds: null,
}

let customerWin: BrowserWindow | null = null
let tillSettings: CustomerDisplayTillSettings = { ...DEFAULT_TILL }
let rendererDist = ''
let viteDevServerUrl: string | undefined
let preloadPath = ''
let placementRetryTimers: ReturnType<typeof setTimeout>[] = []

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'customer-display-till.json')
}

function parseDisplayId(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

function parseDisplayBounds(raw: unknown): DisplayBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const x = Number(o.x)
  const y = Number(o.y)
  const width = Number(o.width)
  const height = Number(o.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function normalizeTillSettings(raw: unknown): CustomerDisplayTillSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TILL }
  const o = raw as Record<string, unknown>
  const displayId = parseDisplayId(o.displayId)
  const displayBounds = parseDisplayBounds(o.displayBounds)
  return {
    enabled: o.enabled === true,
    displayId,
    displayBounds: displayId == null ? null : displayBounds,
  }
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
    tillSettings = normalizeTillSettings(JSON.parse(raw))
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

function boundsMatchSaved(saved: DisplayBounds, bounds: Electron.Rectangle): boolean {
  return (
    saved.x === bounds.x &&
    saved.y === bounds.y &&
    saved.width === bounds.width &&
    saved.height === bounds.height
  )
}

function pickDisplay(): Electron.Display | undefined {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) return undefined

  if (tillSettings.displayId != null) {
    const byId = displays.find((d) => d.id === tillSettings.displayId)
    if (byId) return byId
  }

  if (tillSettings.displayBounds) {
    const byBounds = displays.find((d) => boundsMatchSaved(tillSettings.displayBounds!, d.bounds))
    if (byBounds) return byBounds
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

function placeCustomerWindowOnDisplay(display: Electron.Display): void {
  if (!customerWin || customerWin.isDestroyed()) return
  const { x, y, width, height } = display.bounds
  if (customerWin.isFullScreen()) customerWin.setFullScreen(false)
  customerWin.setBounds({ x, y, width, height })
  customerWin.setFullScreen(true)
  customerWin.show()
}

function createCustomerWindow(): void {
  if (!tillSettings.enabled) return
  const display = pickDisplay()
  if (!display) return

  if (customerWin && !customerWin.isDestroyed()) {
    placeCustomerWindowOnDisplay(display)
    return
  }

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
    if (customerWin && !customerWin.isDestroyed()) {
      placeCustomerWindowOnDisplay(display)
    }
  })
}

function destroyCustomerWindow(): void {
  if (customerWin && !customerWin.isDestroyed()) {
    customerWin.close()
  }
  customerWin = null
}

function clearPlacementRetries(): void {
  for (const t of placementRetryTimers) clearTimeout(t)
  placementRetryTimers = []
}

function scheduleCustomerDisplayPlacement(): void {
  clearPlacementRetries()
  if (!tillSettings.enabled) return
  const tryPlace = () => createCustomerWindow()
  tryPlace()
  placementRetryTimers.push(setTimeout(tryPlace, 800))
  placementRetryTimers.push(setTimeout(tryPlace, 2500))
}

function syncCustomerWindow(): void {
  if (tillSettings.enabled) scheduleCustomerDisplayPlacement()
  else {
    clearPlacementRetries()
    destroyCustomerWindow()
  }
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
    tillSettings = normalizeTillSettings(raw)
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
  if (tillSettings.enabled) scheduleCustomerDisplayPlacement()
}
