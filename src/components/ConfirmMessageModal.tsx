import type { ReactNode } from 'react'

export type ConfirmMessageModalProps = {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onClose: () => void
  onConfirm: () => void
  /** Primary for neutral confirms; danger for destructive actions (default). */
  confirmVariant?: 'danger' | 'primary'
  /**
   * When true, stacks above full-screen POS layers (e.g. Open tabs dialog at z-index 2000).
   * Default false for modals opened from the main register surface.
   */
  stackOnPosOverlay?: boolean
}

export function ConfirmMessageModal({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onClose,
  onConfirm,
  confirmVariant = 'danger',
  stackOnPosOverlay = false,
}: ConfirmMessageModalProps) {
  if (!open) return null

  const backdropClass = stackOnPosOverlay
    ? 'modal-backdrop modal-backdrop--pos-top'
    : 'modal-backdrop'

  return (
    <div className={backdropClass} role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel panel confirm-preset-delete-modal confirm-message-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-message-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-message-modal-title" className="confirm-preset-delete-title">
          {title}
        </h2>
        <div className="confirm-preset-delete-body">{children}</div>
        <div className="assign-preset-actions confirm-message-modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={confirmVariant === 'primary' ? 'btn primary' : 'btn danger'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
