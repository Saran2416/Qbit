#!/usr/bin/env python3
"""Build sprites/robot.png + sprites/robot.json from sprites/avatar-source.png.

Usage:
    python3 tools/make-sprite-sheet.py            # generate the sheet
    python3 tools/make-sprite-sheet.py --debug    # + calibration / QA images

Pipeline:
    1. cut the background out against a fitted backdrop model: a degree-3
       polynomial of the studio gradient, refitted on confident pixels. Only
       what the model *explains* is eaten (true backdrop), reached from the
       frame edge - so the robot, its soft ground shadow and the cube's
       ambient-occlusion underside (all 40-200 levels off-model) survive
       the flood, and orphan specks of fit noise are dropped as islands.
    2. erase everything below the hand-traced bottom silhouette
       (BOTTOM_TRACE): the studio ground shadow is darker in its core (0.16x
       model) than the feet themselves (0.27x), so colour can never tell the
       two apart - trace the robot's real bottom edge once, cut once, and
       the sprite keeps only the robot.
    3. redraw the eyes for each expression on the full-resolution cutout
       (open / blink / closed / wide / happy-arc),
    4. trim to the robot, downscale to sprite size, then animate each clip
       with per-frame bob / tilt / jump transforms,
    4. lay out one row per clip and emit robot.json next to it.

The sheet format is documented in sprites/README.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent.parent
SRC = HERE / "sprites" / "avatar-source.png"
OUT_PNG = HERE / "sprites" / "robot.png"
OUT_JSON = HERE / "sprites" / "robot.json"

FRAME = 128          # px, minimum cell size of the sheet (renderScale 1.0 -> 1:1)
ROBOT_H = 110        # robot height inside a frame before transforms
FEET_Y = 125         # bbox bottom inside a frame (3px pad for rotation)
COLS = 8             # widest clip (walk / happy)
PAD = 6              # min transparent margin between the sprite and a cell edge;
                     # cells widen beyond FRAME when robot+shadow need it, so the
                     # art is never sliced at the frame boundary
DEBUG_DIR = Path("/tmp/opencode/sprite-debug")

# --- calibration: face features in source-pixel coords (1254x1254) ----------
EYE_L = (580, 590, 635, 702)
EYE_R = (811, 590, 866, 702)
FACE = (500, 455, 958, 830)          # the dark screen, for colour sampling
BLINK_LINE_H = 16                    # closed-eye line height at source scale
WIDE_SCALE = 1.18                    # alert eyes magnification
ARC_BROW_H = 78                      # happy-arc bbox height (shallower = cuter)

# --- background model (colour-based cutout) --------------------------------
BORDER_BAND = 40     # px band around the edge used to fit the backdrop
T_BG = 10.0          # max |pixel-model| (per channel) to call a pixel backdrop
T_BRIDGE = 20.0      # looser cap for flood *continuation* only (fit error)
EDGE_STEP = 8.0      # colour range over a 5px window that forms the silhouette
                     # wall: anti-aliasing spreads a 21-level outline step over
                     # 4-5px (only ~5/px, too soft for a per-pixel test), while
                     # a windowed range still reads the full step there - and
                     # backdrop noise stays under 6 even inside the window, so
                     # only real outlines wall off the flood
MIN_ISLAND = 600     # robot specks smaller than this (at 1/4 scale) get dropped
EDGE_DILATE = 2      # px to push the matte back out over the true edge
FEATHER = 1.4        # matte blur radius

# --- ground-shadow erase (hand-traced bottom silhouette, source coords) -----
# The studio's contact shadow under the cube measures 0.16-0.98 x the backdrop
# model - the same range as the feet (0.27-0.38) and the shaded underside - so
# no colour rule can separate shadow from robot. Trace the robot's true bottom
# edge once (cube rim between the feet, feet outline where they hang below) and
# zero the alpha below the line: everything the studio put on the floor is gone.
# Traced against avatar-source.png (1254x1254), verified with an overlay -
# everything red stayed shadow, every foot stayed inside the cut.
BOTTOM_TRACE = [
    (0, 848), (238, 852), (258, 862), (268, 876), (272, 906), (280, 934),
    (300, 944), (360, 946), (374, 928), (384, 896), (394, 884), (414, 896),
    (420, 926), (426, 970), (436, 1004), (452, 1016), (552, 1018), (570, 1008),
    (582, 978), (590, 944), (598, 918), (620, 906), (700, 898), (754, 888),
    (764, 880), (772, 922), (780, 952), (792, 966), (900, 970), (918, 958),
    (930, 928), (940, 894), (952, 868), (964, 856), (1253, 852),
]


def log(msg: str) -> None:
    print(f"[sprite] {msg}", flush=True)


def _poly_terms(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.stack(
        [np.ones_like(x), x, y, x * x, x * y, y * y, x**3, x * x * y, x * y * y, y**3],
        axis=-1,
    )


def fit_backdrop(rgb: np.ndarray) -> np.ndarray:
    """Smooth model of the studio backdrop, per channel.

    Degree-3 polynomial fitted on the border band, then refitted twice on
    border + "confident" interior pixels (those the first fit already explains
    and that are not shadow) - which pulls the mid-field error down from ~20
    to a few levels, so "white robot" and "backdrop" stay separable even
    across the soft ambient-occlusion edge under the cube.
    """
    h, w, _ = rgb.shape
    yy, xx = np.mgrid[0:h, 0:w]
    x = xx.astype(np.float64) / w - 0.5
    y = yy.astype(np.float64) / h - 0.5
    feats = _poly_terms(x, y)

    band = np.zeros((h, w), dtype=bool)
    band[:BORDER_BAND, :] = band[-BORDER_BAND:, :] = True
    band[:, :BORDER_BAND] = band[:, -BORDER_BAND:] = True

    model = np.empty_like(rgb, dtype=np.float64)
    sample = band
    for _ in range(3):
        flat = feats[sample]
        for c in range(3):
            coef, *_ = np.linalg.lstsq(flat, rgb[sample][:, c].astype(np.float64), rcond=None)
            model[:, :, c] = feats @ coef
        ratio = rgb.astype(np.float64) / np.maximum(model, 1.0)
        k = ratio.mean(axis=2)
        spread = ratio.max(axis=2) - ratio.min(axis=2)
        diff = np.abs(rgb.astype(np.float64) - model).max(axis=2)
        confident = (diff <= 6) & (k >= 0.98) & (spread <= 0.08)
        sample = band | confident

    probe = rgb[100:400, 1100:1200].astype(np.float64)
    err = np.abs(probe - model[100:400, 1100:1200]).mean()
    side = rgb[560:760, 60:220].astype(np.float64)  # plain backdrop, left of cube
    err2 = np.abs(side - model[560:760, 60:220]).mean()
    log(f"backdrop model fit: open backdrop {err:.1f}/255, left field {err2:.1f}/255")
    return model


def _flood(seed: np.ndarray, allowed: np.ndarray) -> np.ndarray:
    """Border-connected part of `allowed`, growing 4-connected from the edge."""
    h, w = allowed.shape
    mask = seed & allowed
    for _ in range(h + w):
        grown = mask.copy()
        grown[1:, :] |= mask[:-1, :]
        grown[:-1, :] |= mask[1:, :]
        grown[:, 1:] |= mask[:, :-1]
        grown[:, :-1] |= mask[:, 1:]
        grown &= allowed
        if grown.sum() == mask.sum():
            return mask
        mask = grown
    return mask


def _drop_islands(robot: np.ndarray, min_area: int) -> np.ndarray:
    """Remove robot specks that are not part of the real robot.

    Label propagation at 1/4 scale (fast, dependency-free): every robot cell
    takes the smallest label of its neighbours until stable; components below
    `min_area` cells disappear (the largest is kept regardless). Sampling at
    1/4 scale also blanks the 1-3px seams the flood may have chewed inside the
    robot - the edge dilation after this restores the outer rim.
    """
    small = robot[::4, ::4]
    h, w = small.shape
    BIG = np.iinfo(np.int64).max
    labels = np.where(small, np.arange(h * w, dtype=np.int64).reshape(h, w), BIG)
    if not (labels < BIG).any():
        return robot

    for _ in range(h + w):
        best = labels.copy()
        np.minimum(best[1:, :], labels[:-1, :], out=best[1:, :])
        np.minimum(best[:-1, :], labels[1:, :], out=best[:-1, :])
        np.minimum(best[:, 1:], labels[:, :-1], out=best[:, 1:])
        np.minimum(best[:, :-1], labels[:, 1:], out=best[:, :-1])
        best[~small] = BIG
        if np.array_equal(best, labels):
            break
        labels = best

    ids, counts = np.unique(labels[labels < BIG], return_counts=True)
    if ids.size == 0:
        return np.zeros_like(robot)
    keep_ids = ids[counts >= min_area]
    if keep_ids.size == 0:  # everything tiny: keep the biggest anyway
        keep_ids = ids[[int(np.argmax(counts))]]
    keep_small = np.isin(labels, keep_ids)

    up = np.repeat(np.repeat(keep_small, 4, axis=0), 4, axis=1)
    up = up[: robot.shape[0], : robot.shape[1]]
    return robot & up


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """True where a pixel is part of the studio backdrop.

    The fitted model `m` describes the backdrop's smooth gradient, so the rule
    is deliberately simple: eat whatever the model explains within T_BG (and
    bridge fit-error gaps up to T_BRIDGE) - but only if it is connected to the
    frame edge, only outside the silhouette wall, and after dropping orphan
    specks. Everything the model does not explain (robot, contact shadow)
    survives untouched:

      * the robot is off-model by 40-200 levels everywhere - feet, shell,
        face screen;
      * the drop shadow stays through the flood too (diff ~70) - colour can
        never separate it from the feet, so it is erased afterwards by the
        BOTTOM_TRACE cut (see cutout), never by the model;
      * that shadow then forms an un-crossable wall around the robot's base,
        shielding the cube's underside - its ambient-occlusion band is also
        120+ levels off-model and can simply never be reached by the flood
        (the old k-ratio "shadow rule" is what used to nibble it off);
      * the cube's shaded side face has a tonal zone that coincides with the
        backdrop model within ~14 levels - colour can never separate that, so
        a windowed-gradient wall (EDGE_STEP) along the outline seals the flood
        out while backdrop and face interiors (windowed range <= 6) stay open.
    """
    p = rgb.astype(np.float64)
    m = fit_backdrop(rgb)
    diff = np.abs(p - m).max(axis=2)

    # 5px-windowed colour range: robust to anti-aliased (soft) outline steps
    # that a per-pixel gradient would miss between two adjacent pixels.
    win = 2
    lo = p.copy()
    hi = p.copy()
    for axis, size in ((1, p.shape[1]), (0, p.shape[0])):
        for shift in range(1, win + 1):
            np.minimum(lo, np.roll(p, shift, axis=axis), out=lo)
            np.minimum(lo, np.roll(p, -shift, axis=axis), out=lo)
            np.maximum(hi, np.roll(p, shift, axis=axis), out=hi)
            np.maximum(hi, np.roll(p, -shift, axis=axis), out=hi)
    # np.roll wraps at the image border; force those columns/rows to "no edge"
    lo[0], hi[0] = p[0], p[0]
    lo[-1], hi[-1] = p[-1], p[-1]
    lo[:, 0], hi[:, 0] = p[:, 0], p[:, 0]
    lo[:, -1], hi[:, -1] = p[:, -1], p[:, -1]
    wall = (hi - lo).max(axis=2) >= EDGE_STEP

    # Hand-traced rear-left silhouette (this avatar): along the upper-left
    # outline the backdrop and the cube's shaded face are tonally continuous
    # (windowed range dips to 3-7 even over 9px), so no gradient threshold
    # can seal the flood there - it leaked across and ate the whole side
    # face, which coincides with the backdrop model within ~20 everywhere.
    # Force a wall along the traced line instead; everything it protects is
    # solid cube (verified against the source at 3x zoom).
    trace_y = np.array([312, 330, 350, 370, 400, 450, 500, 530, 560, 600,
                        630, 660, 690, 720, 750, 790, 820, 850, 880, 910, 935])
    trace_x = np.array([284, 262, 248, 240, 236, 236, 236, 229, 222, 219,
                        220, 225, 234, 241, 242, 244, 252, 274, 288, 288, 300])
    sline = np.interp(np.arange(wall.shape[0]), trace_y, trace_x)
    for y in range(int(trace_y[0]), int(trace_y[-1]) + 1):
        x0 = int(sline[y]) - 3   # keep a hair of the backdrop AO rim opaque
        x1 = int(sline[y]) + 12  # and seal the face side generously
        wall[y, x0:x1] = True

    strict = (diff <= T_BG) & ~wall
    loose = (diff <= T_BRIDGE) & ~wall

    seed = np.zeros(strict.shape, dtype=bool)
    seed[0, :] = strict[0, :]
    seed[-1, :] = strict[-1, :]
    seed[:, 0] = strict[:, 0]
    seed[:, -1] = strict[:, -1]

    bg = _flood(seed, strict)
    bg |= _flood(bg, loose)  # bridge fit-error gaps without new starts

    robot = ~bg
    robot = _drop_islands(robot, MIN_ISLAND)
    return ~robot


def cutout(img: Image.Image) -> Image.Image:
    rgb = np.asarray(img.convert("RGB"))
    bg = background_mask(rgb)

    robot = ~bg
    closed = robot.copy()
    closed[1:, :] |= robot[:-1, :]
    closed[:-1, :] |= robot[1:, :]
    closed[:, 1:] |= robot[:, :-1]
    closed[:, :-1] |= robot[:, 1:]
    closed |= robot

    alpha = np.where(closed, 255, 0).astype(np.uint8)
    a_img = Image.fromarray(alpha, "L")
    # push the matte back to the true silhouette and soften it by a hair
    a_img = a_img.filter(ImageFilter.MaxFilter(EDGE_DILATE * 2 + 1))
    a_img = a_img.filter(ImageFilter.GaussianBlur(FEATHER))
    out = img.convert("RGBA")
    out.putalpha(a_img)

    # drop the studio ground shadow: zero alpha below the traced bottom
    # silhouette, after the feather so the cut edge stays crisp instead of
    # letting a blurred shadow fringe creep back in along the line.
    below = Image.new("L", out.size, 0)
    ImageDraw.Draw(below).polygon(BOTTOM_TRACE + [(out.width - 1, out.height - 1), (0, out.height - 1)], fill=255)
    arr = np.asarray(out).copy()
    arr[np.asarray(below) > 0, 3] = 0
    return Image.fromarray(arr, "RGBA")


# ---------------------------------------------------------------- face edits

def sample_face_bg(rgba: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Median colour of the screen just outside `box` (for erasing features)."""
    pad = 36
    x0, y0, x1, y1 = box
    ring = (max(0, x0 - pad), max(0, y0 - pad), min(rgba.width, x1 + pad), min(rgba.height, y1 + pad))
    region = rgba.crop(ring)
    data = np.asarray(region).reshape(-1, 4)
    # keep opaque, screen-coloured pixels only (dark navy, no eyes, no shell)
    lum = data[:, :3].astype(float).mean(axis=1)
    keep = (data[:, 3] > 200) & (lum < 110)
    if keep.sum() < 50:
        keep = data[:, 3] > 200
    med = np.median(data[keep], axis=0)
    return tuple(int(v) for v in med)  # type: ignore[return-value]


def sample_cyan(rgba: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int]:
    region = np.asarray(rgba.crop(box)).reshape(-1, 4)
    bright = region[(region[:, 3] > 200) & (region[:, 1].astype(int) > 180)]
    if len(bright) == 0:
        return (125, 245, 255)
    # favour the most saturated/bright core
    core = bright[np.argsort(bright[:, 1].astype(int) + bright[:, 2].astype(int))[-30:]]
    return tuple(int(v) for v in np.median(core[:, :3], axis=0))  # type: ignore[return-value]


def rrect(draw: ImageDraw.ImageDraw, box, radius, fill) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def redraw_eyes(base: Image.Image, style: str) -> Image.Image:
    """Return a copy of the cutout with the eyes redrawn in `style`."""
    if style == "open":
        return base.copy()

    out = base.copy()
    draw = ImageDraw.Draw(out)
    cyan = sample_cyan(base, EYE_L)

    for eye in (EYE_L, EYE_R):
        x0, y0, x1, y1 = eye
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        w, h = x1 - x0, y1 - y0

        # erase: paint the screen colour over the old eye, glow included
        pad = 30
        erase = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        bg = sample_face_bg(base, eye)
        draw.rectangle(erase, fill=bg)

        # shapes are drawn on a scratch layer so they can glow
        layer = Image.new("RGBA", out.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)

        if style == "blink" or style == "closed":
            bh = BLINK_LINE_H
            box = [cx - w / 2, cy - bh / 2 + (6 if style == "blink" else 2), cx + w / 2, cy + bh / 2 + (6 if style == "blink" else 2)]
            rrect(ld, box, bh / 2, cyan + (255,))
        elif style == "wide":
            ew, eh = w * WIDE_SCALE, h * WIDE_SCALE
            box = [cx - ew / 2, cy - eh / 2, cx + ew / 2, cy + eh / 2]
            rrect(ld, box, ew / 2, cyan + (255,))
        elif style == "happy":
            # shallow upward arc ("^ ^") over where the eye was
            box = [x0 - 4, y0 - 4, x1 + 4, y0 - 4 + ARC_BROW_H]
            ld.arc(box, start=180, end=360, fill=cyan + (255,), width=17)
        else:
            raise ValueError(style)

        glow = layer.filter(ImageFilter.GaussianBlur(7))
        out.alpha_composite(glow.point(lambda v: int(v * 0.55)))
        out.alpha_composite(layer)

    return out


def draw_calibration(img: Image.Image) -> Image.Image:
    vis = img.convert("RGBA").copy()
    d = ImageDraw.Draw(vis)
    for box, colour in ((EYE_L, (255, 0, 0, 255)), (EYE_R, (255, 0, 0, 255)), (FACE, (0, 255, 0, 255))):
        d.rectangle(box, outline=colour, width=4)
    return vis


# ------------------------------------------------------------------- frames

def clip_frame(base: Image.Image, dy: float, rot: float, scale: float, frame_w: int = FRAME) -> Image.Image:
    """One sprite cell: optional scale/rotate, feet pinned at FEET_Y."""
    cell = Image.new("RGBA", (frame_w, FRAME), (0, 0, 0, 0))
    sprite = base
    if scale != 1.0:
        size = (max(1, round(sprite.width * scale)), max(1, round(sprite.height * scale)))
        sprite = sprite.resize(size, Image.LANCZOS)
    if rot:
        sprite = sprite.rotate(rot, resample=Image.BICUBIC, expand=False)
    x = round((frame_w - sprite.width) / 2)
    y = round(FEET_Y - sprite.height + dy)
    cell.alpha_composite(sprite, (x, max(0, y)))
    return cell


def build_sheet(variants: dict[str, Image.Image], frame_w: int) -> tuple[Image.Image, dict]:
    clips = {
        "idle": {"row": 0, "frames": 6, "fps": 6, "loop": True},
        "walk": {"row": 1, "frames": 8, "fps": 10, "loop": True},
        "sleep": {"row": 2, "frames": 4, "fps": 3, "loop": True},
        "alert": {"row": 3, "frames": 6, "fps": 12, "loop": True},
        "happy": {"row": 4, "frames": 8, "fps": 12, "loop": False},
    }

    plans: dict[str, list[dict]] = {
        # gentle breathing; one blink per cycle
        "idle": [
            dict(v="open", dy=0, rot=0, scale=1.00),
            dict(v="open", dy=-2, rot=0, scale=1.005),
            dict(v="open", dy=-4, rot=0, scale=1.01),
            dict(v="open", dy=-3, rot=0, scale=1.005),
            dict(v="blink", dy=-1, rot=0, scale=1.00),
            dict(v="open", dy=0, rot=0, scale=1.00),
        ],
        # bouncy two-step with alternating tilt
        "walk": [
            dict(v="open", dy=0, rot=0.0, scale=1.00),
            dict(v="open", dy=-4, rot=2.2, scale=1.00),
            dict(v="open", dy=-8, rot=3.0, scale=0.99),
            dict(v="open", dy=-5, rot=2.0, scale=1.00),
            dict(v="open", dy=-1, rot=0.0, scale=1.01),
            dict(v="open", dy=-5, rot=-2.0, scale=1.00),
            dict(v="open", dy=-8, rot=-3.0, scale=0.99),
            dict(v="open", dy=-4, rot=-2.2, scale=1.00),
        ],
        # curled up, eyes closed, slow sway
        "sleep": [
            dict(v="closed", dy=0, rot=-2.0, scale=0.97),
            dict(v="closed", dy=-1, rot=-1.0, scale=0.97),
            dict(v="closed", dy=-2, rot=1.0, scale=0.97),
            dict(v="closed", dy=-1, rot=2.0, scale=0.97),
        ],
        # wide eyes, jittering
        "alert": [
            dict(v="wide", dy=-2, rot=-2.0, scale=1.04),
            dict(v="wide", dy=-4, rot=2.0, scale=1.05),
            dict(v="wide", dy=-2, rot=-2.0, scale=1.04),
            dict(v="wide", dy=-5, rot=2.0, scale=1.05),
            dict(v="wide", dy=-3, rot=-2.0, scale=1.04),
            dict(v="wide", dy=-1, rot=0.0, scale=1.03),
        ],
        # two little hops with happy eyes (dy capped so the sprite top never
        # clips: FEET_Y - height*1.04 - 15 would start above row 0)
        "happy": [
            dict(v="happy", dy=-1, rot=0.0, scale=1.02),
            dict(v="happy", dy=-7, rot=3.0, scale=1.03),
            dict(v="happy", dy=-9, rot=0.0, scale=1.04),
            dict(v="happy", dy=-6, rot=-3.0, scale=1.03),
            dict(v="happy", dy=-2, rot=0.0, scale=1.02),
            dict(v="happy", dy=-7, rot=-3.0, scale=1.03),
            dict(v="happy", dy=-9, rot=0.0, scale=1.04),
            dict(v="happy", dy=-6, rot=3.0, scale=1.03),
        ],
    }

    rows = len(clips)
    sheet = Image.new("RGBA", (COLS * frame_w, rows * FRAME), (0, 0, 0, 0))
    for clip_name, clip in clips.items():
        for col, plan in enumerate(plans[clip_name]):
            cell = clip_frame(variants[plan["v"]], plan["dy"], plan["rot"], plan["scale"], frame_w)
            sheet.alpha_composite(cell, (col * frame_w, clip["row"] * FRAME))

    meta = {
        "frameWidth": frame_w,
        "frameHeight": FRAME,
        "image": "robot.png",
        "renderScale": 1.0,
        "anchor": {"x": 0.5, "y": round(FEET_Y / FRAME, 4)},
        "clips": clips,
    }
    return sheet, meta


def checkerboard(size) -> Image.Image:
    tile = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    step = 32
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            if (x // step + y // step) % 2 == 0:
                d.rectangle([x, y, x + step - 1, y + step - 1], fill=(96, 110, 130, 255))
            else:
                d.rectangle([x, y, x + step - 1, y + step - 1], fill=(70, 82, 100, 255))
    return tile


def main() -> None:
    debug = "--debug" in sys.argv
    if not SRC.exists():
        sys.exit(f"missing {SRC}")

    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    log(f"loading {SRC}")
    src = Image.open(SRC)

    if debug:
        draw_calibration(src.convert("RGBA")).save(DEBUG_DIR / "00-calibration.png")

    log("cutting background out (region grow)...")
    cut = cutout(src)
    if debug:
        board = checkerboard(cut.size)
        board.alpha_composite(cut)
        board.resize((627, 627), Image.LANCZOS).save(DEBUG_DIR / "01-cutout.png")

    log("drawing face variants...")
    variants = {
        "open": redraw_eyes(cut, "open"),
        "blink": redraw_eyes(cut, "blink"),
        "closed": redraw_eyes(cut, "closed"),
        "wide": redraw_eyes(cut, "wide"),
        "happy": redraw_eyes(cut, "happy"),
    }

    # one shared trim box so no expression shifts between frames
    alpha = np.asarray(cut)[:, :, 3]
    ys, xs = np.where(alpha > 8)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)

    scale = ROBOT_H / (box[3] - box[1])
    size = (max(1, round((box[2] - box[0]) * scale)), ROBOT_H)
    frame_w = max(FRAME, size[0] + 2 * PAD)
    log(f"robot bbox: {box} ({box[2] - box[0]}x{box[3] - box[1]}), sprite {size[0]}x{size[1]}, cell {frame_w}x{FRAME}")
    small = {name: v.crop(box).resize(size, Image.LANCZOS) for name, v in variants.items()}

    if debug:
        board = checkerboard((size[0] * len(small) + 16 * len(small), size[1] + 32))
        for i, (name, v) in enumerate(small.items()):
            board.alpha_composite(v, (16 + i * (size[0] + 16), 16))
            ImageDraw.Draw(board).text((16 + i * (size[0] + 16), 2), name, fill=(255, 255, 0, 255))
        board.save(DEBUG_DIR / "02-variants.png")
        big = checkerboard((frame_w * 5 + 64, FRAME + 32))
        for i, name in enumerate(["open", "blink", "happy", "wide", "closed"]):
            big.alpha_composite(clip_frame(small[name], 0, 0, 1.0, frame_w), (16 + i * (frame_w + 8), 16))
        big.save(DEBUG_DIR / "03-frames.png")

    log("building sheet...")
    sheet, meta = build_sheet(small, frame_w)
    sheet.save(OUT_PNG)
    OUT_JSON.write_text(json.dumps(meta, indent=2) + "\n")
    log(f"wrote {OUT_PNG} ({sheet.width}x{sheet.height}) and {OUT_JSON}")

    # final proof image: the whole sheet over a checkerboard
    board = checkerboard(sheet.size)
    board.alpha_composite(sheet)
    board.save(DEBUG_DIR / "04-sheet.png")
    if debug:
        log(f"debug images in {DEBUG_DIR}")


if __name__ == "__main__":
    main()
