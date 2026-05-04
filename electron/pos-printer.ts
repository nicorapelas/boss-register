import fs from 'node:fs/promises'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type PrinterTransport =
  | { kind: 'usb'; path: string }
  | { kind: 'lan'; host: string; port: number }
  | { kind: 'serial'; path: string; baudRate: number }

export type ReceiptLine = {
  qty: number
  name: string
  unitPrice: number
  listUnitPrice?: number
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
  /** When false, suppress standalone "<prefix> <receiptNumber>" line (used for lay-by barcode slips). */
  showReceiptNumberLine?: boolean
  cashierName?: string
  tillNumber?: string
  tillLabel?: string
  slipLabel?: string
  receiptNumber?: string
  /** Optional barcode printed above receipt number (e.g. lay-by number). */
  barcodeValue?: string
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
  /** Optional line item after payment showing outstanding balance (used by lay-by receipts). */
  balanceRemaining?: number
  /** Tighter vertical gap before the item table (e.g. quotations). */
  compactTopMargin?: boolean
  /** e.g. CUSTOMER COPY / STORE COPY (on-account dual receipts). */
  copyLabel?: string
  /** When multiple tenders apply (cash / card / store voucher), listed under Payment. */
  paymentTenders?: { cash?: number; card?: number; storeVoucher?: number }
  /** Customer-facing voucher redemption detail (phone masked). */
  storeVoucherAck?: {
    phoneDisplay: string
    amount: number
    balanceAfter?: number
  }
  /** Printed before thank-you: account acknowledgement + signature lines. */
  accountChargeAck?: {
    accountNumber: string
    accountName?: string
    amount: number
    purchaseOrderNumber?: string
  }
  /** Printed before thank-you: refund acknowledgement + signature lines. */
  refundAck?: {
    refundTotal: number
    refundCash: number
    refundCard: number
    /** Amount credited to customer voucher account (no cash/card payout). */
    refundStoreCredit?: number
    note?: string
  }
  /** Optional dedicated layout for shift/Z reports. */
  shiftReport?: {
    turnover: number
    cashSales: number
    cardSales: number
    voucherTotal: number
    onAccountTotal: number
    refundTotal: number
    refundCashTotal?: number
    refundCardTotal?: number
    refundCount?: number
    refundCashierNames?: string[]
    refundDetails?: Array<{
      saleId?: string
      cashierName?: string
      method?: 'cash' | 'card' | 'store_credit'
      refundTotal: number
      refundCash: number
      refundCard: number
    }>
    layByCompletions: number
    layByPaymentCount?: number
    layByPaymentCashTotal?: number
    layByPaymentCardTotal?: number
    layByPaymentStoreCreditTotal?: number
    layByPaymentTotal?: number
    quoteConversions: number
    tabClosures: number
    cashierSales: Array<{ cashierName?: string; salesCount: number; total: number }>
    priceOverrides?: Array<{
      saleId?: string
      cashierName?: string
      itemName: string
      quantity: number
      listUnitPrice: number
      overriddenUnitPrice: number
      lineDiscount: number
    }>
    cashDifferences?: Array<{ kind: 'over' | 'under'; amount: number; note?: string }>
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

function barcodeCode39(value: string): Buffer {
  const clean = value.toUpperCase().replace(/[^0-9A-Z \-.$/+%]/g, '').trim()
  if (!clean) return Buffer.alloc(0)
  const data = Buffer.from(clean, 'ascii')
  return Buffer.concat([
    cmd([GS, 0x48, 0x02]), // HRI below barcode
    cmd([GS, 0x68, 0x58]), // barcode height
    cmd([GS, 0x77, 0x02]), // barcode module width
    cmd([GS, 0x6b, 0x04]), // CODE39
    data,
    cmd([0x00]), // NUL terminator for CODE39 (m=4)
    line(''),
  ])
}

export function drawerKick(): Buffer {
  // ESC p m t1 t2
  // m=0 (pin2), t1=25 (~50ms), t2=250 (~500ms)
  return cmd([ESC, 0x70, 0x00, 0x19, 0xfa])
}

export function buildReceiptEscPos(payload: ReceiptPayload, opts?: { columns?: number; cut?: boolean }): Buffer {
  const requestedColumns = opts?.columns ?? 42
  const columns = Math.max(32, Math.min(requestedColumns, 48))
  const cut = opts?.cut ?? true
  const sidePad = columns >= 46 ? 1 : 0
  const contentCols = Math.max(24, columns - sidePad * 2)
  const pLine = (text = '') => line(`${' '.repeat(sidePad)}${padRight(text, contentCols)}${' '.repeat(sidePad)}`)

  const chunks: Buffer[] = []
  chunks.push(cmd([ESC, 0x40])) // Initialize
  chunks.push(feed(1)) // Prevent first header line from clipping at paper top
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
  if (payload.barcodeValue?.trim()) {
    chunks.push(feed(1))
    chunks.push(setAlign('center'))
    chunks.push(barcodeCode39(payload.barcodeValue))
  }
  const showReceiptNumberLine = payload.showReceiptNumberLine !== false
  if (payload.receiptNumber && showReceiptNumberLine) {
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
  const shift = payload.shiftReport
  if (shift) {
    const section = (title: string) => {
      chunks.push(feed(1))
      chunks.push(setEmph(true))
      chunks.push(pLine(title))
      chunks.push(setEmph(false))
      chunks.push(pLine('-'.repeat(contentCols)))
    }
    const row = (label: string, value: string) => {
      const left = Math.max(8, contentCols - 12)
      chunks.push(pLine(`${padRight(label, left)}${padLeft(value, contentCols - left)}`))
    }

    section('TOTAL FUNDS IN DRAWER')
    const layByCash = shift.layByPaymentCashTotal ?? 0
    const layByCard = shift.layByPaymentCardTotal ?? 0
    const drawerCash = shift.cashSales + layByCash
    const drawerCard = shift.cardSales + layByCard
    row('Cash', money(drawerCash))
    row('Card', money(drawerCard))
    row('Total', money(drawerCash + drawerCard))
    chunks.push(pLine('-'.repeat(contentCols)))

    section('TOTALS')
    row('Turnover', money(shift.turnover))
    chunks.push(pLine('-'.repeat(contentCols)))

    section('TENDERS')
    row('Cash sales', money(shift.cashSales))
    row('Card sales', money(shift.cardSales))
    row('Vouchers', money(shift.voucherTotal))
    row('Accounts', money(shift.onAccountTotal))
    chunks.push(pLine('-'.repeat(contentCols)))

    section('CASHIER SALES')
    if (shift.cashierSales.length === 0) {
      chunks.push(pLine('No sales'))
    } else {
      for (const c of shift.cashierSales) {
        const name = (c.cashierName?.trim() || 'Cashier').slice(0, Math.max(8, contentCols - 12))
        row(`${name} (${c.salesCount})`, money(c.total))
      }
    }
    chunks.push(pLine('-'.repeat(contentCols)))

    section('ACTIVITY COUNT')
    row('Lay-bys', String(shift.layByCompletions))
    const lbPayCount = shift.layByPaymentCount ?? 0
    const lbPayTotal = shift.layByPaymentTotal ?? 0
    if (lbPayCount > 0 || Math.abs(lbPayTotal) > 0.005) {
      row('Lay-by payments', String(lbPayCount))
      const cash = shift.layByPaymentCashTotal ?? 0
      const card = shift.layByPaymentCardTotal ?? 0
      const sc = shift.layByPaymentStoreCreditTotal ?? 0
      if (Math.abs(cash) > 0.005) row('  Cash', money(cash))
      if (Math.abs(card) > 0.005) row('  Card', money(card))
      if (Math.abs(sc) > 0.005) row('  Store credit', money(sc))
      row('  Total', money(lbPayTotal))
    }
    row('Quotes', String(shift.quoteConversions))
    row('Tabs', String(shift.tabClosures))
    chunks.push(pLine('-'.repeat(contentCols)))

    section('REFUNDS')
    row('Count', String(shift.refundCount ?? 0))
    row('Cash', money(shift.refundCashTotal ?? 0))
    row('Card', money(shift.refundCardTotal ?? 0))
    row('Total', money(shift.refundTotal))
    if (shift.refundCashierNames?.length) {
      const namesLine = `Refunded by: ${shift.refundCashierNames.join(', ')}`
      for (const w of wrapText(namesLine, contentCols)) chunks.push(pLine(w))
    }
    const refundDetails = shift.refundDetails ?? []
    if (refundDetails.length > 0) {
      chunks.push(pLine('-'.repeat(contentCols)))
      for (const r of refundDetails) {
        const by = r.cashierName?.trim() || 'Cashier'
        const saleRef = r.saleId?.trim() ? `Sale ${r.saleId.trim()}` : 'Sale'
        const via =
          r.method === 'store_credit'
            ? ' · VOUCHER'
            : r.method
              ? ` · ${r.method.toUpperCase()}`
              : ''
        chunks.push(pLine(`${saleRef}${via}`))
        row('By', by)
        row('Cash', money(r.refundCash))
        row('Card', money(r.refundCard))
        row('Total', money(r.refundTotal))
        chunks.push(pLine('-'.repeat(contentCols)))
      }
    }
    chunks.push(pLine('-'.repeat(contentCols)))

    section('PRICE OVERRIDE')
    const overrides = shift.priceOverrides ?? []
    if (overrides.length === 0) {
      chunks.push(pLine('None'))
    } else {
      for (const o of overrides) {
        const by = o.cashierName?.trim() || 'Cashier'
        const saleRef = o.saleId?.trim() ? `Sale ${o.saleId.trim()} · ` : ''
        for (const w of wrapText(`${saleRef}${o.itemName} · ${o.quantity} qty`, contentCols)) chunks.push(pLine(w))
        row('By', by)
        row('List price', money(o.listUnitPrice))
        row('Override', money(o.overriddenUnitPrice))
        row('Line discount', money(o.lineDiscount))
        chunks.push(pLine('-'.repeat(contentCols)))
      }
    }

    section('CASH DIFFERENCE')
    const diffs = shift.cashDifferences ?? []
    if (diffs.length === 0) {
      chunks.push(pLine('None'))
    } else {
      for (const d of diffs) {
        row(d.kind === 'over' ? 'Over' : 'Under', money(d.amount))
        if (d.note?.trim()) {
          for (const w of wrapText(`Note: ${d.note.trim()}`, contentCols)) chunks.push(pLine(w))
        }
      }
    }
    chunks.push(feed(2))
    chunks.push(setAlign('center'))
    chunks.push(pLine(payload.thankYouLine ?? 'SHIFT SUMMARY'))
    chunks.push(feed(4))
    if (cut) {
      chunks.push(cutPartial())
      chunks.push(feed(1))
    }
    return Buffer.concat(chunks)
  }

  const qtyCol = 4
  const totalCol = 10
  const nameCol = Math.max(10, contentCols - qtyCol - totalCol)
  for (const l of payload.lines) {
    const qty = padLeft(String(l.qty), qtyCol)
    const lt = padLeft(money(l.lineTotal), totalCol)
    const nameLines = wrapText(l.name, nameCol)
    chunks.push(pLine(`${padRight(nameLines[0] ?? '', nameCol)}${qty}${lt}`))
    chunks.push(pLine(`@ ${money(l.unitPrice)}`))
    if (typeof l.listUnitPrice === 'number' && Number.isFinite(l.listUnitPrice) && Math.abs(l.listUnitPrice - l.unitPrice) > 0.0001) {
      chunks.push(pLine(`List ${money(l.listUnitPrice)} -> Override ${money(l.unitPrice)}`))
    }
    for (const extra of nameLines.slice(1)) {
      chunks.push(pLine(`${padRight(extra, nameCol)}${' '.repeat(qtyCol)}${' '.repeat(totalCol)}`))
    }
  }

  chunks.push(pLine('-'.repeat(contentCols)))

  const valueCol = 10
  const labelCol = Math.max(8, contentCols - valueCol)
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
  const pt = payload.paymentTenders
  if (pt) {
    const cashT = pt.cash && pt.cash > 0.005 ? pt.cash : 0
    const cardT = pt.card && pt.card > 0.005 ? pt.card : 0
    const voucherT = pt.storeVoucher && pt.storeVoucher > 0.005 ? pt.storeVoucher : 0
    const tenderParts = [cashT > 0.005, cardT > 0.005, voucherT > 0.005].filter(Boolean).length
    if (tenderParts >= 2) {
      chunks.push(feed(1))
      chunks.push(pLine('Tenders:'))
      if (cashT > 0.005) chunks.push(totalLine('Cash', money(cashT)))
      if (cardT > 0.005) chunks.push(totalLine('Card', money(cardT)))
      if (voucherT > 0.005) chunks.push(totalLine('Store voucher', money(voucherT)))
    }
  }
  const svAck = payload.storeVoucherAck
  if (svAck && svAck.amount > 0.005) {
    chunks.push(feed(1))
    chunks.push(pLine('-'.repeat(contentCols)))
    chunks.push(setEmph(true))
    chunks.push(pLine('STORE VOUCHER'))
    chunks.push(setEmph(false))
    chunks.push(pLine(`Account: ${svAck.phoneDisplay}`))
    chunks.push(pLine(`Applied: ${money(svAck.amount)}`))
    if (typeof svAck.balanceAfter === 'number' && Number.isFinite(svAck.balanceAfter)) {
      chunks.push(totalLine('Balance remaining:', money(Math.max(0, svAck.balanceAfter))))
    }
    chunks.push(feed(1))
  }
  if (typeof payload.balanceRemaining === 'number' && Number.isFinite(payload.balanceRemaining)) {
    chunks.push(totalLine('Balance remaining:', money(Math.max(0, payload.balanceRemaining))))
  }
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
    if (ack.purchaseOrderNumber?.trim()) {
      chunks.push(pLine(`PO no: ${ack.purchaseOrderNumber.trim()}`))
    }
    chunks.push(feed(1))
    chunks.push(pLine('I acknowledge the above charge to my account.'))
    chunks.push(feed(2))
    chunks.push(pLine('Signature: ________________________________'))
    chunks.push(feed(1))
    chunks.push(pLine('Print name: ______________________________'))
  }
  const refundAck = payload.refundAck
  if (refundAck && refundAck.refundTotal > 0.005) {
    chunks.push(feed(1))
    chunks.push(pLine('-'.repeat(contentCols)))
    chunks.push(setEmph(true))
    chunks.push(pLine('REFUND ACKNOWLEDGEMENT'))
    chunks.push(setEmph(false))
    chunks.push(pLine(`Refund total: ${money(refundAck.refundTotal)}`))
    chunks.push(pLine(`Cash refund: ${money(Math.max(0, refundAck.refundCash))}`))
    chunks.push(pLine(`Card refund: ${money(Math.max(0, refundAck.refundCard))}`))
    if (typeof refundAck.refundStoreCredit === 'number' && refundAck.refundStoreCredit > 0.005) {
      chunks.push(pLine(`Store credit issued: ${money(refundAck.refundStoreCredit)}`))
    }
    if (refundAck.note?.trim()) {
      for (const w of wrapText(`Reason: ${refundAck.note.trim()}`, contentCols)) {
        chunks.push(pLine(w))
      }
    }
    chunks.push(feed(1))
    chunks.push(pLine('I confirm I received the refund above.'))
    chunks.push(feed(2))
    chunks.push(pLine('Signature: ________________________________'))
    chunks.push(feed(1))
    chunks.push(pLine('Print name: ______________________________'))
    chunks.push(feed(1))
    chunks.push(pLine('Phone: _________________________________'))
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

  if (transport.kind === 'serial') {
    const run = promisify(execFile)
    await run('stty', [
      '-F',
      transport.path,
      String(transport.baudRate),
      'cs8',
      '-cstopb',
      '-parenb',
      '-ixon',
      '-ixoff',
      'raw',
      '-echo',
    ])
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

