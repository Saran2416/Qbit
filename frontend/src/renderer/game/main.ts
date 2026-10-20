import type { GameEventData, GameId } from '../../shared/types'
import { api, installErrorReporting } from '../lib/bridge'
import { el, qs } from '../lib/dom'
import { Ticker } from '../lib/loop'
import { dodgeGame } from './dodge'
import { reactionGame } from './reaction'
import { rpsGame } from './rps'

export interface GameApi {
  /** Container the game renders into. */
  root: HTMLElement
  width: number
  height: number
  /** Forwards `game_event` to the backend (and to the pet, which celebrates). */
  report: (event: GameEventData['event'], score?: number, detail?: string) => void
  setHint: (text: string) => void
  close: () => void
  ticker: (fps: number, onFrame: (dtMs: number) => void) => Ticker
  /** Keyboard helper that cleans itself up on unmount. */
  onKey: (handler: (event: KeyboardEvent) => void) => void
}

export interface GameModule {
  id: GameId
  title: string
  hint: string
  description: string
  mount: (api: GameApi) => () => void
}

const GAMES: GameModule[] = [reactionGame, rpsGame, dodgeGame]

/**
 * Host for the three mini-games. `?game=reaction|rps|dodge|menu` decides what
 * starts; the menu renders in place (the window never resizes).
 */
function boot(): void {
  const bridge = api()
  const view = qs<HTMLElement>('#view')
  const title = qs<HTMLElement>('#game-title')
  const hint = qs<HTMLElement>('#game-hint')
  const closeBtn = qs<HTMLButtonElement>('#game-close')

  let dispose: (() => void) | null = null
  let current: GameId | 'menu' = 'menu'

  const params = new URLSearchParams(window.location.search)
  const requested = params.get('game')
  current = requested === 'reaction' || requested === 'rps' || requested === 'dodge' ? requested : 'menu'

  function makeApi(id: GameId): GameApi {
    const rect = view.getBoundingClientRect()
    return {
      root: view,
      width: Math.max(240, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height) - 40),
      report: (event, score, detail) => bridge.reportGame({ game: id, event, score, detail }),
      setHint: (text) => {
        hint.textContent = text
      },
      close: () => void bridge.closeGame(),
      ticker: (fps, onFrame) => new Ticker(fps, onFrame),
      onKey: (handler) => window.addEventListener('keydown', handler)
    }
  }

  function mountMenu(): void {
    dispose?.()
    dispose = null
    current = 'menu'
    title.textContent = 'Qbit arcade'
    hint.textContent = 'games are also offered while you idle'
    view.replaceChildren(
      el(
        'div',
        { class: 'menu' },
        GAMES.map((game) =>
          el(
            'button',
            {
              type: 'button',
              on: { click: () => mountGame(game.id) }
            },
            [
              el('span', { class: 'menu-name', text: game.title }),
              el('span', { class: 'menu-desc', text: game.description })
            ]
          )
        )
      )
    )
  }

  function mountGame(id: GameId): void {
    const module = GAMES.find((game) => game.id === id)
    if (!module) {
      mountMenu()
      return
    }
    dispose?.()
    view.replaceChildren()
    current = id
    title.textContent = module.title
    hint.textContent = module.hint
    const api = makeApi(id)
    api.report('start')
    dispose = module.mount(api)
  }

  closeBtn.addEventListener('click', () => void bridge.closeGame())
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void bridge.closeGame()
  })

  if (current === 'menu') mountMenu()
  else mountGame(current)
}

installErrorReporting('game')

try {
  boot()
} catch (err) {
  console.error('[qbit] game window failed to start', err)
}
