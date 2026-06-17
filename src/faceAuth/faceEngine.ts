import * as faceapi from '@vladmandic/face-api'

let modelsLoaded = false
let modelsLoading: Promise<void> | null = null
let tfBackendReady: Promise<void> | null = null
let activeBackend: string | null = null

/** Smaller input = faster inference on tills (Posiflex CPU/WASM). */
const DETECTOR = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
const DETECT_MAX_WIDTH = 320

/** Absolute URL so face-api can fetch weights under Electron file:// and Vite dev. */
function resolveModelBase(): string {
  const base = import.meta.env.BASE_URL || '/'
  const rel = `${base.endsWith('/') ? base : `${base}/`}models/face-api`
  if (typeof window !== 'undefined' && window.location?.href) {
    try {
      return new URL(rel, window.location.href).href.replace(/\/?$/, '')
    } catch {
      /* fall through */
    }
  }
  return rel.replace(/\/?$/, '')
}

export function getFaceModelBaseUrl(): string {
  return resolveModelBase()
}

export function getActiveFaceBackend(): string | null {
  return activeBackend
}

export function resetFaceModels(): void {
  modelsLoaded = false
  modelsLoading = null
  tfBackendReady = null
  activeBackend = null
}

/** Let React paint loading state before blocking the main thread on inference. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0)
    })
  })
}

type TfRuntime = {
  setBackend: (name: string) => Promise<boolean>
  ready: () => Promise<void>
  getBackend?: () => string
}

/** TensorFlow must be ready before face-api loads weights or runs inference. */
async function ensureTfBackend(): Promise<void> {
  if (tfBackendReady) return tfBackendReady
  const tf = faceapi.tf as unknown as TfRuntime
  const isElectron = typeof window !== 'undefined' && Boolean(window.electronApp)
  const backends = isElectron ? ['wasm', 'webgl', 'cpu'] : ['webgl', 'wasm', 'cpu']

  tfBackendReady = (async () => {
    let lastErr: unknown
    for (const name of backends) {
      try {
        const ok = await tf.setBackend(name)
        if (!ok) continue
        await tf.ready()
        activeBackend = tf.getBackend?.() ?? name
        return
      } catch (e) {
        lastErr = e
      }
    }
    const msg =
      lastErr instanceof Error
        ? lastErr.message
        : 'TensorFlow.js could not start (cpu, wasm, or webgl)'
    throw new Error(msg)
  })()

  return tfBackendReady
}

function videoFrameCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const vw = video.videoWidth || 640
  const vh = video.videoHeight || 480
  const scale = Math.min(1, DETECT_MAX_WIDTH / vw)
  const w = Math.max(1, Math.round(vw * scale))
  const h = Math.max(1, Math.round(vh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas not available')
  ctx.drawImage(video, 0, 0, w, h)
  return canvas
}

export async function ensureFaceModels(): Promise<void> {
  if (modelsLoaded) return
  if (!modelsLoading) {
    const modelBase = resolveModelBase()
    modelsLoading = (async () => {
      await ensureTfBackend()
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelBase),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelBase),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelBase),
      ])
      modelsLoaded = true
    })().catch((e) => {
      modelsLoading = null
      tfBackendReady = null
      activeBackend = null
      const hint = e instanceof Error ? e.message : 'Failed to load face models'
      throw new Error(
        `${hint} (from ${modelBase}). If this persists after deploy, reinstall the POS build.`,
      )
    })
  }
  await modelsLoading
}

async function embeddingFromInput(input: HTMLVideoElement | HTMLCanvasElement): Promise<number[] | null> {
  await ensureFaceModels()
  const det = await faceapi
    .detectSingleFace(input, DETECTOR)
    .withFaceLandmarks(true)
    .withFaceDescriptor()
  if (!det?.descriptor) return null
  return Array.from(det.descriptor)
}

/** Single fast capture for POS login (one face pass, downscaled frame). */
export async function loginEmbeddingFromVideo(video: HTMLVideoElement): Promise<number[] | null> {
  const frame = videoFrameCanvas(video)
  return embeddingFromInput(frame)
}

export async function embeddingFromVideo(video: HTMLVideoElement): Promise<number[] | null> {
  return loginEmbeddingFromVideo(video)
}

/** Multiple samples for Back Office enrollment — still one inference per sample. */
export async function collectFaceSamples(
  video: HTMLVideoElement,
  count: number,
  intervalMs: number,
): Promise<number[][]> {
  const samples: number[][] = []
  for (let i = 0; i < count; i++) {
    const emb = await loginEmbeddingFromVideo(video)
    if (emb) samples.push(emb)
    if (i < count - 1 && intervalMs > 0) {
      await new Promise((r) => window.setTimeout(r, intervalMs))
    }
  }
  return samples
}
