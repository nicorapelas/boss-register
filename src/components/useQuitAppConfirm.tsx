import { useCallback, useState } from 'react'
import { ConfirmMessageModal } from './ConfirmMessageModal'

type UseQuitAppConfirmOptions = {
  /** Return false to block opening the quit dialog (e.g. cart not empty). */
  beforeQuit?: () => boolean
  /** Raise above full-screen POS dialogs (register). */
  stackOnPosOverlay?: boolean
}

export function useQuitAppConfirm(options: UseQuitAppConfirmOptions = {}) {
  const { beforeQuit, stackOnPosOverlay = false } = options
  const [open, setOpen] = useState(false)

  const requestQuit = useCallback(() => {
    if (!window.electronApp) return
    if (beforeQuit && !beforeQuit()) return
    setOpen(true)
  }, [beforeQuit])

  const closeQuitConfirm = useCallback(() => setOpen(false), [])

  const confirmQuit = useCallback(() => {
    setOpen(false)
    void window.electronApp?.quit()
  }, [])

  const quitConfirmModal = (
    <ConfirmMessageModal
      open={open}
      title="Exit CogniPOS?"
      confirmLabel="Exit app"
      cancelLabel="Cancel"
      confirmVariant="primary"
      stackOnPosOverlay={stackOnPosOverlay}
      onClose={closeQuitConfirm}
      onConfirm={confirmQuit}
    >
      <p className="muted confirm-preset-delete-body">
        Close the till application on this device? Unsaved work in open dialogs will be lost.
      </p>
    </ConfirmMessageModal>
  )

  return { requestQuit, quitConfirmModal }
}
