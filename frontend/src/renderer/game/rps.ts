import type { PetClip } from '../../shared/types'
import { el, fitCanvas } from '../lib/dom'
import { PROCEDURAL_META, drawPet } from '../overlay/sprite-atlas'
import type { GameApi, GameModule } from './main'

type Pick = 'rock' | 'paper' | 'scissors'
type Phase = 'choose' | 'thinking' | 'reveal' | 'done'

const PICKS: Pick[] = ['rock', 'paper', 'scissors']
const BEATS: Record<Pick, Pick> = { rock: 'scissors', paper: 'rock', scissors: 'paper' }
const EMOJI: Record<Pick, string> = { rock: '✊', paper: '✋', scissors: '✌️' }
const BEST_OF = 5

/**
 * Rock paper scissors, best of five. The robot's own art is reused for the
 * reaction faces: it jumps when it loses and celebrates when it wins.
 */
export const rpsGame: GameModule = {
  id: 'rps',
  title: 'Rock paper scissors',
  hint: 'best of five — good luck',
  description: 'best of 5 against the robot',

  mount: (api: GameApi) => {
    const canvas = el('canvas')
    const controls = el('div', { class: 'rps-controls' })
    const buttons = PICKS.map((pick) =>
      el('button', {
        type: 'button',
        text: `${EMOJI[pick]} ${pick}`,
        on: { click: () => play(pick) }
      })
    )
    const label = el('div', { class: 'round-label', text: `round 1 / ${BEST_OF}` })
    const column = el('div', { class: 'game-column' }, [canvas, controls, label])
    api.root.replaceChildren(column)
    for (const button of buttons) controls.append(button)

    const width = Math.min(api.width, 380)
    const height = Math.min(api.height, 320)
    const ctx = fitCanvas(canvas, width, height)
    const atlas = { kind: 'procedural' as const, meta: PROCEDURAL_META }

    let phase: Phase = 'choose'
    let round = 0
    let playerWins = 0
    let robotWins = 0
    let draws = 0
    let playerPick: Pick | null = null
    let robotPick: Pick | null = null
    let robotMood: PetClip = 'idle'
    let outcome = ''
    let wiggle = 0
    let timer: number | null = null
    let ticker = api.ticker(30, (dtMs) => {
      wiggle += dtMs / 90
      if (phase === 'thinking') paint()
    })

    function paint(): void {
      ctx.clearRect(0, 0, width, height)

      ctx.textAlign = 'center'
      ctx.font = '600 13px system-ui, sans-serif'
      ctx.fillStyle = '#9fb0cc'
      ctx.fillText('you', width * 0.26, 22)
      ctx.fillText('qbit', width * 0.74, 22)

      ctx.font = '34px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif'
      ctx.fillStyle = '#e8eefc'
      ctx.fillText(playerPick ? EMOJI[playerPick] : '❔', width * 0.26, 66)
      if (phase === 'reveal' || phase === 'done') {
        ctx.fillText(robotPick ? EMOJI[robotPick] : '❔', width * 0.74, 66)
      } else {
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(wiggle))
        ctx.fillText('❔', width * 0.74, 66)
        ctx.globalAlpha = 1
      }

      // the robot itself reacts: happy when we win, alert when it wins
      const bob = phase === 'thinking' ? Math.sin(wiggle * 0.6) * 1.4 : 0
      drawPet(ctx, atlas, {
        clip: robotMood,
        frame: Math.floor(wiggle / (robotMood === 'happy' ? 0.6 : 2)) % 8,
        x: width * 0.74,
        y: height - 24 + bob,
        facing: -1,
        scale: 1.15,
        look: -1,
        hovered: false,
        time: performance.now()
      })

      if (outcome) {
        ctx.font = '600 15px system-ui, sans-serif'
        ctx.fillStyle = outcome.startsWith('you win') ? '#7ee0a8' : outcome.startsWith('qbit') ? '#ff8a8a' : '#ffd166'
        ctx.fillText(outcome, width / 2, height - 12)
      }
    }

    function setButtonsEnabled(enabled: boolean): void {
      for (const button of buttons) button.disabled = !enabled
    }

    function play(pick: Pick): void {
      if (phase === 'thinking' || phase === 'done') return
      playerPick = pick
      phase = 'thinking'
      outcome = ''
      robotPick = null
      robotMood = 'idle'
      setButtonsEnabled(false)
      ticker.start()
      paint()

      timer = window.setTimeout(() => {
        timer = null
        robotPick = PICKS[Math.floor(Math.random() * PICKS.length)]!
        round++
        if (robotPick === playerPick) {
          draws++
          outcome = 'draw'
          robotMood = 'idle'
        } else if (BEATS[playerPick!] === robotPick) {
          playerWins++
          outcome = 'you win'
          robotMood = 'alert' // the robot is shocked
        } else {
          robotWins++
          outcome = 'qbit wins'
          robotMood = 'happy'
        }
        label.textContent = `round ${Math.min(round + 1, BEST_OF)} / ${BEST_OF} · you ${playerWins} — qbit ${robotWins}${draws ? ` (${draws} draws)` : ''}`
        phase = round >= BEST_OF ? 'done' : 'reveal'
        ticker.stop()
        paint()

        if (phase === 'done') {
          const score = playerWins * 100 - robotWins * 20
          api.setHint(`you ${playerWins} — qbit ${robotWins}`)
          api.report('end', score, `wins ${playerWins}/${BEST_OF}`)
          setButtonsEnabled(false)
        } else {
          window.setTimeout(() => {
            if (phase !== 'reveal') return
            phase = 'choose'
            setButtonsEnabled(true)
            robotMood = 'idle'
            paint()
          }, 900)
        }
      }, 650)
    }

    setButtonsEnabled(true)
    paint()
    api.setHint(rpsGame.hint)

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      ticker.stop()
      column.remove()
    }
  }
}
