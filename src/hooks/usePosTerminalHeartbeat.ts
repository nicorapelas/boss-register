import { useEffect } from 'react'
import { sendPosTerminalHeartbeat } from '../network/posTerminalHeartbeat'

const HEARTBEAT_INTERVAL_MS = 45_000

/** Register this till with the server while a cashier session is active. */
export function usePosTerminalHeartbeat(sessionActive: boolean) {
  useEffect(() => {
    if (!sessionActive) return
    let cancelled = false

    const tick = async () => {
      try {
        await sendPosTerminalHeartbeat()
      } catch {
        /* non-blocking — connection banner handles offline */
      }
    }

    void tick()
    const timer = window.setInterval(() => {
      if (!cancelled) void tick()
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionActive])
}
