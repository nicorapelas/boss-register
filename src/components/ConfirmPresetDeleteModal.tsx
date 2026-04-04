export type ConfirmPresetDeleteModalProps = {
  open: boolean
  /** e.g. "Drinks › Cold › Cola 500ml" */
  pathLabel: string
  onClose: () => void
  onConfirm: () => void
}

export function ConfirmPresetDeleteModal({
  open,
  pathLabel,
  onClose,
  onConfirm,
}: ConfirmPresetDeleteModalProps) {
  if (!open) return null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel panel confirm-preset-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-preset-delete-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-preset-delete-title" className="confirm-preset-delete-title">
          Remove preset?
        </h2>
        <p className="confirm-preset-delete-body">
          Remove this preset from this till?
        </p>
        {pathLabel ? (
          <p className="muted confirm-preset-delete-path">
            <strong>{pathLabel}</strong>
          </p>
        ) : null}
        <div className="assign-preset-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}
