import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Product } from '../api/types'
import {
  autoPresetLabel,
  PRESET_ENTRY_MAX,
  type ProductPresetsState,
} from '../register/posProductPresets'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type AssignPresetModalProps = {
  open: boolean
  product: Product | null
  presetsState: ProductPresetsState
  onClose: () => void
  /** When under max entries, `replaceAtIndex` is ignored (append). When full, must be index to replace. */
  onAssign: (replaceAtIndex: number | null, category: string, subCategory: string) => void
}

function applyPresetKeyboardString(s: string, action: ScreenKeyboardAction): string {
  if (action.type === 'char') return s + action.char
  if (action.type === 'backspace') return s.slice(0, -1)
  if (action.type === 'space') return s + ' '
  if (action.type === 'enter' || action.type === 'done') return s
  return s
}

export function AssignPresetModal({
  open,
  product,
  presetsState,
  onClose,
  onAssign,
}: AssignPresetModalProps) {
  const idBase = useId()
  const catListId = `${idBase}-preset-cats`
  const subListId = `${idBase}-preset-subs`

  const [category, setCategory] = useState('')
  const [subCategory, setSubCategory] = useState('')
  const [replaceEntryIndex, setReplaceEntryIndex] = useState(0)
  const [assignPresetKbOpen, setAssignPresetKbOpen] = useState(false)

  const presetKbTargetRef = useRef<'category' | 'sub' | null>(null)
  const assignPresetKbBlurTimerRef = useRef<number | null>(null)

  const canAppend = presetsState.entries.length < PRESET_ENTRY_MAX
  const nextNum = presetsState.entries.length + 1

  const labelPreview = product ? autoPresetLabel(product) : ''

  const subSuggestions = useMemo(() => {
    const c = category.trim()
    if (!c) return []
    return presetsState.subCategoriesByCategory[c] ?? []
  }, [category, presetsState.subCategoriesByCategory])

  function cancelAssignPresetKbBlur() {
    if (assignPresetKbBlurTimerRef.current) {
      clearTimeout(assignPresetKbBlurTimerRef.current)
      assignPresetKbBlurTimerRef.current = null
    }
  }

  const handleAssignPresetKbAction = useCallback((action: ScreenKeyboardAction) => {
    cancelAssignPresetKbBlur()
    const target = presetKbTargetRef.current
    if (target === 'category') {
      setCategory((prev) => applyPresetKeyboardString(prev, action))
    } else if (target === 'sub') {
      setSubCategory((prev) => applyPresetKeyboardString(prev, action))
    }
    if (action.type === 'enter' || action.type === 'done') {
      setAssignPresetKbOpen(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      cancelAssignPresetKbBlur()
      setAssignPresetKbOpen(false)
      presetKbTargetRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setCategory('')
    setSubCategory('')
    setReplaceEntryIndex(0)
    cancelAssignPresetKbBlur()
    setAssignPresetKbOpen(false)
    presetKbTargetRef.current = null
  }, [open, product?._id])

  useEffect(() => {
    return () => cancelAssignPresetKbBlur()
  }, [])

  if (!open || !product) return null

  const canConfirm = category.trim().length > 0 && subCategory.trim().length > 0

  function confirm() {
    if (!canConfirm) return
    if (canAppend) {
      onAssign(null, category.trim(), subCategory.trim())
    } else {
      onAssign(replaceEntryIndex, category.trim(), subCategory.trim())
    }
  }

  function formatReplaceOption(e: (typeof presetsState.entries)[0], i: number) {
    return `#${i + 1} · ${e.category} › ${e.subCategory} · ${e.label}`
  }

  function onCategoryFocus() {
    cancelAssignPresetKbBlur()
    presetKbTargetRef.current = 'category'
    setAssignPresetKbOpen(true)
  }

  function onSubCategoryFocus() {
    cancelAssignPresetKbBlur()
    presetKbTargetRef.current = 'sub'
    setAssignPresetKbOpen(true)
  }

  function onPresetTextBlur() {
    cancelAssignPresetKbBlur()
    assignPresetKbBlurTimerRef.current = window.setTimeout(() => {
      assignPresetKbBlurTimerRef.current = null
      setAssignPresetKbOpen(false)
      presetKbTargetRef.current = null
    }, 200)
  }

  const inputMode = assignPresetKbOpen ? 'none' : 'text'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel panel assign-preset-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${idBase}-title`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="assign-preset-modal-scroll">
          <h2 id={`${idBase}-title`} className="assign-preset-modal-title">
            Assign to preset
          </h2>
          <p className="muted assign-preset-modal-product">
            <strong>{product.name}</strong>
            <span className="assign-preset-modal-sku"> · {product.sku}</span>
          </p>

          {canAppend ? (
            <p className="assign-preset-slot-msg">
              Adds preset <strong>#{nextNum}</strong> of {PRESET_ENTRY_MAX} (browse: Category → Sub-category → this
              item).
            </p>
          ) : (
            <label className="assign-preset-field">
              <span className="assign-preset-label">
                Replace entry (maximum {PRESET_ENTRY_MAX} presets reached)
              </span>
              <select
                className="assign-preset-select"
                value={replaceEntryIndex}
                onChange={(e) => setReplaceEntryIndex(Number(e.target.value))}
              >
                {presetsState.entries.map((e, i) => (
                  <option key={i} value={i}>
                    {formatReplaceOption(e, i)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="assign-preset-field">
            <span className="assign-preset-label">Category</span>
            <input
              className="assign-preset-input"
              type="text"
              inputMode={inputMode}
              list={catListId}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              onFocus={onCategoryFocus}
              onBlur={onPresetTextBlur}
              placeholder="Shown as first screen button"
              autoComplete="off"
            />
            <datalist id={catListId}>
              {presetsState.categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>

          <label className="assign-preset-field">
            <span className="assign-preset-label">Sub-category</span>
            <input
              className="assign-preset-input"
              type="text"
              inputMode={inputMode}
              list={subListId}
              value={subCategory}
              onChange={(e) => setSubCategory(e.target.value)}
              onFocus={onSubCategoryFocus}
              onBlur={onPresetTextBlur}
              placeholder="Shown as second screen button"
              autoComplete="off"
            />
            <datalist id={subListId}>
              {subSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>

          <p className="muted assign-preset-label-preview">
            Item button will show current name: <strong>{labelPreview}</strong> (updates if you rename the product).
          </p>

          <p className="assign-preset-confirm-line">
            {canAppend ? (
              <>
                Add <strong>{product.name}</strong> under <strong>{category.trim() || '…'}</strong> ›{' '}
                <strong>{subCategory.trim() || '…'}</strong>?
              </>
            ) : (
              <>
                Replace entry <strong>#{replaceEntryIndex + 1}</strong> with <strong>{product.name}</strong> under{' '}
                <strong>{category.trim() || '…'}</strong> › <strong>{subCategory.trim() || '…'}</strong>?
              </>
            )}
          </p>
        </div>

        <div className="assign-preset-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={confirm} disabled={!canConfirm}>
            Confirm
          </button>
        </div>

        <ScreenKeyboard
          visible={assignPresetKbOpen}
          onAction={handleAssignPresetKbAction}
          className="assign-preset-screen-keyboard"
        />
      </div>
    </div>
  )
}
