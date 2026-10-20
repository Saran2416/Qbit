import type { PetClip } from '../../shared/types'
import { clipFor, type Atlas } from './sprite-atlas'

/**
 * Frame stepping for one clip at a time. A non-looping clip (e.g. `happy`)
 * stops on its last frame and reports `isFinished`, which is what the brain
 * uses to fall back to idle without any extra timers.
 */
export class Animator {
  private clip: PetClip = 'idle'
  private frame = 0
  private elapsed = 0
  private finished = false

  constructor(private atlas: Atlas) {}

  setAtlas(atlas: Atlas): void {
    this.atlas = atlas
    this.frame = 0
    this.elapsed = 0
    this.finished = false
  }

  play(clip: PetClip, restart = false): void {
    if (this.clip === clip && !restart) return
    this.clip = clip
    this.frame = 0
    this.elapsed = 0
    this.finished = false
  }

  get current(): PetClip {
    return this.clip
  }

  get index(): number {
    return this.frame
  }

  get isFinished(): boolean {
    return this.finished
  }

  get frameCount(): number {
    return clipFor(this.atlas, this.clip).frames
  }

  update(dtMs: number): void {
    const spec = clipFor(this.atlas, this.clip)
    const frameMs = 1000 / Math.max(0.5, spec.fps)
    this.elapsed += dtMs
    while (this.elapsed >= frameMs) {
      this.elapsed -= frameMs
      if (this.frame + 1 < spec.frames) {
        this.frame++
      } else if (spec.loop) {
        this.frame = 0
      } else {
        this.finished = true
        this.elapsed = 0
        break
      }
    }
  }
}
