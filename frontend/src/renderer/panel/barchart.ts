import { fitCanvas } from '../lib/dom'

export interface BarRow {
  label: string
  value: number
  color: string
  /** optional secondary text (e.g. "42m of 2h") */
  note?: string
}

const ROW_MIN_HEIGHT = 18
const LABEL_WIDTH = 96
const VALUE_WIDTH = 46

/**
 * Small horizontal bar chart drawn on canvas (no chart library, no DOM nodes
 * per app). Redrawn only when stats change - the panel is not a hot path.
 */
export function renderBars(
  canvas: HTMLCanvasElement,
  rows: BarRow[],
  valueLabel: (value: number) => string = (v) => String(Math.round(v)),
  emptyLabel = 'No activity yet'
): void {
  const cssWidth = Math.max(160, canvas.clientWidth || 320)
  const cssHeight = Math.max(60, canvas.clientHeight || 150)
  const ctx = fitCanvas(canvas, cssWidth, cssHeight)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  if (rows.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.font = '12px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(emptyLabel, LABEL_WIDTH, cssHeight / 2)
    return
  }

  const visible = rows.slice(0, Math.max(1, Math.floor(cssHeight / ROW_MIN_HEIGHT)))
  const rowHeight = Math.min(26, cssHeight / visible.length)
  const barHeight = Math.max(8, rowHeight - 8)
  const barMinX = LABEL_WIDTH + 6
  const barMaxX = cssWidth - VALUE_WIDTH
  const barWidth = Math.max(10, barMaxX - barMinX)
  const max = Math.max(1, ...visible.map((row) => row.value))

  ctx.textBaseline = 'middle'
  ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", sans-serif'

  visible.forEach((row, index) => {
    const y = index * rowHeight + rowHeight / 2

    // label
    ctx.fillStyle = 'rgba(232,238,252,0.86)'
    ctx.fillText(ellipsize(ctx, row.label, LABEL_WIDTH - 10), 0, y)

    // track
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    roundRect(ctx, barMinX, y - barHeight / 2, barWidth, barHeight, barHeight / 2)

    // value bar
    const width = Math.max(3, (row.value / max) * barWidth)
    ctx.fillStyle = row.color
    roundRect(ctx, barMinX, y - barHeight / 2, width, barHeight, barHeight / 2)

    // value
    ctx.fillStyle = 'rgba(159,176,204,0.95)'
    ctx.textAlign = 'right'
    ctx.fillText(valueLabel(row.value), cssWidth, y)
    ctx.textAlign = 'left'
  })
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, height / 2, width / 2)
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, r)
  ctx.fill()
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}
