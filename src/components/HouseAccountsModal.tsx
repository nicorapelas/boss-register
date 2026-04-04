import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { HouseAccountRow } from '../api/types'

export type HouseAccountsModalProps = {
  open: boolean
  onClose: () => void
  /** Called when user confirms selection for checkout */
  onSelectForCheckout: (account: HouseAccountRow) => void
}

export function HouseAccountsModal({ open, onClose, onSelectForCheckout }: HouseAccountsModalProps) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<HouseAccountRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)

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
    void load('')
  }, [open, load])

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
        <div className="quotes-modal-body">
          <p className="muted" style={{ marginBottom: '0.5rem' }}>
            Select an account to charge the current sale (on account). Create or edit accounts in Back Office.
          </p>
          <div className="quotes-modal-filters">
            <input
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
                          onSelectForCheckout(row)
                          onClose()
                        }}
                      >
                        Use for checkout
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
