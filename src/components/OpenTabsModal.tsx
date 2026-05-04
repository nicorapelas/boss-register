import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpenTabListItem } from '../api/types'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

type NewTabKbField = 'tabNumber' | 'customerName' | 'phone'

export type OpenTabsModalProps = {
  open: boolean
  onClose: () => void
  tabs: OpenTabListItem[]
  loading: boolean
  onRefresh: () => void | Promise<void>
  activeOpenTabId: string | null
  /** Allow "include current cart" when ringing a walk-in sale (not already on a tab). */
  canIncludeWalkInCart: boolean
  walkInLineCount: number
  onSelectTab: (id: string) => void | Promise<void>
  onVoidTab: (id: string) => void | Promise<void>
  onCreateTab: (input: {
    tabNumber: string
    customerName: string
    phone: string
    includeCurrentCart: boolean
  }) => void | Promise<void>
}

export function OpenTabsModal({
  open,
  onClose,
  tabs,
  loading,
  onRefresh,
  activeOpenTabId,
  canIncludeWalkInCart,
  walkInLineCount,
  onSelectTab,
  onVoidTab,
  onCreateTab,
}: OpenTabsModalProps) {
  const [tabNumber, setTabNumber] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [includeCurrentCart, setIncludeCurrentCart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [showNewTabForm, setShowNewTabForm] = useState(false)
  const [lookup, setLookup] = useState('')
  const [newTabScreenKbOpen, setNewTabScreenKbOpen] = useState(false)
  const newTabKbFieldRef = useRef<NewTabKbField>('tabNumber')
  const newTabKbBlurTimerRef = useRef<number | null>(null)
  const tabNumberInputRef = useRef<HTMLInputElement | null>(null)
  const customerNameInputRef = useRef<HTMLInputElement | null>(null)
  const phoneInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setShowNewTabForm(false)
    setLookup('')
    void onRefresh()
    setFormError(null)
    setIncludeCurrentCart(canIncludeWalkInCart && walkInLineCount > 0)
  }, [open, onRefresh, canIncludeWalkInCart, walkInLineCount])

  const filteredTabs = useMemo(() => {
    const q = lookup.trim().toLowerCase()
    if (!q) return tabs
    return tabs.filter((t) => {
      const haystack = `${t.tabNumber} ${t.customerName} ${t.phone ?? ''}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [tabs, lookup])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    return () => {
      if (newTabKbBlurTimerRef.current) clearTimeout(newTabKbBlurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open || !showNewTabForm) {
      setNewTabScreenKbOpen(false)
      if (newTabKbBlurTimerRef.current) {
        clearTimeout(newTabKbBlurTimerRef.current)
        newTabKbBlurTimerRef.current = null
      }
    }
  }, [open, showNewTabForm])

  function cancelNewTabKbBlurHide() {
    if (newTabKbBlurTimerRef.current) {
      clearTimeout(newTabKbBlurTimerRef.current)
      newTabKbBlurTimerRef.current = null
    }
  }

  function scrollNewTabFieldIntoView(which: NewTabKbField) {
    const target =
      which === 'tabNumber' ? tabNumberInputRef.current : which === 'customerName' ? customerNameInputRef.current : phoneInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  useEffect(() => {
    if (!open || !showNewTabForm || !newTabScreenKbOpen) return
    const t = window.setTimeout(() => {
      scrollNewTabFieldIntoView(newTabKbFieldRef.current)
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, showNewTabForm, newTabScreenKbOpen])

  function handleNewTabScreenKeyboardAction(action: ScreenKeyboardAction) {
    const field = newTabKbFieldRef.current
    const patch = (updater: (s: string) => string) => {
      if (field === 'tabNumber') setTabNumber(updater)
      else if (field === 'customerName') setCustomerName(updater)
      else setPhone(updater)
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
      setNewTabScreenKbOpen(false)
    }
  }

  function newTabFieldKbHandlers(which: NewTabKbField) {
    return {
      onFocus: () => {
        newTabKbFieldRef.current = which
        cancelNewTabKbBlurHide()
        setNewTabScreenKbOpen(true)
        window.setTimeout(() => scrollNewTabFieldIntoView(which), 20)
      },
      onBlur: () => {
        cancelNewTabKbBlurHide()
        newTabKbBlurTimerRef.current = window.setTimeout(() => {
          setNewTabScreenKbOpen(false)
        }, 200)
      },
    }
  }

  if (!open) return null

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    const num = tabNumber.trim()
    const name = customerName.trim()
    const ph = phone.trim()
    if (!num) {
      setFormError('Tab number is required')
      return
    }
    if (!name) {
      setFormError('Name is required')
      return
    }
    setBusy(true)
    try {
      await onCreateTab({
        tabNumber: num,
        customerName: name,
        phone: ph,
        includeCurrentCart: includeCurrentCart && canIncludeWalkInCart,
      })
      setTabNumber('')
      setCustomerName('')
      setPhone('')
      setIncludeCurrentCart(false)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create tab')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-tabs-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog">
        <div className="open-tabs-header">
          <h2 id="open-tabs-title">Tabs</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="open-tabs-section">
          <div className="open-tabs-section-head">
            <h3>{showNewTabForm ? 'New tab' : 'Open tabs'}</h3>
            <div className="open-tabs-section-head-actions">
              {showNewTabForm ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowNewTabForm(false)
                    setFormError(null)
                  }}
                >
                  Back
                </button>
              ) : (
                <>
                  <button type="button" className="btn ghost" disabled={loading} onClick={() => void onRefresh()}>
                    {loading ? 'Loading…' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={busy}
                    onClick={() => {
                      setShowNewTabForm(true)
                      setFormError(null)
                    }}
                  >
                    New Tab
                  </button>
                </>
              )}
            </div>
          </div>

          {showNewTabForm ? (
            <form className="open-tabs-new" onSubmit={(e) => void handleCreate(e)}>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              <label className="open-tabs-field">
                <span>Tab number</span>
                <input
                  ref={tabNumberInputRef}
                  className="open-tabs-input"
                  value={tabNumber}
                  onChange={(e) => setTabNumber(e.target.value)}
                  placeholder="e.g. 12 or Table 5"
                  autoComplete="off"
                  inputMode={newTabScreenKbOpen ? 'none' : undefined}
                  {...newTabFieldKbHandlers('tabNumber')}
                />
              </label>
              <label className="open-tabs-field">
                <span>Name</span>
                <input
                  ref={customerNameInputRef}
                  className="open-tabs-input"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer or table name"
                  autoComplete="name"
                  inputMode={newTabScreenKbOpen ? 'none' : undefined}
                  {...newTabFieldKbHandlers('customerName')}
                />
              </label>
              <label className="open-tabs-field">
                <span>Phone</span>
                <input
                  ref={phoneInputRef}
                  className="open-tabs-input"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Optional"
                  autoComplete="tel"
                  inputMode={newTabScreenKbOpen ? 'none' : 'tel'}
                  {...newTabFieldKbHandlers('phone')}
                />
              </label>
              {canIncludeWalkInCart && walkInLineCount > 0 ? (
                <label className="open-tabs-check">
                  <input
                    type="checkbox"
                    checked={includeCurrentCart}
                    onChange={(e) => setIncludeCurrentCart(e.target.checked)}
                  />
                  <span>Include current sale ({walkInLineCount} line{walkInLineCount === 1 ? '' : 's'})</span>
                </label>
              ) : null}
              <ScreenKeyboard
                visible={newTabScreenKbOpen}
                onAction={handleNewTabScreenKeyboardAction}
                className="open-tabs-screen-keyboard"
              />
              <div
                className={
                  newTabScreenKbOpen
                    ? 'open-tabs-form-actions open-tabs-form-actions--with-keyboard'
                    : 'open-tabs-form-actions'
                }
              >
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowNewTabForm(false)
                    setFormError(null)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? 'Creating…' : 'Create tab'}
                </button>
              </div>
            </form>
          ) : tabs.length === 0 && !loading ? (
            <p className="muted open-tabs-empty">No open tabs yet.</p>
          ) : (
            <>
              <div className="quotes-modal-filters" style={{ marginBottom: '0.6rem' }}>
                <input
                  className="open-tabs-input"
                  value={lookup}
                  onChange={(e) => setLookup(e.target.value)}
                  placeholder="Find tab #, name, or phone"
                  aria-label="Find tab"
                />
                <button type="button" className="btn small" onClick={() => setLookup('')} disabled={!lookup.trim()}>
                  Clear
                </button>
              </div>
              {filteredTabs.length === 0 ? (
                <p className="muted open-tabs-empty">No tabs match that search.</p>
              ) : null}
              <ul className="open-tabs-list">
                {filteredTabs.map((t) => (
                <li key={t._id} className={t._id === activeOpenTabId ? 'open-tabs-li active' : 'open-tabs-li'}>
                  <div className="open-tabs-li-main">
                    <span className="open-tabs-li-title">
                      <strong>#{t.tabNumber}</strong> · {t.customerName}
                    </span>
                    <span className="muted open-tabs-li-phone">{t.phone || '—'}</span>
                    <span className="open-tabs-li-total">{t.total.toFixed(2)}</span>
                  </div>
                  <div className="open-tabs-li-actions">
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy || t._id === activeOpenTabId}
                      onClick={() => void onSelectTab(t._id)}
                    >
                      {t._id === activeOpenTabId ? 'Current' : 'Open'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost small open-tabs-void"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Void open tab #${t.tabNumber} (${t.customerName})?`)) return
                        void onVoidTab(t._id)
                      }}
                    >
                      Void
                    </button>
                  </div>
                </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
