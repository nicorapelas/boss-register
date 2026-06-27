import { execFileSync } from 'node:child_process'
import { screen } from 'electron'

const TOUCH_MATCH = 'CoolTouch'

function touchDeviceName(): string | null {
  try {
    const out = execFileSync('xinput', ['list', '--name-only'], {
      encoding: 'utf8',
      env: process.env,
    })
    const line = out.split('\n').find((name) => name.includes(TOUCH_MATCH))
    return line?.trim() || null
  } catch {
    return null
  }
}

function setTouchMatrix(name: string, matrix: number[]): void {
  try {
    execFileSync(
      'xinput',
      ['set-prop', name, '--type=float', 'Coordinate Transformation Matrix', ...matrix.map(String)],
      { env: process.env },
    )
  } catch (err) {
    console.warn('[operator-touch-map] xinput failed', err)
  }
}

/** Map CoolTouch to primary display when multiple monitors are connected (NCR + customer screen). */
export function mapOperatorTouchToPrimary(): void {
  if (process.platform !== 'linux') return

  const touchName = touchDeviceName()
  if (!touchName) return

  const displays = screen.getAllDisplays()
  if (displays.length <= 1) {
    setTouchMatrix(touchName, [1, 0, 0, 0, 1, 0, 0, 0, 1])
    return
  }

  const totalW = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const totalH = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  if (totalW <= 0 || totalH <= 0) return

  const primary = screen.getPrimaryDisplay()
  const { x, y, width, height } = primary.bounds
  if (width <= 0 || height <= 0) return

  setTouchMatrix(touchName, [width / totalW, 0, x / totalW, 0, height / totalH, y / totalH, 0, 0, 1])
}

export function initOperatorTouchMap(): void {
  if (process.platform !== 'linux') return

  const remap = () => {
    try {
      mapOperatorTouchToPrimary()
    } catch (err) {
      console.warn('[operator-touch-map] remap failed', err)
    }
  }

  screen.on('display-added', remap)
  screen.on('display-removed', remap)
  screen.on('display-metrics-changed', remap)
  setTimeout(remap, 1500)
  setTimeout(remap, 4000)
}
