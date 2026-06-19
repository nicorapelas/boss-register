import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'
import type { ScreenKeyboardAction, ScreenKeyboardProps } from '../components/ScreenKeyboard'
import {
  DEFAULT_PRINTER_SETTINGS,
  type PosPrinterSettings,
} from '../printer/posPrinterSettings'

export type SettingsKbField =
  | 'usbPath'
  | 'lanHost'
  | 'lanPort'
  | 'serialPath'
  | 'serialBaud'
  | 'columns'
  | 'lineSpacing'
  | 'headerLine1'
  | 'headerLine2'
  | 'headerLine3'
  | 'phone'
  | 'vatNumber'
  | 'vatRatePct'
  | 'receiptTitle'
  | 'thankYouLine'
  | 'tillLabel'
  | 'slipLabel'
  | 'vatLabel'
  | 'subtotalLabel'
  | 'taxTotalLabel'
  | 'totalDueLabel'
  | 'cashTenderedLabel'
  | 'changeDueLabel'

type KbLayout = NonNullable<ScreenKeyboardProps['layout']>

const NUMERIC_FIELDS = new Set<SettingsKbField>([
  'lanPort',
  'serialBaud',
  'columns',
  'lineSpacing',
  'vatRatePct',
])

function fieldValue(field: SettingsKbField, printer: PosPrinterSettings): string {
  const c = printer.receiptConfig
  switch (field) {
    case 'usbPath':
      return printer.transport.kind === 'usb' ? printer.transport.path : ''
    case 'lanHost':
      return printer.transport.kind === 'lan' ? printer.transport.host : ''
    case 'lanPort':
      return printer.transport.kind === 'lan' ? String(printer.transport.port) : ''
    case 'serialPath':
      return printer.transport.kind === 'serial' ? printer.transport.path : ''
    case 'serialBaud':
      return printer.transport.kind === 'serial' ? String(printer.transport.baudRate) : ''
    case 'columns':
      return String(printer.columns)
    case 'lineSpacing':
      return String(printer.lineSpacing)
    case 'headerLine1':
      return c.headerLine1
    case 'headerLine2':
      return c.headerLine2
    case 'headerLine3':
      return c.headerLine3
    case 'phone':
      return c.phone
    case 'vatNumber':
      return c.vatNumber
    case 'vatRatePct':
      return String(c.vatRatePct)
    case 'receiptTitle':
      return c.receiptTitle
    case 'thankYouLine':
      return c.thankYouLine
    case 'tillLabel':
      return c.tillLabel
    case 'slipLabel':
      return c.slipLabel
    case 'vatLabel':
      return c.vatLabel
    case 'subtotalLabel':
      return c.subtotalLabel
    case 'taxTotalLabel':
      return c.taxTotalLabel
    case 'totalDueLabel':
      return c.totalDueLabel
    case 'cashTenderedLabel':
      return c.cashTenderedLabel
    case 'changeDueLabel':
      return c.changeDueLabel
    default:
      return ''
  }
}

function commitFieldDraft(
  field: SettingsKbField,
  draft: string,
  printer: PosPrinterSettings,
  updatePrinter: (patch: Partial<PosPrinterSettings>) => void,
  updateReceiptConfig: (patch: Partial<PosPrinterSettings['receiptConfig']>) => void,
) {
  switch (field) {
    case 'columns': {
      const n = Number(draft)
      if (!Number.isFinite(n) || n < 24) {
        updatePrinter({ columns: DEFAULT_PRINTER_SETTINGS.columns })
      } else {
        updatePrinter({ columns: n })
      }
      break
    }
    case 'lineSpacing': {
      const n = Number(draft)
      if (!Number.isFinite(n) || n < 20 || n > 64) {
        updatePrinter({ lineSpacing: DEFAULT_PRINTER_SETTINGS.lineSpacing })
      } else {
        updatePrinter({ lineSpacing: n })
      }
      break
    }
    case 'lanPort': {
      const n = Number(draft)
      if (printer.transport.kind !== 'lan') break
      if (!Number.isFinite(n) || n <= 0) {
        updatePrinter({ transport: { kind: 'lan', host: printer.transport.host, port: 9100 } })
      } else {
        updatePrinter({ transport: { kind: 'lan', host: printer.transport.host, port: n } })
      }
      break
    }
    case 'serialBaud': {
      const n = Number(draft)
      if (printer.transport.kind !== 'serial') break
      if (!Number.isFinite(n) || n <= 0) {
        updatePrinter({
          transport: { kind: 'serial', path: printer.transport.path, baudRate: 38400 },
        })
      } else {
        updatePrinter({
          transport: { kind: 'serial', path: printer.transport.path, baudRate: n },
        })
      }
      break
    }
    case 'vatRatePct': {
      const n = Number(draft)
      if (!Number.isFinite(n) || n < 0) {
        updateReceiptConfig({ vatRatePct: 15 })
      } else {
        updateReceiptConfig({ vatRatePct: n })
      }
      break
    }
    default:
      break
  }
}

export function usePosSettingsScreenKeyboard(
  printer: PosPrinterSettings,
  updatePrinter: (patch: Partial<PosPrinterSettings>) => void,
  updateReceiptConfig: (patch: Partial<PosPrinterSettings['receiptConfig']>) => void,
) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<KbLayout>('full')
  const [activeDraft, setActiveDraft] = useState<string | null>(null)
  const fieldRef = useRef<SettingsKbField | null>(null)
  const activeInputRef = useRef<HTMLInputElement | null>(null)
  const blurTimerRef = useRef<number | null>(null)
  const draftRef = useRef<string | null>(null)
  const printerRef = useRef(printer)
  printerRef.current = printer

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }
  }, [])

  const cancelBlurHide = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
  }, [])

  const clearDraft = useCallback(() => {
    setActiveDraft(null)
    draftRef.current = null
    fieldRef.current = null
  }, [])

  const applyFieldString = useCallback(
    (field: SettingsKbField, value: string) => {
      const p = printerRef.current
      if (value === '' && NUMERIC_FIELDS.has(field)) return

      switch (field) {
        case 'usbPath':
          updatePrinter({ transport: { kind: 'usb', path: value } })
          return
        case 'lanHost':
          updatePrinter({
            transport: {
              kind: 'lan',
              host: value,
              port: p.transport.kind === 'lan' ? p.transport.port : 9100,
            },
          })
          return
        case 'lanPort': {
          const n = Number(value)
          if (!Number.isFinite(n)) return
          updatePrinter({
            transport: {
              kind: 'lan',
              host: p.transport.kind === 'lan' ? p.transport.host : '192.168.1.50',
              port: n,
            },
          })
          return
        }
        case 'serialPath':
          updatePrinter({
            transport: {
              kind: 'serial',
              path: value,
              baudRate: p.transport.kind === 'serial' ? p.transport.baudRate : 38400,
            },
          })
          return
        case 'serialBaud': {
          const n = Number(value)
          if (!Number.isFinite(n)) return
          updatePrinter({
            transport: {
              kind: 'serial',
              path: p.transport.kind === 'serial' ? p.transport.path : '/dev/ttyS0',
              baudRate: n,
            },
          })
          return
        }
        case 'columns': {
          const n = Number(value)
          if (!Number.isFinite(n)) return
          updatePrinter({ columns: n })
          return
        }
        case 'lineSpacing': {
          const n = Number(value)
          if (!Number.isFinite(n)) return
          updatePrinter({ lineSpacing: n })
          return
        }
        case 'headerLine1':
          updateReceiptConfig({ headerLine1: value })
          return
        case 'headerLine2':
          updateReceiptConfig({ headerLine2: value })
          return
        case 'headerLine3':
          updateReceiptConfig({ headerLine3: value })
          return
        case 'phone':
          updateReceiptConfig({ phone: value })
          return
        case 'vatNumber':
          updateReceiptConfig({ vatNumber: value })
          return
        case 'vatRatePct': {
          const n = Number(value)
          if (!Number.isFinite(n)) return
          updateReceiptConfig({ vatRatePct: n })
          return
        }
        case 'receiptTitle':
          updateReceiptConfig({ receiptTitle: value })
          return
        case 'thankYouLine':
          updateReceiptConfig({ thankYouLine: value })
          return
        case 'tillLabel':
          updateReceiptConfig({ tillLabel: value })
          return
        case 'slipLabel':
          updateReceiptConfig({ slipLabel: value })
          return
        case 'vatLabel':
          updateReceiptConfig({ vatLabel: value })
          return
        case 'subtotalLabel':
          updateReceiptConfig({ subtotalLabel: value })
          return
        case 'taxTotalLabel':
          updateReceiptConfig({ taxTotalLabel: value })
          return
        case 'totalDueLabel':
          updateReceiptConfig({ totalDueLabel: value })
          return
        case 'cashTenderedLabel':
          updateReceiptConfig({ cashTenderedLabel: value })
          return
        case 'changeDueLabel':
          updateReceiptConfig({ changeDueLabel: value })
          return
        default:
          return
      }
    },
    [updatePrinter, updateReceiptConfig],
  )

  const setFieldDraft = useCallback(
    (field: SettingsKbField, value: string) => {
      fieldRef.current = field
      draftRef.current = value
      setActiveDraft(value)
      applyFieldString(field, value)
    },
    [applyFieldString],
  )

  const finishEditingField = useCallback(() => {
    const field = fieldRef.current
    if (!field) return
    const draft = draftRef.current ?? activeDraft ?? fieldValue(field, printerRef.current)
    if (NUMERIC_FIELDS.has(field)) {
      commitFieldDraft(field, draft, printerRef.current, updatePrinter, updateReceiptConfig)
    }
    clearDraft()
    setOpen(false)
  }, [activeDraft, clearDraft, updatePrinter, updateReceiptConfig])

  const displayValue = useCallback(
    (field: SettingsKbField) => {
      if (fieldRef.current === field) {
        if (draftRef.current !== null) return draftRef.current
        if (activeDraft !== null) return activeDraft
      }
      return fieldValue(field, printer)
    },
    [activeDraft, printer],
  )

  const fieldKbHandlers = useCallback(
    (field: SettingsKbField, kbLayout: KbLayout = 'full') => ({
      onFocus: (e: FocusEvent<HTMLInputElement>) => {
        fieldRef.current = field
        setLayout(kbLayout)
        activeInputRef.current = e.currentTarget
        const initial = fieldValue(field, printerRef.current)
        draftRef.current = initial
        setActiveDraft(initial)
        cancelBlurHide()
        setOpen(true)
        window.setTimeout(
          () => activeInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }),
          20,
        )
      },
      onBlur: () => {
        cancelBlurHide()
        blurTimerRef.current = window.setTimeout(() => {
          finishEditingField()
        }, 200)
      },
    }),
    [cancelBlurHide, finishEditingField],
  )

  const onAction = useCallback(
    (action: ScreenKeyboardAction) => {
      const field = fieldRef.current
      if (!field) return

      const patch = (updater: (s: string) => string) => {
        const current = draftRef.current ?? activeDraft ?? fieldValue(field, printerRef.current)
        const next = updater(current)
        draftRef.current = next
        setActiveDraft(next)
        applyFieldString(field, next)
      }

      if (action.type === 'char') {
        patch((s) => s + action.char)
        return
      }
      if (action.type === 'backspace') {
        patch((s) => s.slice(0, -1))
        return
      }
      if (action.type === 'space') {
        patch((s) => s + ' ')
        return
      }
      if (action.type === 'enter' || action.type === 'done') {
        finishEditingField()
      }
    },
    [activeDraft, applyFieldString, finishEditingField],
  )

  return { open, layout, fieldKbHandlers, onAction, displayValue, setFieldDraft }
}
