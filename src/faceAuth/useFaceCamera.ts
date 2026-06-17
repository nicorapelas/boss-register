import { useCallback, useEffect, useRef, useState } from 'react'

export type FaceCameraStatus = 'off' | 'requesting' | 'live' | 'error'

const VIDEO_CONSTRAINTS: MediaStreamConstraints[] = [
  { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
  { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
  { video: true, audio: false },
]

function describeMediaError(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotFoundError') return 'No camera found on this till'
    if (e.name === 'NotAllowedError') return 'Camera permission denied'
    if (e.name === 'NotReadableError') return 'Camera is in use by another app'
    if (e.name === 'OverconstrainedError') return 'Camera does not support the requested mode'
    return e.message || e.name
  }
  return e instanceof Error ? e.message : 'Could not access camera'
}

async function playVideoPreview(video: HTMLVideoElement, stream: MediaStream): Promise<void> {
  video.srcObject = stream
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      video.removeEventListener('loadedmetadata', onMeta)
      window.clearTimeout(timer)
      fn()
    }
    const onMeta = () => done(resolve)
    const timer = window.setTimeout(() => done(() => reject(new Error('Camera preview timeout'))), 10_000)
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      done(resolve)
      return
    }
    video.addEventListener('loadedmetadata', onMeta)
  })
  await video.play()
}

export function useFaceCamera(enabled: boolean) {
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef(0)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<FaceCameraStatus>('off')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachTick, setAttachTick] = useState(0)

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    setVideoEl(node)
    if (node) setAttachTick((n) => n + 1)
  }, [])

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const video = videoRef.current
    if (video) video.srcObject = null
    setReady(false)
  }, [])

  const attachStream = useCallback(async (session: number) => {
    const video = videoRef.current
    const stream = streamRef.current
    if (!enabled || session !== sessionRef.current || !video || !stream) return

    setStatus('requesting')
    setReady(false)
    try {
      await playVideoPreview(video, stream)
      if (session !== sessionRef.current) return
      setReady(true)
      setStatus('live')
      setError(null)
    } catch (e) {
      if (session !== sessionRef.current) return
      setReady(false)
      setStatus('error')
      setError(e instanceof Error ? e.message : 'Could not start video preview')
    }
  }, [enabled])

  const startCamera = useCallback(async () => {
    if (!enabled) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera API is not available in this window')
      setStatus('error')
      setReady(false)
      return
    }

    const session = ++sessionRef.current
    stopTracks()
    setError(null)
    setReady(false)
    setStatus('requesting')

    let lastError: unknown = null
    for (const constraints of VIDEO_CONSTRAINTS) {
      if (session !== sessionRef.current) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (session !== sessionRef.current) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        setAttachTick((n) => n + 1)
        await attachStream(session)
        return
      } catch (e) {
        lastError = e
      }
    }

    if (session !== sessionRef.current) return
    setError(describeMediaError(lastError))
    setStatus('error')
    setReady(false)
  }, [attachStream, enabled, stopTracks])

  useEffect(() => {
    if (!enabled) {
      sessionRef.current += 1
      stopTracks()
      setStatus('off')
      setError(null)
      return
    }
    void startCamera()
    return () => {
      sessionRef.current += 1
      stopTracks()
      setStatus('off')
      setReady(false)
    }
  }, [enabled, startCamera, stopTracks])

  useEffect(() => {
    if (!enabled || !streamRef.current || !videoRef.current) return
    void attachStream(sessionRef.current)
  }, [attachStream, attachTick, enabled])

  return { setVideoRef, videoEl, ready, error, status, retry: startCamera, stop: stopTracks }
}
