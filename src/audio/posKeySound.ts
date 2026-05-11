const STORAGE_KEY = 'electropos-pos-key-sound-enabled'

export function readPosKeySoundEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === null) return true
    return v === '1' || v === 'true'
  } catch {
    return true
  }
}

export function writePosKeySoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

let ctx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!ctx || ctx.state === 'closed') ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

/** Short mechanical-style tap for buttons / keypad (no asset file). */
export function playPosKeySound(): void {
  if (!readPosKeySoundEnabled()) return

  const audioCtx = getAudioContext()
  if (!audioCtx) return

  const beep = () => {
    try {
      const t0 = audioCtx.currentTime
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(920, t0)
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.055, t0 + 0.004)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.038)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.042)
    } catch {
      /* ignore */
    }
  }

  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().then(beep).catch(() => {})
    return
  }
  beep()
}
