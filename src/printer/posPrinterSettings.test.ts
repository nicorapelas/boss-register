import { describe, expect, it } from 'vitest'
import {
  defaultPrinterSettingsForTill,
  defaultPrinterTransportForProfile,
  defaultUsbPrinterPath,
  resetPrinterLayoutKeepTransport,
} from './posPrinterSettings'

describe('defaultPrinterSettingsForTill', () => {
  it('uses USB pos-printer symlink for NCR', () => {
    const s = defaultPrinterSettingsForTill('ncr')
    expect(s.transport).toEqual({ kind: 'usb', path: '/dev/usb/pos-printer' })
  })

  it('uses serial ttyS0 for Posiflex', () => {
    const s = defaultPrinterSettingsForTill('posiflex')
    expect(s.transport).toEqual({ kind: 'serial', path: '/dev/ttyS0', baudRate: 38400 })
  })

  it('defaultUsbPrinterPath follows profile', () => {
    expect(defaultUsbPrinterPath('ncr')).toBe('/dev/usb/pos-printer')
    expect(defaultUsbPrinterPath('posiflex')).toBe('/dev/usb/lp0')
  })
})

describe('resetPrinterLayoutKeepTransport', () => {
  it('restores layout defaults but keeps custom USB path', () => {
    const current = {
      ...defaultPrinterSettingsForTill('ncr'),
      transport: { kind: 'usb' as const, path: '/dev/usb/lp2' },
      columns: 38,
      receiptConfig: {
        ...defaultPrinterSettingsForTill('ncr').receiptConfig,
        headerLine1: 'CUSTOM',
      },
    }
    const next = resetPrinterLayoutKeepTransport(current)
    expect(next.transport).toEqual({ kind: 'usb', path: '/dev/usb/lp2' })
    expect(next.columns).toBe(42)
    expect(next.receiptConfig.headerLine1).toBe('JACOBS CYCLES')
  })

  it('full reset for NCR restores profile transport', () => {
    const reset = defaultPrinterSettingsForTill('ncr')
    expect(defaultPrinterTransportForProfile('ncr')).toEqual(reset.transport)
  })
})
