# Qbit sprite drop-in directory

Anything you put in here is shipped into the packaged app (`resources/sprites`)
and is also picked up straight from this folder in development.

To replace the generated placeholder robot with real art, drop two files in:

```
sprites/
  robot.json
  robot.png
```

`robot.json`:

```json
{
  "frameWidth": 64,
  "frameHeight": 64,
  "image": "robot.png",
  "renderScale": 0.75,
  "anchor": { "x": 0.5, "y": 1.0 },
  "clips": {
    "idle":  { "row": 0, "frames": 6, "fps": 6,  "loop": true },
    "walk":  { "row": 1, "frames": 8, "fps": 10, "loop": true },
    "sleep": { "row": 2, "frames": 4, "fps": 3,  "loop": true },
    "alert": { "row": 3, "frames": 6, "fps": 12, "loop": true },
    "happy": { "row": 4, "frames": 8, "fps": 12, "loop": false }
  }
}
```

* `robot.png` is a sprite sheet: one clip per row, one frame per column,
  frames laid out left to right, no padding.
* `row` is the 0-based row index, `frames` how many columns are used, `fps`
  the playback rate and `loop` whether the clip repeats or plays once and
  falls back to `idle`.
* `anchor` is the point inside a frame (0..1) that is placed on the pet's
  current position - `{x:0.5, y:1}` means "bottom centre" (feet on the ground).
* `renderScale` converts source pixels to CSS pixels: a 64px frame at `0.5`
  is drawn 32 CSS px wide.
* The pet is drawn unmirrored when walking right and mirrored when walking
  left, so design the art facing right.

Any file placed in `<userData>/sprites/robot.json` wins over this folder and is
hot-reloaded (no rebuild, no restart):

* Linux:   `~/.config/qbit-pet/sprites/`
* Windows: `%APPDATA%\qbit-pet\sprites\`

Missing clips fall back to `idle`, and a broken sheet silently falls back to the
built-in procedural robot, so you can never end up with an invisible pet.
