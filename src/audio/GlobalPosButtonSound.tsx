import { useEffect } from 'react'
import { playPosKeySound } from './posKeySound'

function findClickableTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  const el = target.closest(
    'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
  )
  return el
}

function isDisabledControl(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true
  if (el instanceof HTMLButtonElement) return el.disabled
  if (el instanceof HTMLInputElement) {
    const t = el.type
    if (t === 'button' || t === 'submit' || t === 'reset') return el.disabled
  }
  return false
}

/** Document-level capture listener so every button-like control plays the POS tap sound (respects Settings toggle). */
export function GlobalPosButtonSound() {
  useEffect(() => {
    const onClickCapture = (e: MouseEvent) => {
      const el = findClickableTarget(e.target)
      if (!el) return
      if (isDisabledControl(el)) return
      playPosKeySound()
    }
    document.addEventListener('click', onClickCapture, true)
    return () => document.removeEventListener('click', onClickCapture, true)
  }, [])
  return null
}
