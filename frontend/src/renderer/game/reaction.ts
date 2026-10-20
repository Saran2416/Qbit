import { el, fitCanvas } from '../lib/dom'
import type { Ticker } from '../lib/loop'
import type { GameApi, GameModule } from './main'

type Phase = 'ready' | 'waiting' | 'go' | 'tooSoon' | 'done'

const ROUNDS = 5

/**
 * Reaction-time tap. Click the pad the moment it turns green; five rounds and
 * you get your average. Uses rAF only while the "waiting" pad is pulsing.
 */
export const reactionGame: GameModule = {
  id: 'reaction',
  title: 'Reaction test',
  hint: 'tap the pad as soon as it turns green',
  description: '5 rounds — how fast are your reflexes?',

  mount: (api: GameApi) => {
    const canvas = el('canvas')
    const column = el('div', { class: 'game-column' }, [canvas])
    api.root.replaceChildren(column)

    const height = Math.min(api.height, 380)
    const width = Math.min(api.width, 380)
    const ctx = fitCanvas(canvas, width, height)

    let phase: Phase = 'ready'
    let round = 0
    let timer: number | null = null
    let armedAt = 0
    let pulse = 0
    const results: number[] = []
    let ticker: Ticker | null = null

    const stopTicker = (): void => {
      ticker?.stop()
      ticker = null
    }

    const paint = (): void => {
      ctx.clearRect(0, 0, width, height)
      const padY = 60
      const padH = height - 140

      const palette: Record<Phase, [string, string, string]> = {
        ready: ['#2b3852', '#e8eefc', 'Click to start'],
        waiting: ['#3a2b52', '#c8b6ff', 'wait for green…'],
        go: ['#1d7a54', '#eafff5', 'TAP!'],
        tooSoon: ['#7a2d2d', '#ffecec', 'too soon!'],
        done: ['#22304a', '#e8eefc', 'finished']
      }
      const [fill, textColor, label] = palette[phase]

      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.roundRect(16, padY, width - 32, padH, 18)
      ctx.fill()

      ctx.fillStyle = textColor
      ctx.textAlign = 'center'
      ctx.font = '600 22px system-ui, sans-serif'
      ctx.fillText(label, width / 2, padY + padH / 2 - 6)

      if (phase === 'waiting') {
        ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(pulse))
        ctx.fillStyle = '#c8b6ff'
        ctx.beginPath()
        ctx.arc(width / 2, padY + padH / 2 + 34, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      // Round pips
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillStyle = '#6d7f9e'
      ctx.textAlign = 'center'
      ctx.fillText(`${Math.min(round + (phase === 'ready' ? 0 : 1), ROUNDS)} / ${ROUNDS} rounds`, width / 2, padY - 22)

      // Results
      ctx.textAlign = 'left'
      ctx.font = '12px ui-monospace, monospace'
      results.forEach((ms, index) => {
        const y = padY + padH + 26 + index * 16
        ctx.fillStyle = '#9fb0cc'
        ctx.fillText(`round ${index + 1}`, 20, y)
        ctx.fillStyle = ms < 250 ? '#7ee0a8' : ms < 400 ? '#ffd166' : '#ff8a8a'
        ctx.fillText(`${ms} ms`, width - 20 - ctx.measureText(`${ms} ms`).width, y)
      })
    }

    const arm = (): void => {
      phase = 'waiting'
      pulse = 0
      const delay = 1200 + Math.random() * 2800
      timer = window.setTimeout(() => {
        phase = 'go'
        armedAt = performance.now()
        stopTicker()
        paint()
      }, delay)

      if (!ticker) {
        ticker = api.ticker(30, (dtMs) => {
          pulse += dtMs / 220
          if (phase === 'waiting') paint()
        })
        ticker.start()
      }
    }

    const finish = (): void => {
      phase = 'done'
      const average = Math.round(results.reduce((sum, value) => sum + value, 0) / Math.max(1, results.length))
      const score = Math.max(0, 600 - average)
      api.setHint(`average ${average} ms · score ${score}`)
      api.report('end', score, `avg ${average} ms`)
      paint()
    }

    const onPad = (): void => {
      switch (phase) {
        case 'ready':
        case 'done':
          results.length = 0
          round = 0
          api.setHint(reactionGame.hint)
          arm()
          break
        case 'waiting':
          if (timer !== null) window.clearTimeout(timer)
          timer = null
          phase = 'tooSoon'
          results.push(600) // penalty for guessing
          stopTicker()
          paint()
          api.setHint('too soon — that round counts as 600 ms')
          timer = window.setTimeout(() => {
            timer = null
            round++
            if (round >= ROUNDS) finish()
            else arm()
          }, 1000)
          break
        case 'go': {
          const elapsed = Math.round(performance.now() - armedAt)
          results.push(elapsed)
          round++
          if (round >= ROUNDS) finish()
          else arm()
          paint()
          break
        }
        default:
          break
      }
      paint()
    }

    canvas.addEventListener('pointerdown', onPad)
    paint()
    api.setHint(reactionGame.hint)

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      stopTicker()
      canvas.removeEventListener('pointerdown', onPad)
      column.remove()
    }
  }
}
