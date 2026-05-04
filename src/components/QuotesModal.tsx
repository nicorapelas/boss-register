import { useEffect, useRef, useState } from 'react'
import type { QuoteListItem } from '../api/types'
import { formatDateDdMmYyyy } from '../utils/dateFormat'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

type QuotesKbField = 'searchQ' | 'searchPhone' | 'saveCustomerName' | 'savePhone'

export type QuotesModalProps = {
  open: boolean
  onClose: () => void
  quotes: QuoteListItem[]
  loading: boolean
  onRefresh: (q: string, phone: string) => void | Promise<void>
  onLoadQuote: (id: string) => void | Promise<void>
  onSaveQuote: (input: { customerName: string; phone: string }) => void | Promise<void>
  onPrintQuote: (id: string) => void | Promise<void>
  saveDisabled: boolean
  loadDisabled: boolean
}

export function QuotesModal({
  open,
  onClose,
  quotes,
  loading,
  onRefresh,
  onLoadQuote,
  onSaveQuote,
  onPrintQuote,
  saveDisabled,
  loadDisabled,
}: QuotesModalProps) {
  const [q, setQ] = useState('')
  const [phone, setPhone] = useState('')
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [savePhone, setSavePhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [printBusyId, setPrintBusyId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [quotesScreenKbOpen, setQuotesScreenKbOpen] = useState(false)
  const quotesKbFieldRef = useRef<QuotesKbField>('searchQ')
  const quotesKbBlurTimerRef = useRef<number | null>(null)
  const searchQInputRef = useRef<HTMLInputElement | null>(null)
  const searchPhoneInputRef = useRef<HTMLInputElement | null>(null)
  const saveNameInputRef = useRef<HTMLInputElement | null>(null)
  const savePhoneInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    return () => {
      if (quotesKbBlurTimerRef.current) clearTimeout(quotesKbBlurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setQuotesScreenKbOpen(false)
      if (quotesKbBlurTimerRef.current) {
        clearTimeout(quotesKbBlurTimerRef.current)
        quotesKbBlurTimerRef.current = null
      }
    }
  }, [open])

  useEffect(() => {
    setQuotesScreenKbOpen(false)
    if (quotesKbBlurTimerRef.current) {
      clearTimeout(quotesKbBlurTimerRef.current)
      quotesKbBlurTimerRef.current = null
    }
  }, [showSaveForm])

  useEffect(() => {
    if (!open) return
    setShowSaveForm(false)
    setFormError(null)
    void onRefresh(q, phone)
    // Intentionally refresh only when the dialog opens (search fields apply on "Search").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function cancelQuotesKbBlurHide() {
    if (quotesKbBlurTimerRef.current) {
      clearTimeout(quotesKbBlurTimerRef.current)
      quotesKbBlurTimerRef.current = null
    }
  }

  function scrollQuotesFieldIntoView(which: QuotesKbField) {
    const target =
      which === 'searchQ'
        ? searchQInputRef.current
        : which === 'searchPhone'
          ? searchPhoneInputRef.current
          : which === 'saveCustomerName'
            ? saveNameInputRef.current
            : savePhoneInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  useEffect(() => {
    if (!open || !quotesScreenKbOpen) return
    const t = window.setTimeout(() => {
      scrollQuotesFieldIntoView(quotesKbFieldRef.current)
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, quotesScreenKbOpen, showSaveForm])

  function handleQuotesScreenKeyboardAction(action: ScreenKeyboardAction) {
    const field = quotesKbFieldRef.current
    const patch = (updater: (s: string) => string) => {
      if (field === 'searchQ') setQ(updater)
      else if (field === 'searchPhone') setPhone(updater)
      else if (field === 'saveCustomerName') setCustomerName(updater)
      else setSavePhone(updater)
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
      setQuotesScreenKbOpen(false)
    }
  }

  function quotesFieldKbHandlers(which: QuotesKbField) {
    return {
      onFocus: () => {
        quotesKbFieldRef.current = which
        cancelQuotesKbBlurHide()
        setQuotesScreenKbOpen(true)
        window.setTimeout(() => scrollQuotesFieldIntoView(which), 20)
      },
      onBlur: () => {
        cancelQuotesKbBlurHide()
        quotesKbBlurTimerRef.current = window.setTimeout(() => {
          setQuotesScreenKbOpen(false)
        }, 200)
      },
    }
  }

  if (!open) return null

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    setBusy(true)
    try {
      await onSaveQuote({ customerName: customerName.trim(), phone: savePhone.trim() })
      setCustomerName('')
      setSavePhone('')
      setShowSaveForm(false)
      await onRefresh(q, phone)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save quote')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quotes-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog">
        <div className="open-tabs-header">
          <h2 id="quotes-modal-title">Quotes</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className={quotesScreenKbOpen ? 'quotes-modal-body quotes-modal-body--with-keyboard' : 'quotes-modal-body'}>
          <div className="open-tabs-section-head">
            <h3>{showSaveForm ? 'Save as quote' : 'Recent quotes'}</h3>
            <div className="open-tabs-section-head-actions">
              {showSaveForm ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowSaveForm(false)
                    setFormError(null)
                  }}
                >
                  Back
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={loading}
                    onClick={() => void onRefresh(q, phone)}
                  >
                    {loading ? 'Loading…' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={busy || saveDisabled}
                    title={saveDisabled ? 'Need items in cart (and not on a tab)' : undefined}
                    onClick={() => {
                      setShowSaveForm(true)
                      setFormError(null)
                    }}
                  >
                    Save current cart
                  </button>
                </>
              )}
            </div>
          </div>

          {showSaveForm ? (
            <form className="open-tabs-new quotes-modal-form" onSubmit={(e) => void handleSave(e)}>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              <p className="muted" style={{ marginBottom: '0.75rem' }}>
                Prices are frozen for 7 days when this quote is loaded into the cart.
              </p>
              <label className="open-tabs-field">
                <span>Customer name</span>
                <input
                  ref={saveNameInputRef}
                  className="open-tabs-input"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Optional"
                  autoComplete="name"
                  inputMode={quotesScreenKbOpen ? 'none' : undefined}
                  {...quotesFieldKbHandlers('saveCustomerName')}
                />
              </label>
              <label className="open-tabs-field">
                <span>Phone</span>
                <input
                  ref={savePhoneInputRef}
                  className="open-tabs-input"
                  type="tel"
                  value={savePhone}
                  onChange={(e) => setSavePhone(e.target.value)}
                  placeholder="Optional — helps search later"
                  autoComplete="tel"
                  inputMode={quotesScreenKbOpen ? 'none' : 'tel'}
                  {...quotesFieldKbHandlers('savePhone')}
                />
              </label>
              <div
                className={
                  quotesScreenKbOpen
                    ? 'open-tabs-form-actions open-tabs-form-actions--with-keyboard'
                    : 'open-tabs-form-actions'
                }
              >
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowSaveForm(false)
                    setFormError(null)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save quote'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="quotes-modal-filters">
                <input
                  ref={searchQInputRef}
                  className="open-tabs-input"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Quote # or name"
                  aria-label="Search quote number or name"
                  inputMode={quotesScreenKbOpen ? 'none' : undefined}
                  {...quotesFieldKbHandlers('searchQ')}
                />
                <input
                  ref={searchPhoneInputRef}
                  className="open-tabs-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Phone"
                  type="tel"
                  aria-label="Filter by phone"
                  inputMode={quotesScreenKbOpen ? 'none' : 'tel'}
                  {...quotesFieldKbHandlers('searchPhone')}
                />
                <button type="button" className="btn small" disabled={loading} onClick={() => void onRefresh(q, phone)}>
                  Search
                </button>
              </div>

              <div className="quotes-modal-scroll">
                {quotes.length === 0 && !loading ? (
                  <p className="muted open-tabs-empty">No quotes match.</p>
                ) : (
                  <ul className="open-tabs-list">
                    {quotes.map((row) => (
                      <li key={row._id} className="open-tabs-li">
                        <div className="open-tabs-li-main">
                          <span className="open-tabs-li-title">
                            <strong>{row.quoteNumber}</strong>
                            {row.customerName ? ` · ${row.customerName}` : ''}
                          </span>
                          <span className="muted open-tabs-li-phone">{row.phone || '—'}</span>
                          <span className="open-tabs-li-total">{row.totalInclVat.toFixed(2)}</span>
                        </div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--muted, #a8a8a8)', marginBottom: '0.35rem' }}>
                          Valid until {formatDateDdMmYyyy(row.validUntil)}
                          {row.status !== 'open' ? ` · ${row.status}` : null}
                          {row.isExpired ? ' · expired' : null}
                        </div>
                        <div className="open-tabs-li-actions">
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={busy || printBusyId !== null}
                            title="Thermal quote slip (same printer as receipts)"
                            onClick={() => {
                              setPrintBusyId(row._id)
                              void Promise.resolve(onPrintQuote(row._id)).finally(() => setPrintBusyId(null))
                            }}
                          >
                            {printBusyId === row._id ? 'Printing…' : 'Print'}
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            disabled={
                              busy ||
                              loadDisabled ||
                              row.status !== 'open' ||
                              row.isExpired
                            }
                            title={
                              loadDisabled
                                ? 'Finish tab first'
                                : row.status !== 'open'
                                  ? 'Not open'
                                  : row.isExpired
                                    ? 'Quote expired'
                                    : 'Load into cart'
                            }
                            onClick={() => void onLoadQuote(row._id)}
                          >
                            Load
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
          <ScreenKeyboard
            visible={quotesScreenKbOpen}
            onAction={handleQuotesScreenKeyboardAction}
            className="open-tabs-screen-keyboard quotes-modal-screen-keyboard"
          />
        </div>
      </div>
    </div>
  )
}
