import { el, fitCanvas } from '../lib/dom'
import { PROCEDURAL_META, drawPet } from '../overlay/sprite-atlas'
import type { GameApi, GameModule } from './main'

interface Block {
  x: number
  y: number
  w: number
  h: number
  vy: number
  hue: string
}

const RUN_SECONDS = 30
const PLAYER_W = 46
const PLAYER_H = 46
const LIVES = 3

/**
 * Dodge: keep the robot out of the falling blocks for 30 seconds. Arrows/A/D or
 * the mouse move it. This is the only game that runs a continuous loop, so it is
 * the one that really exercises the 30 fps ticker.
 */
export const dodgeGame: GameModule = {
  id: 'dodge',
  title: 'Dodge',
  hint: 'arrow keys / A-D or move the mouse to dodge',
  description: 'survive 30 seconds of falling blocks',

  mount: (api: GameApi) => {
    const canvas = el('canvas')
    const column = el('div', { class: 'game-column' }, [canvas])
    api.root.replaceChildren(column)

    const width = Math.min(api.width, 380)
    const height = Math.min(api.height, 380)
    const ctx = fitCanvas(canvas, width, height)
    const atlas = { kind: 'procedural' as const, meta: PROCEDURAL_META }

    const player = { x: width / 2 - PLAYER_W / 2, targetX: width / 2 - PLAYER_W / 2 }
    const keys = new Set<string>()
    const blocks: Block[] = []
    let elapsed = 0
    let spawnAt = 500
    let dodged = 0
    let lives = LIVES
    let running = true
    let hurtUntil = 0
    let frame = 0
    let facing: 1 | -1 = 1

    const startAt = performance.now()
    const ticker = api.ticker(30, (dtMs) => {
      if (!running) return
      frame += dtMs
      elapsed += dtMs / 1000

      /* input */
      const speed = 0.42 * dtMs
      if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) {
        player.targetX -= speed
        facing = -1
      }
      if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) {
        player.targetX += speed
        facing = 1
      }
      player.targetX = Math.min(Math.max(player.targetX, 4), width - PLAYER_W - 4)
      player.x += (player.targetX - player.x) * Math.min(1, dtMs / 90)

      /* level */
      spawnAt -= dtMs
      if (spawnAt <= 0) {
        const difficulty = Math.min(1, elapsed / RUN_SECONDS)
        spawnAt = 720 - difficulty * 420
        const w = 26 + Math.random() * 46
        blocks.push({
          x: Math.random() * Math.max(1, width - w),
          y: -30,
          w,
          h: 18,
          vy: 90 + Math.random() * 70 + difficulty * 140,
          hue: ['#ff8ac2', '#ffd166', '#ff6b6b', '#c084fc'][Math.floor(Math.random() * 4)]!
        })
      }

      /* blocks */
      const playerRect = { x: player.x, y: height - PLAYER_H - 6, w: PLAYER_W, h: PLAYER_H }
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!
        block.y += (block.vy * dtMs) / 1000
        if (block.y > height) {
          blocks.splice(i, 1)
          dodged++
          continue
        }
        const overlaps =
          block.x < playerRect.x + playerRect.w &&
          block.x + block.w > playerRect.x &&
          block.y < playerRect.y + playerRect.h &&
          block.y + block.h > playerRect.y
        if (overlaps) {
          blocks.splice(i, 1)
          lives--
          hurtUntil = performance.now() + 900
          api.setHint(lives > 0 ? `${lives} ${lives === 1 ? 'life' : 'lives'} left` : 'out of lives')
          if (lives <= 0) finish(false)
        }
      }

      if (running && elapsed >= RUN_SECONDS) finish(true)
      paint(playerRect, performance.now())
    })

    function finish(survived: boolean): void {
      if (!running) return
      running = false
      ticker.stop()
      const score = Math.round(elapsed * 10 + dodged * 5 + (survived ? 60 : 0))
      const detail = `${dodged} dodged · ${elapsed.toFixed(1)}s`
      api.setHint(`score ${score} · ${detail}`)
      api.report('end', score, detail)
      drawOverlayMessage(survived ? 'survived!' : 'game over', score, detail)
    }

    function drawOverlayMessage(title: string, score: number, detail: string): void {
      ctx.save()
      ctx.fillStyle = 'rgba(9,13,22,0.78)'
      ctx.fillRect(0, height / 2 - 62, width, 108)
      ctx.textAlign = 'center'
      ctx.fillStyle = '#e8eefc'
      ctx.font = '600 20px system-ui, sans-serif'
      ctx.fillText(title, width / 2, height / 2 - 26)
      ctx.font = '13px ui-monospace, monospace'
      ctx.fillStyle = '#9fb0cc'
      ctx.fillText(`score ${score} · ${detail}`, width / 2, height / 2 + 2)
      ctx.fillStyle = '#6d7f9e'
      ctx.fillText('close the window to leave', width / 2, height / 2 + 26)
      ctx.restore()
    }

    function paint(playerRect: { x: number; y: number; w: number; h: number }, now: number): void {
      ctx.clearRect(0, 0, width, height)

      // sky gradient + "ground"
      ctx.fillStyle = 'rgba(79,157,255,0.05)'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = 'rgba(126,240,255,0.10)'
      ctx.fillRect(0, height - 4, width, 4)

      for (const block of blocks) {
        ctx.fillStyle = block.hue
        ctx.beginPath()
        ctx.roundRect(block.x, block.y, block.w, block.h, 5)
        ctx.fill()
      }

      const hurt = now < hurtUntil && Math.floor(now / 90) % 2 === 0
      ctx.globalAlpha = hurt ? 0.4 : 1
      drawPet(ctx, atlas, {
        clip: 'walk',
        frame: Math.floor(frame / 70) % 8,
        x: playerRect.x + PLAYER_W / 2,
        y: playerRect.y + PLAYER_H,
        facing,
        scale: 0.7,
        look: 0,
        hovered: false,
        time: now
      })
      ctx.globalAlpha = 1

      // hud
      ctx.textAlign = 'left'
      ctx.font = '12px ui-monospace, monospace'
      ctx.fillStyle = '#9fb0cc'
      ctx.fillText(`♥ ${Math.max(0, lives)}`, 10, 18)
      ctx.textAlign = 'right'
      ctx.fillText(`${Math.max(0, Math.ceil(RUN_SECONDS - elapsed))}s`, width - 10, 18)
      ctx.textAlign = 'left'
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      keys.add(event.key)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      keys.delete(event.key)
    }
    api.onKey(onKeyDown)
    api.onKey(onKeyUp)
    window.addEventListener('keyup', onKeyUp)

    const onPointer = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const x = ((event.clientX - rect.left) / rect.width) * width
      player.targetX = Math.min(Math.max(x - PLAYER_W / 2, 4), width - PLAYER_W - 4)
    }
    canvas.addEventListener('pointermove', onPointer)
    canvas.addEventListener('pointerdown', onPointer)

    api.setHint(`♥ ${LIVES} · survive ${RUN_SECONDS}s`)
    ticker.start()
    void startAt

    return () => {
      running = false
      ticker.stop()
      canvas.removeEventListener('pointermove', onPointer)
      canvas.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      column.remove()
    }
  }
}
