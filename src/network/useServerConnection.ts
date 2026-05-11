import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getServerHealthUrl,
  markServerReachable,
  markServerUnreachable,
  subscribeServerReachability,
} from '../api/client'

export function useServerConnection() {
  const [reachable, setReachable] = useState(true)
  const [showRecovered, setShowRecovered] = useState(false)
  const prevReachableRef = useRef<boolean | null>(null)

  useEffect(() => subscribeServerReachability(setReachable), [])

  useEffect(() => {
    const onOffline = () => markServerUnreachable()
    const onOnline = () => {
      void probeServerHealth()
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const schedule = (ms: number) => {
      timer = window.setTimeout(() => {
        void tick()
      }, ms)
    }

    const tick = async () => {
      await probeServerHealth()
      if (cancelled) return
      schedule(reachable ? 20000 : 5000)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [reachable])

  useEffect(() => {
    const prev = prevReachableRef.current
    prevReachableRef.current = reachable

    if (!reachable) {
      setShowRecovered(false)
      return
    }

    // Only show after offline→online, not on mount while already connected (shell may remount per route).
    if (prev !== false) return

    setShowRecovered(true)
    const timer = window.setTimeout(() => setShowRecovered(false), 2500)
    return () => window.clearTimeout(timer)
  }, [reachable])

  return useMemo(
    () => ({
      disconnected: !reachable,
      recovered: showRecovered && reachable,
    }),
    [reachable, showRecovered],
  )
}

async function probeServerHealth() {
  const healthUrl = getServerHealthUrl()
  if (!healthUrl) {
    markServerUnreachable()
    return
  }
  try {
    const res = await fetch(healthUrl, { method: 'GET', cache: 'no-store' })
    if (res.ok) markServerReachable()
    else markServerUnreachable()
  } catch {
    markServerUnreachable()
  }
}
