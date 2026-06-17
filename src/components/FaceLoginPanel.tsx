import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureFaceModels,
  getActiveFaceBackend,
  loginEmbeddingFromVideo,
  resetFaceModels,
  yieldToUi,
} from '../faceAuth/faceEngine'
import { useFaceCamera } from '../faceAuth/useFaceCamera'

type FaceLoginPanelProps = {
  busy: boolean
  onLogin: (embedding: number[]) => Promise<void>
  onUseBadge: () => void
}

export function FaceLoginPanel({ busy, onLogin, onUseBadge }: FaceLoginPanelProps) {
  const { setVideoRef, videoEl, ready, error: cameraError, status: cameraStatus, retry } = useFaceCamera(true)
  const [modelsReady, setModelsReady] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [localBusy, setLocalBusy] = useState(false)
  const [backendLabel, setBackendLabel] = useState<string | null>(null)
  const recognizeInFlight = useRef(false)

  const loadModels = useCallback(() => {
    let cancelled = false
    setModelsLoading(true)
    setModelsError(null)
    setModelsReady(false)
    void ensureFaceModels()
      .then(() => {
        if (!cancelled) {
          setModelsReady(true)
          setModelsLoading(false)
          setBackendLabel(getActiveFaceBackend())
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setModelsError(e instanceof Error ? e.message : 'Failed to load face models')
          setModelsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => loadModels(), [loadModels])

  const retryModels = useCallback(() => {
    resetFaceModels()
    loadModels()
  }, [loadModels])

  const tryRecognize = useCallback(async () => {
    const video = videoEl
    if (!video || !ready || !modelsReady || busy || recognizeInFlight.current) return
    recognizeInFlight.current = true
    setLocalBusy(true)
    setStatusText('Look at the camera…')
    await yieldToUi()
    try {
      const embedding = await loginEmbeddingFromVideo(video)
      if (!embedding) {
        setStatusText('No face detected — center your face and try again')
        return
      }
      setStatusText('Signing in…')
      await onLogin(embedding)
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : 'Face login failed')
    } finally {
      recognizeInFlight.current = false
      setLocalBusy(false)
    }
  }, [videoEl, ready, modelsReady, busy, onLogin])

  useEffect(() => {
    if (!ready || !modelsReady || busy) return
    const t = window.setInterval(() => {
      if (!recognizeInFlight.current) void tryRecognize()
    }, 12000)
    return () => window.clearInterval(t)
  }, [ready, modelsReady, busy, tryRecognize])

  const disabled = busy || localBusy || !ready || !modelsReady
  const showEnableCamera = cameraStatus === 'error' || (cameraStatus === 'off' && !ready)

  let primaryLabel = 'Sign in with face'
  if (localBusy || busy) primaryLabel = 'Please wait…'
  else if (modelsLoading) primaryLabel = 'Loading face recognition…'
  else if (!ready) primaryLabel = 'Waiting for camera…'
  else if (!modelsReady) primaryLabel = 'Face recognition unavailable'

  const modelsPillLabel = modelsLoading
    ? 'Models loading…'
    : modelsReady
      ? backendLabel
        ? `Ready (${backendLabel})`
        : 'Recognition ready'
      : modelsError
        ? 'Models error'
        : 'Models pending'

  const cameraPillLabel =
    cameraStatus === 'live'
      ? 'Camera live'
      : cameraStatus === 'error'
        ? 'Camera error'
        : cameraStatus === 'requesting'
          ? 'Starting…'
          : 'Camera waiting'

  return (
    <div className="face-login-panel">
      <div className="face-login-preview-card" aria-live="polite">
        <div className="face-login-preview-status-row">
          <span
            className={`face-login-preview-pill face-login-preview-pill--${cameraStatus === 'live' ? 'live' : cameraStatus === 'error' ? 'error' : 'pending'}`}
          >
            {cameraPillLabel}
          </span>
          <span
            className={`face-login-preview-pill face-login-preview-pill--${modelsReady ? 'live' : modelsError ? 'error' : 'pending'}`}
          >
            {modelsPillLabel}
          </span>
        </div>
        <div className="face-login-preview-wrap">
          <video
            ref={setVideoRef}
            className="face-login-video"
            playsInline
            muted
            autoPlay
            aria-label="Webcam preview for face login"
          />
          {!ready ? (
            <div className="face-login-preview-overlay muted">
              {cameraStatus === 'requesting' ? 'Starting…' : 'Preview'}
            </div>
          ) : null}
        </div>
      </div>

      {cameraError ? <p className="error face-login-inline-error">{cameraError}</p> : null}
      {showEnableCamera ? (
        <button type="button" className="btn secondary face-login-btn" disabled={busy || localBusy} onClick={() => void retry()}>
          Enable camera
        </button>
      ) : null}
      {modelsError ? (
        <>
          <p className="error face-login-inline-error">{modelsError}</p>
          <button type="button" className="btn secondary face-login-btn" disabled={modelsLoading} onClick={retryModels}>
            Retry face recognition
          </button>
        </>
      ) : null}
      {statusText ? <p className="muted face-login-status">{statusText}</p> : null}
      <div className="face-login-actions">
        <button
          type="button"
          className="btn primary face-login-btn"
          disabled={disabled}
          onClick={() => void tryRecognize()}
        >
          {primaryLabel}
        </button>
        <button type="button" className="btn ghost face-login-btn" disabled={busy || localBusy} onClick={onUseBadge}>
          Type badge manually
        </button>
      </div>
    </div>
  )
}
