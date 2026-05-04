import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { HouseAccountRow } from '../api/types'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type HouseAccountsModalProps = {
  open: boolean
  onClose: () => void
  /** Called when user confirms account selection. */
  onSelectAccount: (account: HouseAccountRow) => void
  actionLabel?: string
  helperText?: string
}

export function HouseAccountsModal({
  open,
  onClose,
  onSelectAccount,
  actionLabel = 'Use for checkout',
  helperText = 'Select an account to charge the current sale (on account). Create or edit accounts in Back Office.',
}: HouseAccountsModalProps) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<HouseAccountRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchKeyboardOpen, setSearchKeyboardOpen] = useState(false)
  const requestSeqRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const keyboardBlurTimerRef = useRef<number | null>(null)

  const load = useCallback(async (search: string) => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('q', search.trim())
      params.set('limit', '80')
      const rows = await apiFetch<HouseAccountRow[]>(`/house-accounts?${params.toString()}`)
      if (seq !== requestSeqRef.current) return
      setList(rows)
    } catch (e) {
      if (seq !== requestSeqRef.current) return
      setList([])
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setQ('')
    setSearchKeyboardOpen(false)
    void load('')
  }, [open, load])

  useEffect(() => {
    return () => {
      if (keyboardBlurTimerRef.current) clearTimeout(keyboardBlurTimerRef.current)
    }
  }, [])

  function cancelKeyboardBlurHide() {
    if (keyboardBlurTimerRef.current) {
      clearTimeout(keyboardBlurTimerRef.current)
      keyboardBlurTimerRef.current = null
    }
  }

  function scrollSearchFieldIntoView() {
    searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  function handleSearchKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'char') {
      setQ((s) => s + action.char)
      return
    }
    if (action.type === 'backspace') {
      setQ((s) => s.slice(0, -1))
      return
    }
    if (action.type === 'space') {
      setQ((s) => s + ' ')
      return
    }
    if (action.type === 'enter') {
      void load(q)
      setSearchKeyboardOpen(false)
      return
    }
    if (action.type === 'done') {
      setSearchKeyboardOpen(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="house-accts-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog">
        <div className="open-tabs-header">
          <h2 id="house-accts-title">House accounts</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className={searchKeyboardOpen ? 'quotes-modal-body quotes-modal-body--with-keyboard' : 'quotes-modal-body'}>
          <p className="muted" style={{ marginBottom: '0.5rem' }}>
            {helperText}
          </p>
          <div className="quotes-modal-filters">
            <input
              ref={searchInputRef}
              className="open-tabs-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void load(q)
                }
              }}
              placeholder="Search number, name, phone"
              aria-label="Search house accounts"
              inputMode={searchKeyboardOpen ? 'none' : 'search'}
              onFocus={() => {
                cancelKeyboardBlurHide()
                setSearchKeyboardOpen(true)
                window.setTimeout(() => scrollSearchFieldIntoView(), 20)
              }}
              onBlur={() => {
                cancelKeyboardBlurHide()
                keyboardBlurTimerRef.current = window.setTimeout(() => {
                  setSearchKeyboardOpen(false)
                }, 200)
              }}
            />
            <button type="button" className="btn small" disabled={loading} onClick={() => void load(q)}>
              {loading ? '…' : 'Search'}
            </button>
          </div>
          {error && <p className="error open-tabs-form-error">{error}</p>}
          <div className="quotes-modal-scroll">
            {list.length === 0 && loading ? (
              <p className="muted open-tabs-empty">Loading…</p>
            ) : list.length === 0 && !loading ? (
              <p className="muted open-tabs-empty">No active accounts match.</p>
            ) : (
              <ul className="open-tabs-list">
                {list.map((row) => (
                  <li key={row._id} className="open-tabs-li">
                    <div className="open-tabs-li-main">
                      <span className="open-tabs-li-title">
                        <strong>{row.accountNumber}</strong>
                        {row.name ? ` · ${row.name}` : ''}
                      </span>
                      <span className="muted open-tabs-li-phone">{row.phone || '—'}</span>
                      <span className="open-tabs-li-total">{row.balance.toFixed(2)}</span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted, #a8a8a8)', marginBottom: '0.35rem' }}>
                      Owed (incl. VAT){row.creditLimit != null ? ` · Limit ${row.creditLimit.toFixed(2)}` : ''}
                    </div>
                    <div className="open-tabs-li-actions">
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => {
                          onSelectAccount(row)
                          onClose()
                        }}
                      >
                        {actionLabel}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ScreenKeyboard
            visible={searchKeyboardOpen}
            onAction={handleSearchKeyboardAction}
            className="open-tabs-screen-keyboard quotes-modal-screen-keyboard"
          />
        </div>
      </div>
    </div>
  )
}
