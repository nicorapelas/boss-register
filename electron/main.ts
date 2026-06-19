import { app, BrowserWindow, ipcMain, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { registerAuthIpc } from './auth-storage'
import { initCustomerDisplayModule, onAppReadyCustomerDisplay, setCustomerDisplayMainWindowRef } from './customer-display'
import { registerOfflineIpc } from './offline-storage'
import { buildReceiptEscPos, drawerKick, sendEscPosToPrinter, type PrintDensity, type PrinterTransport, type ReceiptPayload } from './pos-printer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

const MEDIA_PERMISSIONS = new Set(['media', 'camera', 'microphone', 'videoCapture', 'audioCapture'])

function allowMediaPermission(permission: string): boolean {
  return MEDIA_PERMISSIONS.has(permission)
}

if (process.platform === 'linux') {
  // Ubuntu 22.04+ / Lubuntu: PipeWire camera path for Chromium getUserMedia.
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
}

registerAuthIpc()
registerOfflineIpc()
initCustomerDisplayModule({
  rendererDist: RENDERER_DIST,
  viteDevServerUrl: VITE_DEV_SERVER_URL,
  preloadPath: path.join(__dirname, 'preload.mjs'),
})

ipcMain.handle('app:quit', () => {
  app.quit()
})

function parseTransport(raw: unknown): PrinterTransport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'usb' && typeof r.path === 'string' && r.path.length > 0) return { kind: 'usb', path: r.path }
  if (
    r.kind === 'lan' &&
    typeof r.host === 'string' &&
    r.host.length > 0 &&
    typeof r.port === 'number' &&
    Number.isFinite(r.port) &&
    r.port > 0
  ) {
    return { kind: 'lan', host: r.host, port: r.port }
  }
  if (
    r.kind === 'serial' &&
    typeof r.path === 'string' &&
    r.path.length > 0 &&
    typeof r.baudRate === 'number' &&
    Number.isFinite(r.baudRate) &&
    r.baudRate > 0
  ) {
    return { kind: 'serial', path: r.path, baudRate: r.baudRate }
  }
  return null
}

ipcMain.handle('pos:drawer:kick', async (_evt, args: { transport: unknown } | undefined) => {
  try {
    const transport = parseTransport(args?.transport)
    if (!transport) return { ok: false, error: 'Invalid printer transport' }
    await sendEscPosToPrinter(transport, drawerKick())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Drawer kick failed' }
  }
})

function parsePrintDensity(value: unknown): PrintDensity | undefined {
  return value === 'light' || value === 'normal' || value === 'dark' ? value : undefined
}

ipcMain.handle(
  'pos:receipt:print',
  async (
    _evt,
    args:
      | {
          transport: unknown
          receipt: unknown
          columns?: unknown
          cut?: unknown
          printDensity?: unknown
          lineSpacing?: unknown
          headerBold?: unknown
        }
      | undefined,
  ) => {
    try {
      const transport = parseTransport(args?.transport)
      if (!transport) return { ok: false, error: 'Invalid printer transport' }
      if (!args?.receipt || typeof args.receipt !== 'object') return { ok: false, error: 'Invalid receipt payload' }
      const receipt = args.receipt as ReceiptPayload
      const columns = typeof args.columns === 'number' && Number.isFinite(args.columns) ? args.columns : undefined
      const cut = typeof args.cut === 'boolean' ? args.cut : undefined
      const printDensity = parsePrintDensity(args?.printDensity)
      const lineSpacing =
        typeof args.lineSpacing === 'number' && Number.isFinite(args.lineSpacing) ? args.lineSpacing : undefined
      const headerBold = typeof args.headerBold === 'boolean' ? args.headerBold : undefined
      const now = new Date().toISOString()
      console.log(
        `[pos-print] ${now} request kind=${transport.kind} columns=${columns ?? 'default'} cut=${cut ?? 'default'} density=${printDensity ?? 'default'} receiptNo=${receipt.receiptNumber ?? 'n/a'} lines=${Array.isArray(receipt.lines) ? receipt.lines.length : 0}`,
      )
      const bytes = buildReceiptEscPos(receipt, { columns, cut, printDensity, lineSpacing, headerBold })
      console.log(`[pos-print] ${now} encodedBytes=${bytes.length}`)
      await sendEscPosToPrinter(transport, bytes)
      console.log(`[pos-print] ${now} print-success kind=${transport.kind}`)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Receipt print failed'
      console.error(`[pos-print] ${new Date().toISOString()} print-error ${msg}`)
      return { ok: false, error: msg }
    }
  },
)

// Back-compat for existing UI button.
ipcMain.handle('pos:drawer:open', async (_evt, args: { transport: unknown } | undefined) => {
  try {
    const transport = parseTransport(args?.transport)
    if (!transport) return { ok: false, error: 'Invalid printer transport' }
    await sendEscPosToPrinter(transport, drawerKick())
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Drawer kick failed' }
  }
})

let win: BrowserWindow | null

/** Native title bar hidden; keep standard controls where Electron supports them. */
function browserShellWindowOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  const opts: Partial<Electron.BrowserWindowConstructorOptions> = {
    frame: false,
  }
  if (process.platform === 'darwin') {
    opts.titleBarStyle = 'hidden'
    opts.trafficLightPosition = { x: 14, y: 14 }
  } else if (process.platform === 'win32') {
    opts.titleBarOverlay = {
      color: '#181818',
      symbolColor: '#f2f2f2',
      height: 40,
    }
  }
  return opts
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    fullscreen: true,
    backgroundColor: '#350d66',
    icon: path.join(process.env.APP_ROOT, 'src/assets/appIcon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
    ...browserShellWindowOptions(),
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
    win?.focus()
    win?.webContents.focus()
  })

  win.on('focus', () => {
    if (win && !win.isDestroyed()) win.webContents.focus()
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
  setCustomerDisplayMainWindowRef(() => win)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMediaPermission(permission))
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMediaPermission(permission))
  })
  createWindow()
  onAppReadyCustomerDisplay()
})
