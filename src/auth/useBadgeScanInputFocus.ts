import { useEffect, useRef, type RefObject } from 'react'

/** Retry focus until cold-start / Electron activation settles. */
const FOCUS_RETRY_DELAYS_MS = [0, 50, 150, 300, 600, 1200, 2000]

function focusBadgeInput(input: HTMLInputElement | null | undefined): void {
  if (!input || input.disabled) return
  try {
    input.focus({ preventScroll: true })
  } catch {
    input.focus()
  }
}

function isOtherEditableField(el: Element | null, scanInput: HTMLInputElement | null): boolean {
  if (!el || el === scanInput) return false
  if (el instanceof HTMLInputElement) {
    return el.type !== 'hidden' && !el.classList.contains('auth-badge-scan-input')
  }
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
}

type UseBadgeScanInputFocusOptions = {
  disabled?: boolean
  /** When true, skip blur refocus (e.g. user tapped face/camera UI). */
  pauseRefocus?: () => boolean
}

/**
 * Keeps a badge-scan input focused for USB/QR wedge scanners.
 * Retries on mount and when the window regains focus (Electron cold start).
 */
export function useBadgeScanInputFocus(
  inputRef: RefObject<HTMLInputElement>,
  active: boolean,
  options?: UseBadgeScanInputFocusOptions,
) {
  const disabled = options?.disabled ?? false
  const pauseRefocusRef = useRef(options?.pauseRefocus)
  pauseRefocusRef.current = options?.pauseRefocus

  useEffect(() => {
    if (!active || disabled) return

    let cancelled = false
    const timers: number[] = []

    function tryFocus() {
      if (cancelled) return
      focusBadgeInput(inputRef.current)
    }

    for (const delay of FOCUS_RETRY_DELAYS_MS) {
      timers.push(window.setTimeout(tryFocus, delay))
    }

    const onWindowFocus = () => tryFocus()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tryFocus()
    }

    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)

    const input = inputRef.current
    const onBlur = () => {
      window.setTimeout(() => {
        if (cancelled || disabled || !active) return
        if (pauseRefocusRef.current?.()) return
        const scanInput = inputRef.current
        if (!scanInput || document.activeElement === scanInput) return
        if (isOtherEditableField(document.activeElement, scanInput)) return
        focusBadgeInput(scanInput)
      }, 120)
    }

    if (input) input.addEventListener('blur', onBlur)

    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (input) input.removeEventListener('blur', onBlur)
    }
  }, [active, disabled, inputRef])
}
