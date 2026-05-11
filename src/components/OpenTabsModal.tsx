import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateOpenTabModalInput, OpenTabListItem } from '../api/types'
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
  onCreateTab: (input: CreateOpenTabModalInput) => void | Promise<void>
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
  const [itemCheckedIn, setItemCheckedIn] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [attachmentNote, setAttachmentNote] = useState('')
  const [includeCurrentCart, setIncludeCurrentCart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [newFormMode, setNewFormMode] = useState<null | 'tab' | 'job_card'>(null)
  const [lookup, setLookup] = useState('')
  const [newTabScreenKbOpen, setNewTabScreenKbOpen] = useState(false)
  const newTabKbFieldRef = useRef<NewTabKbField>('tabNumber')
  const newTabKbBlurTimerRef = useRef<number | null>(null)
  const tabNumberInputRef = useRef<HTMLInputElement | null>(null)
  const customerNameInputRef = useRef<HTMLInputElement | null>(null)
  const phoneInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setNewFormMode(null)
    setLookup('')
    void onRefresh()
    setFormError(null)
    setIncludeCurrentCart(canIncludeWalkInCart && walkInLineCount > 0)
    setItemCheckedIn('')
    setJobDescription('')
    setAttachmentNote('')
  }, [open, onRefresh, canIncludeWalkInCart, walkInLineCount])

  const filteredTabs = useMemo(() => {
    const q = lookup.trim().toLowerCase()
    if (!q) return tabs
    const qAlnum = q.replace(/[^a-z0-9]/g, '')
    return tabs.filter((t) => {
      const haystack = `${t.tabNumber} ${t.jobNumber ?? ''} ${t.customerName} ${t.phone ?? ''}`.toLowerCase()
      if (haystack.includes(q)) return true
      /** Barcode scans omit punctuation (e.g. JC202600001 vs JC-2026-00001). */
      if (qAlnum.length >= 4) {
        const tabAlnum = `${t.tabNumber}${t.jobNumber ?? ''}`.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (tabAlnum.includes(qAlnum)) return true
      }
      return false
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
    if (!open || !newFormMode) {
      setNewTabScreenKbOpen(false)
      if (newTabKbBlurTimerRef.current) {
        clearTimeout(newTabKbBlurTimerRef.current)
        newTabKbBlurTimerRef.current = null
      }
    }
  }, [open, newFormMode])

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
    if (newFormMode === 'job_card') newTabKbFieldRef.current = 'customerName'
    else if (newFormMode === 'tab') newTabKbFieldRef.current = 'tabNumber'
  }, [newFormMode])

  useEffect(() => {
    if (!open || !newFormMode || !newTabScreenKbOpen) return
    const t = window.setTimeout(() => {
      scrollNewTabFieldIntoView(newTabKbFieldRef.current)
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, newFormMode, newTabScreenKbOpen])

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
    const mode = newFormMode
    if (!mode) return
    const num = tabNumber.trim()
    const name = customerName.trim()
    const ph = phone.trim()
    if (mode === 'tab' && !num) {
      setFormError('Tab number is required')
      return
    }
    if (!name) {
      setFormError('Name is required')
      return
    }
    setBusy(true)
    try {
      if (mode === 'tab') {
        await onCreateTab({
          mode: 'tab',
          tabNumber: num,
          customerName: name,
          phone: ph,
          includeCurrentCart: includeCurrentCart && canIncludeWalkInCart,
        })
      } else {
        await onCreateTab({
          mode: 'job_card',
          customerName: name,
          phone: ph,
          itemCheckedIn: itemCheckedIn.trim(),
          jobDescription: jobDescription.trim(),
          attachmentNote: attachmentNote.trim(),
          includeCurrentCart: includeCurrentCart && canIncludeWalkInCart,
        })
      }
      setTabNumber('')
      setCustomerName('')
      setPhone('')
      setItemCheckedIn('')
      setJobDescription('')
      setAttachmentNote('')
      setIncludeCurrentCart(false)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : mode === 'job_card' ? 'Could not create job card' : 'Could not create tab')
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
            <h3>
              {newFormMode === 'job_card' ? 'New job card' : newFormMode === 'tab' ? 'New tab' : 'Open tabs'}
            </h3>
            <div className="open-tabs-section-head-actions">
              {newFormMode ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    setNewFormMode(null)
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
                      setNewFormMode('tab')
                      setFormError(null)
                    }}
                  >
                    New tab
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={busy}
                    onClick={() => {
                      setNewFormMode('job_card')
                      setFormError(null)
                    }}
                  >
                    New job card
                  </button>
                </>
              )}
            </div>
          </div>

          {newFormMode ? (
            <form className="open-tabs-new" onSubmit={(e) => void handleCreate(e)}>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              {newFormMode === 'tab' ? (
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
              ) : (
                <p className="muted open-tabs-job-card-lead">
                  A unique job number is assigned when you create this card. Two labeled slips print for workshop and customer.
                </p>
              )}
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
              {newFormMode === 'job_card' ? (
                <>
                  <label className="open-tabs-field">
                    <span>Item checked in</span>
                    <textarea
                      className="open-tabs-input open-tabs-textarea"
                      value={itemCheckedIn}
                      onChange={(e) => setItemCheckedIn(e.target.value)}
                      placeholder="e.g. Laptop Dell · SN12345"
                      rows={2}
                      autoComplete="off"
                    />
                  </label>
                  <label className="open-tabs-field">
                    <span>Job description</span>
                    <textarea
                      className="open-tabs-input open-tabs-textarea"
                      value={jobDescription}
                      onChange={(e) => setJobDescription(e.target.value)}
                      placeholder="Work requested / fault reported"
                      rows={3}
                      autoComplete="off"
                    />
                  </label>
                  <label className="open-tabs-field">
                    <span>Note (item / workshop slip only)</span>
                    <textarea
                      className="open-tabs-input open-tabs-textarea"
                      value={attachmentNote}
                      onChange={(e) => setAttachmentNote(e.target.value)}
                      placeholder="Printed under Note: on the slip attached to the item — not on customer copy"
                      rows={3}
                      autoComplete="off"
                    />
                  </label>
                </>
              ) : null}
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
                    setNewFormMode(null)
                    setFormError(null)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? 'Creating…' : newFormMode === 'job_card' ? 'Create job card' : 'Create tab'}
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
                  placeholder="Find tab / job #, name, or phone"
                  aria-label="Find tab or job card"
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
                      {t.kind === 'job_card' ? (
                        <>
                          <span className="open-tabs-kind-badge">Job</span>{' '}
                          <strong>{t.jobNumber ?? t.tabNumber}</strong>
                        </>
                      ) : (
                        <strong>#{t.tabNumber}</strong>
                      )}
                      {' · '}
                      {t.customerName}
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
                        if (
                          !window.confirm(
                            t.kind === 'job_card'
                              ? `Void open job card ${t.jobNumber ?? t.tabNumber} (${t.customerName})?`
                              : `Void open tab #${t.tabNumber} (${t.customerName})?`,
                          )
                        )
                          return
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
