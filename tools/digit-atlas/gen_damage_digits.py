"""Generate the floating damage-number digit atlas (design/10 "Damage numbers").

Renders the ten digits of an OFL font, plus the heal prefix "+" and the crit suffix "!", into one white-fill, dark-outline PNG strip and writes the
glyph table the client reads next to it. Run by hand after changing a constant below; both
outputs are committed, so neither the build nor CI needs Python, Pillow or the font.

    python tools/digit-atlas/gen_damage_digits.py [--font PATH]

Why a generated atlas and not image-model art: ten glyphs have to share one advance width and
one baseline to read as a number (a merged hit rewrites "38" to "41" in place and must not
jitter), and every damage type is the SAME sheet under a runtime tint, so the fill has to be
exactly white. Both are free from a font and hard to get from a generator.

Why sprites and not Pixi's BitmapText: the BitmapFont chunk is deliberately left unloaded
(design/12, build/runtimeChunkPreload.mjs), and ten fixed glyphs need none of it.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
PNG_OUT = ROOT / "client" / "public" / "ui" / "damage_digits.png"
TS_OUT = ROOT / "client" / "src" / "render" / "damageDigitAtlas.ts"

# Rubik Bold, SIL Open Font License 1.1 (https://fonts.google.com/specimen/Rubik). A rounded
# heavy face: the counters of 0/6/8/9 stay open under a thick outline at small sizes, where a
# narrow grotesque closes them up. Windows ships it with LibreOffice; any copy with the same
# SHA-256 below produces a byte-identical sheet.
DEFAULT_FONT = Path("C:/Windows/Fonts/Rubik-Bold.ttf")
FONT_NAME = "Rubik Bold"
FONT_LICENSE = "OFL-1.1"

# Glyph size in atlas pixels. The client draws a number ~24 CSS px tall and the renderer runs at
# up to 2x, so a ~48 px digit is sampled close to 1:1 on the densest screen we render for.
FONT_PX = 60
# The dark outline, in atlas pixels. Thick enough to separate a white digit from a white flash
# or a pale floor; the client's tint never touches it because it is near-black.
STROKE_PX = 5
STROKE_RGB = (16, 19, 26)
# Transparent margin around each cell, so linear filtering and the mip chain never pull a
# neighbour's outline into a glyph's edge.
GUTTER_PX = 4
DIGITS = "0123456789"
# Two marks after the digits, indexed 10 and 11: "+" leads a heal ("+12"), "!" closes a crit
# ("48!"). A crit is also gold and bigger, but design/13 wants every signal on two channels, so
# the shape says it for a player who cannot tell the colours apart.
MARKS = "+!"
GLYPHS = DIGITS + MARKS


def render(font_path: Path) -> tuple[Image.Image, dict]:
    font = ImageFont.truetype(str(font_path), FONT_PX)
    # One shared cell: the widest digit's ink box and the union of every digit's vertical ink,
    # both grown by the stroke. Measured from the ink rather than the font's advance so the
    # outline is never clipped, whatever the face's side bearings are.
    # The cell is measured over the DIGITS only, so adding a mark never moves a digit; each mark
    # must then fit inside it, which the assert below holds.
    boxes = [font.getbbox(d, stroke_width=STROKE_PX) for d in GLYPHS]
    digit_boxes = boxes[: len(DIGITS)]
    ink_w = max(b[2] - b[0] for b in digit_boxes)
    top = min(b[1] for b in digit_boxes)
    bottom = max(b[3] for b in digit_boxes)
    for m, b in zip(MARKS, boxes[len(DIGITS):]):
        assert b[2] - b[0] <= ink_w and b[1] >= top and b[3] <= bottom, f"mark {m!r} overflows the digit cell"
    cell_w = ink_w
    cell_h = bottom - top
    pitch = cell_w + 2 * GUTTER_PX
    sheet = Image.new("RGBA", (pitch * len(GLYPHS), cell_h + 2 * GUTTER_PX), (0, 0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    frames = []
    for i, (d, b) in enumerate(zip(GLYPHS, boxes)):
        x0 = i * pitch + GUTTER_PX
        # Centred in the shared cell (a tabular layout), on the shared baseline.
        ox = x0 + (cell_w - (b[2] - b[0])) // 2 - b[0]
        oy = GUTTER_PX - top
        draw.text((ox, oy), d, font=font, fill=(255, 255, 255, 255),
                  stroke_width=STROKE_PX, stroke_fill=STROKE_RGB + (255,))
        frames.append(x0)
    # How far one digit's origin sits from the next. Less than the cell: the two outlines
    # overlap by most of a stroke, which is how a heavy outlined number is normally set, and
    # without it a four-digit hit reads as four separate stickers.
    advance = cell_w - STROKE_PX - STROKE_PX // 2
    # The "!" is far narrower than a digit, so it gets its own advance by the same rule, measured
    # off its own ink: at the digits' tabular advance "48!" would read as "48 !".
    bang = boxes[len(DIGITS) + MARKS.index("!")]
    bang_advance = (bang[2] - bang[0]) - STROKE_PX - STROKE_PX // 2
    meta = {"cell_w": cell_w, "cell_h": cell_h, "frames": frames, "y": GUTTER_PX, "advance": advance,
            "bang_advance": bang_advance}
    return sheet, meta


def ts_module(meta: dict, font_sha: str, png_sha: str) -> str:
    frames = ", ".join(str(x) for x in meta["frames"])
    return f"""// GENERATED by tools/digit-atlas/gen_damage_digits.py -- do not edit; re-run the script.
// The glyph table for `/ui/damage_digits.png` (design/10 "Damage numbers"): ten digits and the
// marks "+" and "!" in {FONT_NAME} ({FONT_LICENSE}), white fill under a {STROKE_PX} px dark
// outline, one shared cell.
// Font SHA-256: {font_sha}
// Sheet SHA-256: {png_sha}

/** The atlas file, a key-for-key entry in `UI_ASSETS`. */
export const DAMAGE_DIGITS_PATH = '/ui/damage_digits.png';

export const DAMAGE_DIGIT_ATLAS = {{
  /** One digit's cell, atlas px — every digit has the same size and baseline. */
  cellW: {meta["cell_w"]},
  cellH: {meta["cell_h"]},
  /** Each glyph's cell left edge: indices 0-9 are the digits themselves, then `plus` and `bang`. */
  frameX: [{frames}] as readonly number[],
  /** The heal prefix "+". */
  plus: {len(DIGITS)},
  /** The crit suffix "!". */
  bang: {len(DIGITS) + 1},
  /** Every cell's top edge. */
  frameY: {meta["y"]},
  /** Origin-to-origin distance between two digits of one number, atlas px. */
  advance: {meta["advance"]},
  /** The "!" glyph's own share of that distance, atlas px — it is much narrower than a digit. */
  bangAdvance: {meta["bang_advance"]},
}} as const;
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--font", type=Path, default=DEFAULT_FONT)
    args = ap.parse_args()
    if not args.font.is_file():
        print(f"font not found: {args.font}", file=sys.stderr)
        return 1
    sheet, meta = render(args.font)
    PNG_OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(PNG_OUT, optimize=True)
    font_sha = hashlib.sha256(args.font.read_bytes()).hexdigest()
    png_sha = hashlib.sha256(PNG_OUT.read_bytes()).hexdigest()
    TS_OUT.write_text(ts_module(meta, font_sha, png_sha), encoding="utf-8", newline="\n")
    print(f"{PNG_OUT.relative_to(ROOT)}: {sheet.width}x{sheet.height}, {PNG_OUT.stat().st_size} bytes")
    print(f"{TS_OUT.relative_to(ROOT)}: cell {meta['cell_w']}x{meta['cell_h']}, advance {meta['advance']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
