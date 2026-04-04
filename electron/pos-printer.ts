import fs from 'node:fs/promises'
import net from 'node:net'

export type PrinterTransport =
  | { kind: 'usb'; path: string }
  | { kind: 'lan'; host: string; port: number }

export type ReceiptLine = {
  qty: number
  name: string
  unitPrice: number
  lineTotal: number
}

export type ReceiptPayload = {
  storeName?: string
  headerLines?: string[]
  phone?: string
  vatNumber?: string
  receiptTitle?: string
  /** Defaults to "Receipt" before receiptNumber (e.g. use "Quote" for quotations). */
  receiptNumberPrefix?: string
  cashierName?: string
  tillNumber?: string
  tillLabel?: string
  slipLabel?: string
  receiptNumber?: string
  timestampIso: string
  paymentLabel: string
  lines: ReceiptLine[]
  subtotal: number
  discountTotal?: number
  taxTotal?: number
  vatRatePct?: number
  vatLabel?: string
  subtotalLabel?: string
  taxTotalLabel?: string
  totalDueLabel?: string
  cashTenderedLabel?: string
  changeDueLabel?: string
  thankYouLine?: string
  qtyHeader?: string
  priceHeader?: string
  total: number
  tendered?: number
  changeDue?: number
  /** Tighter vertical gap before the item table (e.g. quotations). */
  compactTopMargin?: boolean
  /** e.g. CUSTOMER COPY / STORE COPY (on-account dual receipts). */
  copyLabel?: string
  /** Printed before thank-you: account acknowledgement + signature lines. */
  accountChargeAck?: {
    accountNumber: string
    accountName?: string
    amount: number
  }
}

function enc(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function line(text = ''): Buffer {
  return enc(`${text}\n`)
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + ' '.repeat(width - s.length)
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return ' '.repeat(width - s.length) + s
}

function wrapText(s: string, width: number): string[] {
  const out: string[] = []
  const trimmed = s.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ['']
  let i = 0
  while (i < trimmed.length) {
    out.push(trimmed.slice(i, i + width))
    i += width
  }
  return out
}

function money(n: number): string {
  return n.toFixed(2)
}

function formatDdMmYyyy(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = String(d.getFullYear())
  return `${day}/${month}/${year}`
}

function formatReceiptTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// ESC/POS commands
const ESC = 0x1b
const GS = 0x1d

function cmd(bytes: number[]): Buffer {
  return Buffer.from(bytes)
}

function setAlign(align: 'left' | 'center' | 'right'): Buffer {
  const n = align === 'left' ? 0 : align === 'center' ? 1 : 2
  return cmd([ESC, 0x61, n])
}

function setEmph(on: boolean): Buffer {
  return cmd([ESC, 0x45, on ? 1 : 0])
}

function feed(lines = 1): Buffer {
  return cmd([ESC, 0x64, Math.max(0, Math.min(255, lines))])
}

function cutPartial(): Buffer {
  // GS V 1 : partial cut (common)
  return cmd([GS, 0x56, 0x01])
}

export function drawerKick(): Buffer {
  // ESC p m t1 t2
  // m=0 (pin2), t1=25 (~50ms), t2=250 (~500ms)
  return cmd([ESC, 0x70, 0x00, 0x19, 0xfa])
}

export function buildReceiptEscPos(payload: ReceiptPayload, opts?: { columns?: number; cut?: boolean }): Buffer {
  const columns = opts?.columns ?? 48 // 80mm typical at Font A
  const cut = opts?.cut ?? true
  const sidePad = 3 // ~25px visual margin per side on most 80mm thermal printers
  const contentCols = Math.max(24, columns - sidePad * 2)
  const pLine = (text = '') => line(`${' '.repeat(sidePad)}${padRight(text, contentCols)}${' '.repeat(sidePad)}`)

  const chunks: Buffer[] = []
  chunks.push(cmd([ESC, 0x40])) // Initialize
  // Centered block: store identity + doc title + receipt/quote number (short lines — full-width pLine would defeat ESC/POS centering).
  chunks.push(setAlign('center'))
  const headerLines = payload.headerLines?.filter((x) => x.trim().length > 0) ?? []
  if (headerLines.length > 0) {
    chunks.push(setEmph(true))
    chunks.push(line(headerLines[0]))
    chunks.push(setEmph(false))
    for (const h of headerLines.slice(1)) {
      chunks.push(line(h))
    }
  } else if (payload.storeName) {
    chunks.push(setEmph(true))
    chunks.push(line(payload.storeName))
    chunks.push(setEmph(false))
  } else {
    chunks.push(setEmph(true))
    chunks.push(line('ElectroPOS'))
    chunks.push(setEmph(false))
  }
  if (payload.phone) chunks.push(line(`TEL ${payload.phone}`))
  if (payload.vatNumber) chunks.push(line(`VAT ${payload.vatNumber}`))
  if (payload.receiptTitle) {
    const boldQuotation = payload.receiptTitle.trim().toUpperCase() === 'QUOTATION'
    if (boldQuotation) chunks.push(setEmph(true))
    chunks.push(line(payload.receiptTitle))
    if (boldQuotation) chunks.push(setEmph(false))
  }
  if (payload.receiptNumber) {
    const prefix = payload.receiptNumberPrefix ?? 'Receipt'
    chunks.push(line(`${prefix} ${payload.receiptNumber}`))
  }
  if (payload.copyLabel?.trim()) {
    chunks.push(feed(1))
    chunks.push(setEmph(true))
    chunks.push(line(payload.copyLabel.trim().toUpperCase()))
    chunks.push(setEmph(false))
  }

  chunks.push(setAlign('left'))
  const dt = new Date(payload.timestampIso)
  if (payload.cashierName || payload.tillNumber || payload.receiptNumber) {
    if (payload.cashierName) chunks.push(pLine(`Cashier ${payload.cashierName}`))
    const tillLabel = payload.tillLabel ?? 'Till No'
    const slipLabel = payload.slipLabel ?? 'Slip No'
    const tillPart = payload.tillNumber ? ` ${payload.tillNumber}` : ''
    const slipPart = payload.receiptNumber ? ` ${payload.receiptNumber}` : ''
    chunks.push(
      pLine(`${tillLabel}${tillPart}  ${slipLabel}${slipPart} ${formatDdMmYyyy(dt)} ${formatReceiptTime(dt)}`),
    )
  } else {
    chunks.push(pLine(`${formatDdMmYyyy(dt)} ${formatReceiptTime(dt)}`))
  }
  const compactTop = payload.compactTopMargin === true
  chunks.push(feed(compactTop ? 0 : 1))

  chunks.push(pLine('-'.repeat(contentCols)))
  const qtyHeader = payload.qtyHeader ?? 'QTY'
  const priceHeader = payload.priceHeader ?? 'PRICE'
  chunks.push(pLine(`${padRight('ITEM DESCRIPTION', contentCols - 14)}${padLeft(qtyHeader, 5)}${padLeft(priceHeader, 9)}`))
  chunks.push(pLine('-'.repeat(contentCols)))

  const qtyCol = 5
  const totalCol = 9
  const nameCol = Math.max(10, contentCols - qtyCol - totalCol)
  for (const l of payload.lines) {
    const qty = padLeft(String(l.qty), qtyCol)
    const lt = padLeft(money(l.lineTotal), totalCol)
    const nameLines = wrapText(l.name, nameCol)
    chunks.push(pLine(`${padRight(nameLines[0] ?? '', nameCol)}${qty}${lt}`))
    chunks.push(pLine(`@ ${money(l.unitPrice)}`))
    for (const extra of nameLines.slice(1)) {
      chunks.push(pLine(`${padRight(extra, nameCol)}${' '.repeat(qtyCol)}${' '.repeat(totalCol)}`))
    }
  }

  chunks.push(pLine('-'.repeat(contentCols)))

  const labelCol = contentCols - 12
  const totalLine = (label: string, value: string) =>
    pLine(`${padRight(label, labelCol)}${padLeft(value, contentCols - labelCol)}`)

  if (typeof payload.vatRatePct === 'number' && typeof payload.taxTotal === 'number') {
    chunks.push(totalLine(`${payload.vatLabel ?? 'Vat1'} @ ${payload.vatRatePct.toFixed(2)}% on ${money(payload.total)}`, money(payload.taxTotal)))
    chunks.push(pLine('-'.repeat(contentCols)))
  }
  chunks.push(totalLine(payload.subtotalLabel ?? 'SUBTOTAL:', money(payload.subtotal)))
  if (typeof payload.taxTotal === 'number') {
    chunks.push(totalLine(payload.taxTotalLabel ?? 'TAX TOTAL:', money(payload.taxTotal)))
  }
  if (payload.discountTotal && payload.discountTotal > 0.005) {
    chunks.push(totalLine('Discounts', `-${money(payload.discountTotal)}`))
  }
  chunks.push(setEmph(true))
  chunks.push(totalLine(payload.totalDueLabel ?? 'TOTAL DUE:', money(payload.total)))
  chunks.push(setEmph(false))
  chunks.push(pLine(`Payment: ${payload.paymentLabel}`))
  if (typeof payload.tendered === 'number' && Number.isFinite(payload.tendered)) {
    chunks.push(totalLine(payload.cashTenderedLabel ?? 'CASH TENDERED:', money(payload.tendered)))
  }
  if (typeof payload.changeDue === 'number' && Number.isFinite(payload.changeDue) && payload.changeDue > 0.005) {
    chunks.push(totalLine(payload.changeDueLabel ?? 'CHANGE DUE:', money(payload.changeDue)))
  }

  const ack = payload.accountChargeAck
  if (ack && ack.amount > 0.005) {
    chunks.push(feed(1))
    chunks.push(pLine('-'.repeat(contentCols)))
    chunks.push(setEmph(true))
    chunks.push(pLine('ON ACCOUNT'))
    chunks.push(setEmph(false))
    chunks.push(pLine(`Account no: ${ack.accountNumber}`))
    if (ack.accountName?.trim()) {
      for (const w of wrapText(`Account name: ${ack.accountName.trim()}`, contentCols)) {
        chunks.push(pLine(w))
      }
    }
    chunks.push(pLine(`Amount charged: ${money(ack.amount)}`))
    chunks.push(feed(1))
    chunks.push(pLine('I acknowledge the above charge to my account.'))
    chunks.push(feed(2))
    chunks.push(pLine('Signature: ________________________________'))
    chunks.push(feed(1))
    chunks.push(pLine('Print name: ______________________________'))
  }

  chunks.push(feed(2))
  chunks.push(setAlign('center'))
  chunks.push(pLine(payload.thankYouLine ?? 'THANK YOU'))
  chunks.push(feed(4)) // extra bottom margin (~25px) before cutter
  if (cut) {
    chunks.push(cutPartial())
    chunks.push(feed(1))
  }
  return Buffer.concat(chunks)
}

export async function sendEscPosToPrinter(transport: PrinterTransport, data: Buffer): Promise<void> {
  if (transport.kind === 'usb') {
    const fh = await fs.open(transport.path, 'w')
    try {
      await fh.write(data)
    } finally {
      await fh.close()
    }
    return
  }

  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket()
    const onErr = (e: unknown) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      reject(e instanceof Error ? e : new Error('Printer socket error'))
    }
    socket.once('error', onErr)
    socket.connect(transport.port, transport.host, () => {
      socket.write(data, (err) => {
        if (err) return onErr(err)
        socket.end()
      })
    })
    socket.once('close', () => resolve())
  })
}

