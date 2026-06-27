import { useCallback, useEffect, useState } from 'react'
import { ScreenKeyboard } from '../components/ScreenKeyboard'
import { usePosSettingsScreenKeyboard } from '../settings/usePosSettingsScreenKeyboard'
import type {
  CustomerDisplayBounds,
  CustomerDisplayDriver,
  CustomerDisplayLineDevice,
  CustomerDisplayTillSettings,
} from '../customerDisplay/electron'
import { usePosTheme } from '../theme/PosThemeContext'
import type { PosTheme } from '../theme/posTheme'
import { readPosKeySoundEnabled, writePosKeySoundEnabled } from '../audio/posKeySound'
import {
  defaultPrinterSettingsForTill,
  defaultUsbPrinterPath,
  printerProfileLabel,
  readPosPrinterSettings,
  receiptPrintOpts,
  resetPrinterLayoutKeepTransport,
  writePosPrinterSettings,
  type PosPrinterSettings,
  type PrintDensity,
} from '../printer/posPrinterSettings'

const THEMES: { id: PosTheme; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Default register look' },
  { id: 'light', label: 'Light', hint: 'Softer, brighter colours' },
  { id: 'ubuntu', label: 'Ubuntu', hint: 'Violet, teal, and coral accents' },
  { id: 'elon', label: 'Elon', hint: 'Old Glory blue & red — bold, minimal white' },
  { id: 'lego', label: 'Bricks', hint: 'Classic toy-brick reds, yellows & blues on a deep base' },
  { id: 'jacobs', label: 'Jacobs', hint: 'Blue header, white panels, blue keypad — tricolor stripes' },
  { id: 'cosmic', label: 'Cosmic', hint: 'Pop!_OS Cosmic — charcoal base with cyan & indigo accents' },
]

export function PosSettingsPanel({ onClose }: { onClose: () => void }) {
  const { theme, setTheme } = usePosTheme()
  const [keySoundEnabled, setKeySoundEnabled] = useState(() => readPosKeySoundEnabled())
  const [printer, setPrinter] = useState<PosPrinterSettings>(() => readPosPrinterSettings())
  const [printerNotice, setPrinterNotice] = useState<string | null>(null)
  const [cdEnabled, setCdEnabled] = useState(false)
  const [cdDriver, setCdDriver] = useState<CustomerDisplayDriver>('monitor')
  const [cdDisplayId, setCdDisplayId] = useState<number | null>(null)
  const [cdDisplayBounds, setCdDisplayBounds] = useState<CustomerDisplayBounds | null>(null)
  const [cdLineDisplayPath, setCdLineDisplayPath] = useState<string | null>(null)
  const [cdDisplays, setCdDisplays] = useState<
    Array<{ id: number; label: string; primary: boolean; bounds: CustomerDisplayBounds }>
  >([])
  const [cdLineDisplays, setCdLineDisplays] = useState<CustomerDisplayLineDevice[]>([])
  const [cdNotice, setCdNotice] = useState<string | null>(null)

  const applyCdSettings = useCallback((s: CustomerDisplayTillSettings) => {
    setCdEnabled(s.enabled)
    setCdDriver(s.driver ?? 'monitor')
    setCdDisplayId(s.displayId)
    setCdDisplayBounds(s.displayBounds)
    setCdLineDisplayPath(s.lineDisplayPath)
  }, [])

  const showLineDisplayDebugNotice = useCallback(async (prefix: string) => {
    const api = window.electronCustomerDisplay
    if (!api?.getLineDisplayDebug) {
      setCdNotice(prefix)
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 700))
    const dbg = await api.getLineDisplayDebug()
    const row1 = dbg.mappedLine1.trimEnd()
    const row2 = dbg.mappedLine2.trimEnd()
    setCdNotice(
      `${prefix} · driver ${dbg.driverVersion} · mode ${dbg.lastSnapshotMode ?? 'none'} · lines ${dbg.lastLineCount} · mapped "${row1}" / "${row2}"` +
        (dbg.lastError ? ` · error: ${dbg.lastError}` : ''),
    )
  }, [])

  const persistCdSettings = useCallback(
    (patch: Partial<CustomerDisplayTillSettings>) => {
      if (!window.electronCustomerDisplay) return
      const driver = patch.driver ?? cdDriver
      const payload: CustomerDisplayTillSettings = {
        enabled: patch.enabled ?? cdEnabled,
        driver,
        displayId: driver === 'monitor' ? (patch.displayId !== undefined ? patch.displayId : cdDisplayId) : null,
        displayBounds:
          driver === 'monitor'
            ? patch.displayBounds !== undefined
              ? patch.displayBounds
              : cdDisplayBounds
            : null,
        lineDisplayPath:
          driver === 'ncr-2x20'
            ? patch.lineDisplayPath !== undefined
              ? patch.lineDisplayPath
              : cdLineDisplayPath
            : null,
      }
      if (payload.displayId == null) payload.displayBounds = null
      void window.electronCustomerDisplay.setTillSettings(payload).then((r) => {
        if (r.settings) applyCdSettings(r.settings)
      })
    },
    [applyCdSettings, cdDisplayBounds, cdDisplayId, cdDriver, cdEnabled, cdLineDisplayPath],
  )

  useEffect(() => {
    if (!window.electronCustomerDisplay) return
    void window.electronCustomerDisplay.getTillSettings().then(applyCdSettings)
    void window.electronCustomerDisplay.listDisplays().then((list) => setCdDisplays(list))
    void window.electronCustomerDisplay.listLineDisplays().then((list) => setCdLineDisplays(list))
  }, [applyCdSettings])

  useEffect(() => {
    if (!window.electronCustomerDisplay || cdDisplayBounds == null) return
    const match = cdDisplays.find(
      (d) =>
        d.bounds.x === cdDisplayBounds.x &&
        d.bounds.y === cdDisplayBounds.y &&
        d.bounds.width === cdDisplayBounds.width &&
        d.bounds.height === cdDisplayBounds.height,
    )
    if (!match || match.id === cdDisplayId) return
    persistCdSettings({ displayId: match.id, displayBounds: match.bounds })
  }, [cdDisplays, cdDisplayBounds, cdDisplayId, persistCdSettings])

  const savedDisplayMissing =
    cdDisplayId != null && !cdDisplays.some((d) => d.id === cdDisplayId)

  const updatePrinter = (patch: Partial<PosPrinterSettings>) => {
    setPrinter((prev) => {
      const next = { ...prev, ...patch }
      writePosPrinterSettings(next)
      return next
    })
  }
  const updateReceiptConfig = (patch: Partial<PosPrinterSettings['receiptConfig']>) => {
    setPrinter((prev) => {
      const next: PosPrinterSettings = {
        ...prev,
        receiptConfig: { ...prev.receiptConfig, ...patch },
      }
      writePosPrinterSettings(next)
      return next
    })
  }

  const settingsKb = usePosSettingsScreenKeyboard(printer, updatePrinter, updateReceiptConfig)
  const kb = settingsKb.fieldKbHandlers
  const fieldValue = settingsKb.displayValue
  const onFieldInput = settingsKb.setFieldDraft

  async function testReceiptPrint() {
    setPrinterNotice(null)
    if (!window.electronPos) {
      setPrinterNotice('Print test requires the CogniPOS desktop app.')
      return
    }
    const cfg = printer.receiptConfig
    const r = await window.electronPos.printReceipt(
      printer.transport,
      {
        headerLines: [cfg.headerLine1, 'PRINT TEST'],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: '--TEST SLIP--',
        receiptNumber: 'TEST-001',
        timestampIso: new Date().toISOString(),
        paymentLabel: 'Test',
        lines: [{ qty: 1, name: 'Sample line for density check', unitPrice: 12.5, lineTotal: 12.5 }],
        subtotal: 12.5,
        total: 12.5,
        thankYouLine: cfg.thankYouLine,
      },
      receiptPrintOpts(printer),
    )
    setPrinterNotice(r.ok ? 'Test receipt sent to printer.' : (r.error ?? 'Print test failed.'))
  }

  return (
    <div className={`pos-settings-page${settingsKb.open ? ' pos-settings-page--with-keyboard' : ''}`}>
        <h1 className="pos-settings-title">Settings</h1>
        <p className="muted">Register options can be extended here. Store-wide configuration is in Back Office.</p>

        <section className="pos-settings-section" aria-labelledby="pos-theme-heading">
          <h2 id="pos-theme-heading" className="pos-settings-section-title">
            Appearance
          </h2>
          <p className="muted pos-settings-section-lead">
            Theme applies to this till only — register UI and the customer-facing display use matching colours.
          </p>
          <div className="pos-theme-selector" role="radiogroup" aria-label="Register theme">
            {THEMES.map((t) => {
              const selected = theme === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`pos-theme-option${selected ? ' pos-theme-option--selected' : ''}`}
                  onClick={() => setTheme(t.id)}
                >
                  <span className="pos-theme-option-label">{t.label}</span>
                  <span className="pos-theme-option-hint muted">{t.hint}</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="pos-settings-section" aria-labelledby="pos-sound-heading">
          <h2 id="pos-sound-heading" className="pos-settings-section-title">
            Sound
          </h2>
          <p className="muted pos-settings-section-lead">Tap feedback for buttons and the hardware keypad when SKU entry is active.</p>
          <div className="pos-settings-row">
            <label className="pos-settings-check">
              <input
                type="checkbox"
                checked={keySoundEnabled}
                onChange={(e) => {
                  const on = e.target.checked
                  writePosKeySoundEnabled(on)
                  setKeySoundEnabled(on)
                }}
              />
              <span>Button &amp; keypad sounds</span>
            </label>
          </div>
        </section>

        <section className="pos-settings-section" aria-labelledby="pos-printer-heading">
          <h2 id="pos-printer-heading" className="pos-settings-section-title">
            Receipt printer
          </h2>
          <p className="muted pos-settings-section-lead">
            Applies to this device only. This till: <strong>{printerProfileLabel()}</strong>.
            <strong> Reset printer settings</strong> restores connection defaults for this hardware;
            <strong> Reset receipt layout</strong> keeps your connection and resets columns, density, and header text.
          </p>

          <div className="pos-settings-row">
            <label className="pos-settings-check">
              <input
                type="checkbox"
                checked={printer.autoPrintReceipt}
                onChange={(e) => updatePrinter({ autoPrintReceipt: e.target.checked })}
              />
              <span>Auto print receipt after sale</span>
            </label>
          </div>
          <div className="pos-settings-row">
            <label className="pos-settings-check">
              <input
                type="checkbox"
                checked={printer.autoOpenDrawer}
                onChange={(e) => updatePrinter({ autoOpenDrawer: e.target.checked })}
              />
              <span>Auto open cash drawer (any tender)</span>
            </label>
          </div>

          <div className="pos-settings-row">
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Connection</span>
              <select
                className="pos-settings-select"
                value={printer.transport.kind}
                onChange={(e) => {
                  const kind = e.target.value === 'lan' ? 'lan' : e.target.value === 'serial' ? 'serial' : 'usb'
                  updatePrinter({
                    transport:
                      kind === 'lan'
                        ? { kind: 'lan', host: '192.168.1.50', port: 9100 }
                        : kind === 'serial'
                          ? { kind: 'serial', path: '/dev/ttyS0', baudRate: 38400 }
                        : { kind: 'usb', path: defaultUsbPrinterPath() },
                  })
                }}
              >
                <option value="usb">USB</option>
                <option value="lan">LAN (TCP 9100)</option>
                <option value="serial">Serial (ESC/POS)</option>
              </select>
            </label>
          </div>

          {printer.transport.kind === 'usb' ? (
            <div className="pos-settings-row">
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">USB device</span>
                <input
                  className="pos-settings-input"
                  value={printer.transport.path}
                  onChange={(e) => updatePrinter({ transport: { kind: 'usb', path: e.target.value } })}
                  {...kb('usbPath')}
                />
              </label>
              <p className="muted pos-settings-hint">
                On Linux you may need permissions for this device (usually group <code>lp</code>).
              </p>
            </div>
          ) : printer.transport.kind === 'lan' ? (
            <div className="pos-settings-row pos-settings-row-grid">
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Host</span>
                <input
                  className="pos-settings-input"
                  value={printer.transport.host}
                  onChange={(e) =>
                    updatePrinter({
                      transport: {
                        kind: 'lan',
                        host: e.target.value,
                        port: printer.transport.kind === 'lan' ? printer.transport.port : 9100,
                      },
                    })
                  }
                  {...kb('lanHost')}
                />
              </label>
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Port</span>
                <input
                  className="pos-settings-input"
                  inputMode="numeric"
                  value={fieldValue('lanPort')}
                  onChange={(e) => onFieldInput('lanPort', e.target.value)}
                  {...kb('lanPort', 'numeric')}
                />
              </label>
              <p className="muted pos-settings-hint pos-settings-hint-span">
                Most ESC/POS printers listen on TCP port <code>9100</code>.
              </p>
            </div>
          ) : (
            <div className="pos-settings-row pos-settings-row-grid">
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Serial device</span>
                <input
                  className="pos-settings-input"
                  value={printer.transport.path}
                  onChange={(e) =>
                    updatePrinter({
                      transport: {
                        kind: 'serial',
                        path: e.target.value,
                        baudRate: printer.transport.kind === 'serial' ? printer.transport.baudRate : 38400,
                      },
                    })
                  }
                  {...kb('serialPath')}
                />
              </label>
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Baud rate</span>
                <input
                  className="pos-settings-input"
                  inputMode="numeric"
                  value={fieldValue('serialBaud')}
                  onChange={(e) => onFieldInput('serialBaud', e.target.value)}
                  {...kb('serialBaud', 'numeric')}
                />
              </label>
              <p className="muted pos-settings-hint pos-settings-hint-span">
                Posiflex serial adapters commonly use <code>/dev/ttyS0</code> at <code>38400</code> baud.
              </p>
            </div>
          )}

          <div className="pos-settings-row pos-settings-row-grid">
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Columns (80mm)</span>
              <input
                className="pos-settings-input"
                inputMode="numeric"
                value={fieldValue('columns')}
                onChange={(e) => onFieldInput('columns', e.target.value)}
                {...kb('columns', 'numeric')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Print density</span>
              <select
                className="pos-settings-input"
                value={printer.printDensity}
                onChange={(e) => updatePrinter({ printDensity: e.target.value as PrintDensity })}
              >
                <option value="light">Light (less smear)</option>
                <option value="normal">Normal</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Line spacing</span>
              <input
                className="pos-settings-input"
                inputMode="numeric"
                value={fieldValue('lineSpacing')}
                onChange={(e) => onFieldInput('lineSpacing', e.target.value)}
                {...kb('lineSpacing', 'numeric')}
              />
            </label>
            <label className="pos-settings-check pos-settings-check-inline">
              <input
                type="checkbox"
                checked={printer.cut}
                onChange={(e) => updatePrinter({ cut: e.target.checked })}
              />
              <span>Cut paper</span>
            </label>
            <label className="pos-settings-check pos-settings-check-inline">
              <input
                type="checkbox"
                checked={printer.headerBold}
                onChange={(e) => updatePrinter({ headerBold: e.target.checked })}
              />
              <span>Bold store header</span>
            </label>
            <p className="muted pos-settings-hint pos-settings-hint-span">
              Partner RP-630 / thermal printers: try <strong>Light</strong> density, line spacing{' '}
              <code>40</code>, and turn off bold header if text looks smudged. Cash drawer plugs into the
              printer&apos;s drawer port.
            </p>
          </div>

          <div className="pos-settings-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={() => void testReceiptPrint()}>
              Print test receipt
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => updatePrinter(defaultPrinterSettingsForTill())}
            >
              Reset printer settings
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => updatePrinter(resetPrinterLayoutKeepTransport(printer))}
            >
              Reset receipt layout
            </button>
          </div>
          {printerNotice ? <p className="muted">{printerNotice}</p> : null}
        </section>

        <section className="pos-settings-section" aria-labelledby="pos-receipt-layout-heading">
          <h2 id="pos-receipt-layout-heading" className="pos-settings-section-title">
            Receipt layout
          </h2>
          <p className="muted pos-settings-section-lead">Header text and labels used on printed receipts.</p>

          <div className="pos-settings-row pos-settings-row-grid">
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Header line 1</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.headerLine1}
                onChange={(e) => updateReceiptConfig({ headerLine1: e.target.value })}
                {...kb('headerLine1')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Header line 2</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.headerLine2}
                onChange={(e) => updateReceiptConfig({ headerLine2: e.target.value })}
                {...kb('headerLine2')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Header line 3</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.headerLine3}
                onChange={(e) => updateReceiptConfig({ headerLine3: e.target.value })}
                {...kb('headerLine3')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Phone</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.phone}
                onChange={(e) => updateReceiptConfig({ phone: e.target.value })}
                {...kb('phone', 'tel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT number</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.vatNumber}
                onChange={(e) => updateReceiptConfig({ vatNumber: e.target.value })}
                {...kb('vatNumber')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT rate %</span>
              <input
                className="pos-settings-input"
                inputMode="decimal"
                value={fieldValue('vatRatePct')}
                onChange={(e) => onFieldInput('vatRatePct', e.target.value)}
                {...kb('vatRatePct', 'decimal')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Receipt title</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.receiptTitle}
                onChange={(e) => updateReceiptConfig({ receiptTitle: e.target.value })}
                {...kb('receiptTitle')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Thank you line</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.thankYouLine}
                onChange={(e) => updateReceiptConfig({ thankYouLine: e.target.value })}
                {...kb('thankYouLine')}
              />
            </label>
          </div>

          <div className="pos-settings-row pos-settings-row-grid">
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Till label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.tillLabel}
                onChange={(e) => updateReceiptConfig({ tillLabel: e.target.value })}
                {...kb('tillLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Slip label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.slipLabel}
                onChange={(e) => updateReceiptConfig({ slipLabel: e.target.value })}
                {...kb('slipLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.vatLabel}
                onChange={(e) => updateReceiptConfig({ vatLabel: e.target.value })}
                {...kb('vatLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Subtotal label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.subtotalLabel}
                onChange={(e) => updateReceiptConfig({ subtotalLabel: e.target.value })}
                {...kb('subtotalLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Tax total label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.taxTotalLabel}
                onChange={(e) => updateReceiptConfig({ taxTotalLabel: e.target.value })}
                {...kb('taxTotalLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Total due label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.totalDueLabel}
                onChange={(e) => updateReceiptConfig({ totalDueLabel: e.target.value })}
                {...kb('totalDueLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Cash tendered label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.cashTenderedLabel}
                onChange={(e) => updateReceiptConfig({ cashTenderedLabel: e.target.value })}
                {...kb('cashTenderedLabel')}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Change due label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.changeDueLabel}
                onChange={(e) => updateReceiptConfig({ changeDueLabel: e.target.value })}
                {...kb('changeDueLabel')}
              />
            </label>
          </div>
        </section>

        {window.electronCustomerDisplay ? (
          <section className="pos-settings-section" aria-labelledby="pos-cd-heading">
            <h2 id="pos-cd-heading" className="pos-settings-section-title">
              Customer display
            </h2>
            <p className="muted pos-settings-section-lead">
              Customer-facing output on this till. Use a second monitor for the full graphical display, or the
              built-in NCR 2×20 line display (text only). Idle content for the graphical display is configured in
              Back Office.
            </p>
            {cdNotice ? <p className="success">{cdNotice}</p> : null}
            <div className="pos-settings-row">
              <label className="pos-settings-check">
                <input
                  type="checkbox"
                  checked={cdEnabled}
                  onChange={(e) => {
                    const enabled = e.target.checked
                    setCdEnabled(enabled)
                    persistCdSettings({ enabled })
                  }}
                />
                <span>Enable customer display on this till</span>
              </label>
            </div>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Display type</span>
              <select
                className="pos-settings-input"
                value={cdDriver}
                onChange={(e) => {
                  const driver = e.target.value as CustomerDisplayDriver
                  setCdDriver(driver)
                  persistCdSettings({
                    driver,
                    displayId: driver === 'monitor' ? cdDisplayId : null,
                    displayBounds: driver === 'monitor' ? cdDisplayBounds : null,
                    lineDisplayPath: driver === 'ncr-2x20' ? cdLineDisplayPath : null,
                  })
                }}
              >
                <option value="monitor">Second monitor (graphical)</option>
                <option value="ncr-2x20">NCR 2×20 line display (integrated)</option>
              </select>
            </label>
            {cdDriver === 'monitor' ? (
              cdDisplays.length > 0 ? (
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Target monitor</span>
                <select
                  className="pos-settings-input"
                  value={cdDisplayId == null ? '' : String(cdDisplayId)}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') {
                      setCdDisplayId(null)
                      setCdDisplayBounds(null)
                      persistCdSettings({ displayId: null, displayBounds: null })
                      return
                    }
                    const displayId = Number(v)
                    const picked = cdDisplays.find((d) => d.id === displayId)
                    const displayBounds = picked?.bounds ?? null
                    setCdDisplayId(displayId)
                    setCdDisplayBounds(displayBounds)
                    persistCdSettings({ displayId, displayBounds })
                  }}
                >
                  <option value="">Automatic (first external, else primary)</option>
                  {savedDisplayMissing ? (
                    <option value={String(cdDisplayId)}>
                      Saved monitor (id {cdDisplayId}
                      {cdDisplayBounds
                        ? ` · ${cdDisplayBounds.width}×${cdDisplayBounds.height} @ ${cdDisplayBounds.x},${cdDisplayBounds.y}`
                        : ''}
                      )
                    </option>
                  ) : null}
                  {cdDisplays.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.label}
                      {d.primary ? ' (primary)' : ''}
                      {` · ${d.bounds.width}×${d.bounds.height}`}
                    </option>
                  ))}
                </select>
                {savedDisplayMissing ? (
                  <p className="muted pos-settings-hint">
                    Saved monitor not detected by id (common after reboot). Placement uses saved position if the
                    screen layout is unchanged — re-select the monitor once to refresh.
                  </p>
                ) : null}
              </label>
              ) : (
                <p className="muted">No displays reported — connect a second monitor and reopen settings.</p>
              )
            ) : (
              <>
                {cdLineDisplays.length > 0 ? (
                  <label className="pos-settings-field">
                    <span className="pos-settings-field-label">Line display device</span>
                    <select
                      className="pos-settings-input"
                      value={cdLineDisplayPath ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        const lineDisplayPath = v === '' ? null : v
                        setCdLineDisplayPath(lineDisplayPath)
                        persistCdSettings({ lineDisplayPath })
                      }}
                    >
                      <option value="">Automatic (NCR 0404:035f)</option>
                      {cdLineDisplays.map((d) => (
                        <option key={d.path} value={d.path}>
                          {d.label} — {d.path}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="muted pos-settings-hint">
                    NCR line display not detected on USB. Check the cable and install the udev rule (deploy script
                    does this on NCR). Replug USB or reboot after installing rules.
                  </p>
                )}
                <div className="pos-settings-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      void window.electronCustomerDisplay?.testLineDisplay().then((r) => {
                        if (r.ok) {
                          void showLineDisplayDebugNotice(
                            `Line display test OK${r.path ? ` (${r.path})` : ''} — expect "BYTE MODE drv6" / "BYTE MODE ROW 2!!!"`,
                          )
                        } else setCdNotice(r.error ?? 'Line display test failed')
                      })
                    }}
                  >
                    Test line display
                  </button>
                  {(['idle', 'ready', 'cart', 'complete'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        void window.electronCustomerDisplay?.test(mode).then(() =>
                          showLineDisplayDebugNotice(`Test sent: ${mode}`),
                        )
                      }}
                    >
                      Test {mode}
                    </button>
                  ))}
                </div>
                <p className="muted pos-settings-hint">
                  Each test redraws the pole display (erase + rewrite). Rapid clicks queue updates and may flicker
                  until the queue finishes — normal sales use is much quieter.
                </p>
              </>
            )}
            {cdDriver === 'monitor' ? (
            <div className="pos-settings-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              {(['idle', 'ready', 'cart', 'complete'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    void window.electronCustomerDisplay?.test(mode).then(() =>
                      setCdNotice(`Test sent: ${mode}`),
                    )
                  }}
                >
                  Test {mode}
                </button>
              ))}
            </div>
            ) : null}
          </section>
        ) : null}

        <ScreenKeyboard
          visible={settingsKb.open}
          layout={settingsKb.layout}
          className="open-tabs-screen-keyboard pos-settings-screen-keyboard"
          onAction={settingsKb.onAction}
        />

        <p className="pos-settings-back">
          <button type="button" className="btn ghost" onClick={onClose}>
            Back to register
          </button>
        </p>
      </div>
  )
}
