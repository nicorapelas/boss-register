import fs from 'node:fs'
import path from 'node:path'
import type { CustomerDisplaySnapshot } from './customer-display'

/** NCR Retail USB 2x20 ABN Display (XR7 integrated customer display). */
export const NCR_LINE_DISPLAY_VENDOR_ID = 0x0404
export const NCR_LINE_DISPLAY_PRODUCT_ID = 0x035f

/** Bump when changing the wire protocol so "Test line display" confirms deploy. */
export const NCR_LINE_DISPLAY_DRIVER_VERSION = 'drv6'

const ESC = 0x1b
const LINE_WIDTH = 20
/** NCR 5977 manual: row 2 column 1 is cursor position 0x14 (hex). */
const LINE2_CURSOR_POS = 0x14
const MIN_UPDATE_INTERVAL_MS = 350
const PUBLISH_DEBOUNCE_MS = 100

const CMD_DISPLAY_ON = Buffer.from([ESC, 0x05])
const CMD_ERASE = Buffer.from([ESC, 0x02])

let lastWriteAt = 0
let writeChain: Promise<void> = Promise.resolve()
let displayAwake = false
let lastWrittenLine1 = ''
let lastWrittenLine2 = ''
let lastSnapshotMode: CustomerDisplaySnapshot['mode'] | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingSnapshot: CustomerDisplaySnapshot | null = null
let pendingDevicePath: string | null = null
let pendingForceWrite = false

export type NcrLineDisplayDebug = {
  driverVersion: string
  hidReportSize: number
  lastSnapshotMode: string | null
  lastLineCount: number
  lastTotal: number | null
  mappedLine1: string
  mappedLine2: string
  lastWrittenLine1: string
  lastWrittenLine2: string
  lastError: string | null
  writeCount: number
  skippedDuplicate: number
}

let debugState: NcrLineDisplayDebug = {
  driverVersion: NCR_LINE_DISPLAY_DRIVER_VERSION,
  hidReportSize: 2,
  lastSnapshotMode: null,
  lastLineCount: 0,
  lastTotal: null,
  mappedLine1: '',
  mappedLine2: '',
  lastWrittenLine1: '',
  lastWrittenLine2: '',
  lastError: null,
  writeCount: 0,
  skippedDuplicate: 0,
}

export type NcrLineDisplayInfo = {
  path: string
  label: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cmdCursor(pos: number): Buffer {
  return Buffer.from([ESC, 0x13, pos & 0xff])
}

/** Locate /dev/hidraw* for the integrated NCR 2×20 display. */
export function findNcrLineDisplayPath(): string | null {
  const base = '/sys/class/hidraw'
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return null
  }

  for (const entry of entries) {
    const ueventPath = path.join(base, entry, 'device', 'uevent')
    try {
      const uevent = fs.readFileSync(ueventPath, 'utf8')
      const match = uevent.match(/HID_ID=([0-9a-f]+):([0-9a-f]+):([0-9a-f]+)/i)
      if (!match) continue
      const vendorId = Number.parseInt(match[2]!, 16)
      const productId = Number.parseInt(match[3]!, 16)
      if (vendorId === NCR_LINE_DISPLAY_VENDOR_ID && productId === NCR_LINE_DISPLAY_PRODUCT_ID) {
        return `/dev/${entry}`
      }
    } catch {
      /* try next */
    }
  }
  return null
}

export function listNcrLineDisplays(): NcrLineDisplayInfo[] {
  const devicePath = findNcrLineDisplayPath()
  if (!devicePath) return []
  return [{ path: devicePath, label: 'NCR 2×20 customer display' }]
}

export function resetNcrLineDisplayState(): void {
  lastWrittenLine1 = ''
  lastWrittenLine2 = ''
  displayAwake = false
  lastSnapshotMode = null
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingSnapshot = null
  pendingDevicePath = null
  pendingForceWrite = false
}

export function getNcrLineDisplayDebug(): NcrLineDisplayDebug {
  return { ...debugState }
}

/** Printable ASCII only — the pole display expects single-byte characters. */
function sanitizeDisplayText(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?')
}

/** Exactly `width` bytes, space-padded (not UTF-16 code units). */
function toDisplayBytes(text: string, width: number = LINE_WIDTH): Buffer {
  const buf = Buffer.alloc(width, 0x20)
  buf.write(sanitizeDisplayText(text), 0, width, 'ascii')
  return buf
}

function padLine(text: string): string {
  return toDisplayBytes(text).toString('latin1')
}

function formatMoney(n: number): string {
  if (!Number.isFinite(n)) return 'R 0.00'
  return `R ${n.toFixed(2)}`
}

function truncateEnd(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

function truncateStart(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(-maxLen)
  return `...${text.slice(-(maxLen - 3))}`
}

function formatItemLine(name: string, quantity: number): string {
  const qtyPrefix = `${quantity}x `
  const maxName = LINE_WIDTH - qtyPrefix.length
  return `${qtyPrefix}${truncateEnd(sanitizeDisplayText(name), maxName)}`
}

/** Map a customer-display snapshot to two 20-character lines. */
export function snapshotToLineDisplay(snapshot: CustomerDisplaySnapshot): { line1: string; line2: string } {
  const store = truncateEnd(snapshot.storeName || 'Welcome', LINE_WIDTH)

  switch (snapshot.mode) {
    case 'idle': {
      const headline = snapshot.idle?.headline?.trim() || 'Welcome'
      return {
        line1: padLine(truncateEnd(store, LINE_WIDTH)),
        line2: padLine(truncateEnd(headline, LINE_WIDTH)),
      }
    }
    case 'ready':
      return {
        line1: padLine(truncateEnd(store, LINE_WIDTH)),
        line2: padLine('Ready to be served'),
      }
    case 'spotlight': {
      const name = snapshot.spotlight?.name?.trim() || 'Item'
      return {
        line1: padLine(truncateEnd(name, LINE_WIDTH)),
        line2: padLine(snapshot.total != null ? `TOTAL ${formatMoney(snapshot.total)}` : ''),
      }
    }
    case 'loyalty-entry': {
      const value = snapshot.loyaltyEntry?.displayValue ?? ''
      return {
        line1: padLine('Enter phone number'),
        line2: padLine(truncateStart(value, LINE_WIDTH)),
      }
    }
    case 'complete': {
      const paid = snapshot.complete?.totalPaid
      const change = snapshot.complete?.changeDue
      if (change != null && change > 0) {
        return {
          line1: padLine('Thank you!'),
          line2: padLine(`CHANGE ${formatMoney(change)}`),
        }
      }
      return {
        line1: padLine('Thank you!'),
        line2: padLine(paid != null ? `PAID ${formatMoney(paid)}` : ''),
      }
    }
    case 'cart':
    default: {
      const lines = snapshot.lines ?? []
      const total = snapshot.total ?? 0
      const spotlightName = snapshot.spotlight?.name?.trim()
      if (spotlightName) {
        return {
          line1: padLine(truncateEnd(spotlightName, LINE_WIDTH)),
          line2: padLine(`TOTAL ${formatMoney(total)}`),
        }
      }
      const last = lines.length > 0 ? lines[lines.length - 1]! : null
      if (last) {
        return {
          line1: padLine(formatItemLine(last.name, last.quantity)),
          line2: padLine(`TOTAL ${formatMoney(total)}`),
        }
      }
      const count = lines.length
      return {
        line1: padLine(count > 0 ? `${count} item${count === 1 ? '' : 's'}` : store),
        line2: padLine(`TOTAL ${formatMoney(total)}`),
      }
    }
  }
}

const BYTE_WRITE_DELAY_MS = 3

/** XR7 integrated display: one serial byte per 2-byte hidraw report [0, data]. */
function hidBytePacket(byte: number): Buffer {
  return Buffer.from([0, byte & 0xff])
}

async function writeSerialBytes(devicePath: string, data: Buffer): Promise<void> {
  const fd = await fs.promises.open(devicePath, 'r+')
  try {
    for (let i = 0; i < data.length; i++) {
      await fd.write(hidBytePacket(data[i]!))
      if (i + 1 < data.length) await sleep(BYTE_WRITE_DELAY_MS)
    }
  } finally {
    await fd.close()
  }
}

/**
 * Working XR7 wire sequence (verified via SSH python classic mode):
 * wake → erase → row1 (20 bytes) → cursor 0x14 → row2 (20 bytes)
 */
function buildWritePayload(line1: string, line2: string, wake: boolean): Buffer {
  const chunks: Buffer[] = []
  if (wake) chunks.push(CMD_DISPLAY_ON)
  chunks.push(CMD_ERASE, toDisplayBytes(line1), cmdCursor(LINE2_CURSOR_POS), toDisplayBytes(line2))
  return Buffer.concat(chunks)
}

async function writeLines(devicePath: string, line1: string, line2: string, force = false): Promise<void> {
  const l1 = padLine(line1)
  const l2 = padLine(line2)
  if (!force && l1 === lastWrittenLine1 && l2 === lastWrittenLine2) {
    debugState.skippedDuplicate += 1
    return
  }

  const wake = !displayAwake
  if (wake) displayAwake = true
  await writeSerialBytes(devicePath, buildWritePayload(line1, line2, wake))
  lastWrittenLine1 = l1
  lastWrittenLine2 = l2
  debugState.lastWrittenLine1 = l1
  debugState.lastWrittenLine2 = l2
  debugState.writeCount += 1
  debugState.lastError = null
}

export async function writeNcrLineDisplay(
  devicePath: string,
  line1: string,
  line2: string,
  force = false,
): Promise<void> {
  const now = Date.now()
  const waitMs = force ? 0 : Math.max(0, MIN_UPDATE_INTERVAL_MS - (now - lastWriteAt))
  if (waitMs > 0) await sleep(waitMs)
  await writeLines(devicePath, line1, line2, force)
  lastWriteAt = Date.now()
}

function recordSnapshotDebug(snapshot: CustomerDisplaySnapshot): { line1: string; line2: string } {
  const { line1, line2 } = snapshotToLineDisplay(snapshot)
  debugState.lastSnapshotMode = snapshot.mode
  debugState.lastLineCount = snapshot.lines?.length ?? 0
  debugState.lastTotal = snapshot.total ?? null
  debugState.mappedLine1 = padLine(line1)
  debugState.mappedLine2 = padLine(line2)
  return { line1, line2 }
}

export function publishNcrLineDisplaySnapshot(
  devicePath: string,
  snapshot: CustomerDisplaySnapshot,
): Promise<void> {
  const modeChanged = snapshot.mode !== lastSnapshotMode
  if (modeChanged) {
    lastSnapshotMode = snapshot.mode
    lastWrittenLine1 = ''
    lastWrittenLine2 = ''
  }

  pendingDevicePath = devicePath
  pendingSnapshot = snapshot
  pendingForceWrite = pendingForceWrite || modeChanged
  if (debounceTimer) clearTimeout(debounceTimer)

  const debounceMs = modeChanged ? 0 : PUBLISH_DEBOUNCE_MS
  return new Promise((resolve) => {
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const path = pendingDevicePath
      const snap = pendingSnapshot
      const force = pendingForceWrite
      pendingDevicePath = null
      pendingSnapshot = null
      pendingForceWrite = false
      if (!path || !snap) {
        resolve()
        return
      }
      const { line1, line2 } = recordSnapshotDebug(snap)
      const l1 = padLine(line1)
      const l2 = padLine(line2)
      if (!force && l1 === lastWrittenLine1 && l2 === lastWrittenLine2) {
        debugState.skippedDuplicate += 1
        resolve()
        return
      }
      writeChain = writeChain
        .then(() => writeNcrLineDisplay(path, line1, line2, force))
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e)
          debugState.lastError = msg
          console.error('[ncr-line-display] write failed', e)
        })
        .then(() => resolve())
    }, debounceMs)
  })
}

export async function testNcrLineDisplay(devicePath: string): Promise<void> {
  resetNcrLineDisplayState()
  await writeNcrLineDisplay(
    devicePath,
    `BYTE MODE ${NCR_LINE_DISPLAY_DRIVER_VERSION}`,
    'BYTE MODE ROW 2!!!',
    true,
  )
}
