import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

/**
 * Actions emitted by {@link ScreenKeyboard}. Parent owns all text state — map these
 * in one place so the same keyboard can drive item search, future prompts, etc.
 */
export type ScreenKeyboardAction =
  | { type: 'char'; char: string }
  | { type: 'backspace' }
  | { type: 'space' }
  | { type: 'enter' }
  | { type: 'done' }

export type ScreenKeyboardProps = {
  visible: boolean
  onAction: (action: ScreenKeyboardAction) => void
  className?: string
}

/** Keeps focus in a paired `<input>` when tapping keys (call on pointerdown). */
export function retainInputFocusOnKeyPointerDown(e: ReactPointerEvent<HTMLElement>) {
  e.preventDefault()
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const
const ROW_Q = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'] as const
const ROW_A = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'] as const
const ROW_Z = ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '-', '.'] as const

function KeyChar({
  label,
  emit,
  onAction,
}: {
  label: string
  emit: string
  onAction: (action: ScreenKeyboardAction) => void
}) {
  return (
    <button
      type="button"
      className="screen-keyboard-key"
      aria-label={label}
      onPointerDown={retainInputFocusOnKeyPointerDown}
      onClick={() => onAction({ type: 'char', char: emit })}
    >
      {label}
    </button>
  )
}

function KeyAction({
  children,
  className,
  ariaLabel,
  action,
  onAction,
}: {
  children: ReactNode
  className?: string
  ariaLabel: string
  action: ScreenKeyboardAction
  onAction: (action: ScreenKeyboardAction) => void
}) {
  return (
    <button
      type="button"
      className={className ? `screen-keyboard-key ${className}` : 'screen-keyboard-key'}
      aria-label={ariaLabel}
      onPointerDown={retainInputFocusOnKeyPointerDown}
      onClick={() => onAction(action)}
    >
      {children}
    </button>
  )
}

/**
 * Touch-friendly on-screen keyboard (letters, digits, SKU punctuation).
 * Reusable: wire `onAction` to any string state or future flows.
 */
export function ScreenKeyboard({ visible, onAction, className }: ScreenKeyboardProps) {
  if (!visible) return null

  const rootClass = className ? `screen-keyboard ${className}` : 'screen-keyboard'

  return (
    <div className={rootClass} role="group" aria-label="On-screen keyboard">
      <div className="screen-keyboard-row">
        {DIGITS.map((d) => (
          <KeyChar key={d} label={d} emit={d} onAction={onAction} />
        ))}
      </div>
      <div className="screen-keyboard-row">
        {ROW_Q.map((c) => (
          <KeyChar key={c} label={c} emit={c.toLowerCase()} onAction={onAction} />
        ))}
      </div>
      <div className="screen-keyboard-row">
        {ROW_A.map((c) => (
          <KeyChar key={c} label={c} emit={c.toLowerCase()} onAction={onAction} />
        ))}
        <KeyAction
          className="screen-keyboard-key-wide"
          ariaLabel="Backspace"
          action={{ type: 'backspace' }}
          onAction={onAction}
        >
          ⌫
        </KeyAction>
      </div>
      <div className="screen-keyboard-row">
        {ROW_Z.map((c) => (
          <KeyChar key={c} label={c} emit={c} onAction={onAction} />
        ))}
      </div>
      <div className="screen-keyboard-row screen-keyboard-row-actions">
        <KeyAction
          className="screen-keyboard-key-space"
          ariaLabel="Space"
          action={{ type: 'space' }}
          onAction={onAction}
        >
          Space
        </KeyAction>
        <KeyAction ariaLabel="Enter" action={{ type: 'enter' }} onAction={onAction}>
          ↵
        </KeyAction>
        <KeyAction
          className="screen-keyboard-key-done"
          ariaLabel="Done"
          action={{ type: 'done' }}
          onAction={onAction}
        >
          Done
        </KeyAction>
      </div>
    </div>
  )
}
