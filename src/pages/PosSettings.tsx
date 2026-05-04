import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PosShell } from '../layouts/PosShell'
import { usePosTheme } from '../theme/PosThemeContext'
import type { PosTheme } from '../theme/posTheme'
import {
  DEFAULT_PRINTER_SETTINGS,
  readPosPrinterSettings,
  writePosPrinterSettings,
  type PosPrinterSettings,
} from '../printer/posPrinterSettings'

const THEMES: { id: PosTheme; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Default register look' },
  { id: 'light', label: 'Light', hint: 'Softer, brighter colours' },
  { id: 'ubuntu', label: 'Ubuntu', hint: 'Violet, teal, and coral accents' },
  { id: 'elon', label: 'Elon', hint: 'Old Glory blue & red — bold, minimal white' },
]

export function PosSettings() {
  const { theme, setTheme } = usePosTheme()
  const [printer, setPrinter] = useState<PosPrinterSettings>(() => readPosPrinterSettings())

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

  return (
    <PosShell>
      <div className="pos-settings-page">
        <h1 className="pos-settings-title">Settings</h1>
        <p className="muted">Register options can be extended here. Store-wide configuration is in Back Office.</p>

        <section className="pos-settings-section" aria-labelledby="pos-theme-heading">
          <h2 id="pos-theme-heading" className="pos-settings-section-title">
            Appearance
          </h2>
          <p className="muted pos-settings-section-lead">Theme applies to this device only.</p>
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

        <section className="pos-settings-section" aria-labelledby="pos-printer-heading">
          <h2 id="pos-printer-heading" className="pos-settings-section-title">
            Receipt printer
          </h2>
          <p className="muted pos-settings-section-lead">Applies to this device only.</p>

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
                        : { kind: 'usb', path: '/dev/usb/lp0' },
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
                />
              </label>
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Port</span>
                <input
                  className="pos-settings-input"
                  inputMode="numeric"
                  value={String(printer.transport.port)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    updatePrinter({
                      transport: {
                        kind: 'lan',
                        host: printer.transport.kind === 'lan' ? printer.transport.host : '192.168.1.50',
                        port: Number.isFinite(n) && n > 0 ? n : 9100,
                      },
                    })
                  }}
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
                />
              </label>
              <label className="pos-settings-field">
                <span className="pos-settings-field-label">Baud rate</span>
                <input
                  className="pos-settings-input"
                  inputMode="numeric"
                  value={String(printer.transport.baudRate)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    updatePrinter({
                      transport: {
                        kind: 'serial',
                        path: printer.transport.kind === 'serial' ? printer.transport.path : '/dev/ttyS0',
                        baudRate: Number.isFinite(n) && n > 0 ? n : 38400,
                      },
                    })
                  }}
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
                value={String(printer.columns)}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  updatePrinter({ columns: Number.isFinite(n) && n >= 24 ? n : DEFAULT_PRINTER_SETTINGS.columns })
                }}
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
          </div>

          <button type="button" className="btn ghost" onClick={() => updatePrinter(DEFAULT_PRINTER_SETTINGS)}>
            Reset printer settings
          </button>
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
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Header line 2</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.headerLine2}
                onChange={(e) => updateReceiptConfig({ headerLine2: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Header line 3</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.headerLine3}
                onChange={(e) => updateReceiptConfig({ headerLine3: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Phone</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.phone}
                onChange={(e) => updateReceiptConfig({ phone: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT number</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.vatNumber}
                onChange={(e) => updateReceiptConfig({ vatNumber: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT rate %</span>
              <input
                className="pos-settings-input"
                inputMode="decimal"
                value={String(printer.receiptConfig.vatRatePct)}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  updateReceiptConfig({ vatRatePct: Number.isFinite(n) && n >= 0 ? n : 15 })
                }}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Receipt title</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.receiptTitle}
                onChange={(e) => updateReceiptConfig({ receiptTitle: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Thank you line</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.thankYouLine}
                onChange={(e) => updateReceiptConfig({ thankYouLine: e.target.value })}
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
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Slip label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.slipLabel}
                onChange={(e) => updateReceiptConfig({ slipLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">VAT label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.vatLabel}
                onChange={(e) => updateReceiptConfig({ vatLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Subtotal label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.subtotalLabel}
                onChange={(e) => updateReceiptConfig({ subtotalLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Tax total label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.taxTotalLabel}
                onChange={(e) => updateReceiptConfig({ taxTotalLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Total due label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.totalDueLabel}
                onChange={(e) => updateReceiptConfig({ totalDueLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Cash tendered label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.cashTenderedLabel}
                onChange={(e) => updateReceiptConfig({ cashTenderedLabel: e.target.value })}
              />
            </label>
            <label className="pos-settings-field">
              <span className="pos-settings-field-label">Change due label</span>
              <input
                className="pos-settings-input"
                value={printer.receiptConfig.changeDueLabel}
                onChange={(e) => updateReceiptConfig({ changeDueLabel: e.target.value })}
              />
            </label>
          </div>
        </section>

        <p className="pos-settings-back">
          <Link to="/" className="btn ghost">
            Back to register
          </Link>
        </p>
      </div>
    </PosShell>
  )
}
