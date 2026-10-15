"""Palette-quantise shipped PNGs in place (libimagequant, dithering 1.0, <=256 colours + tRNS),
keeping only the files whose error stays inside the bar the owner already accepted.

The approved boot-size lever of design/12-art-animation.md. A quantised file is a third of the
RGBA bytes on average; the cost is banding on smooth gradients, so every candidate is measured
and anything over the bar is left untouched rather than shipped worse.

The metric: composite old and new over three dark backdrops (the game never shows art on light
ground), take the per-pixel max-channel difference over every pixel visible in either, and keep
the worst backdrop's mean and 99th percentile. The bar is the worst reading of the lobby set
the owner signed off on (mean 0.86-2.93, p99 6-14) -- not a taste call made per file.

Usage (from the repo root; needs `pip install pillow imagequant numpy`, e.g. in a venv):
    python tools/png-pipeline/quantize.py client/public            # dry run: report only
    python tools/png-pipeline/quantize.py client/public --apply    # rewrite passing files

Already-palette files are skipped, so a re-run only touches new or re-exported RGBA art. Do NOT
run compress.mjs over a quantised file afterwards: it re-encodes to RGBA and undoes this
(client/src/render/shippedPngFormat.test.ts turns that red).
"""
import io, os, sys
import numpy as np, imagequant
from PIL import Image

MAX_MEAN = 2.93
MAX_P99 = 14.0
BACKDROPS = [(0, 0, 0), (16, 16, 24), (64, 64, 72)]
# design/12 2026-09-01b: the curtain stays as it is, by the owner's call.
SKIP = {'environment/door_curtain_raw.png'}


def error(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    worst_mean = worst_p99 = 0.0
    visible = np.maximum(a[..., 3], b[..., 3]) > 0
    for bg in BACKDROPS:
        bgv = np.array(bg, np.float32)
        ca = a[..., :3] * a[..., 3:] / 255 + bgv * (1 - a[..., 3:] / 255)
        cb = b[..., :3] * b[..., 3:] / 255 + bgv * (1 - b[..., 3:] / 255)
        d = np.abs(ca - cb).max(axis=2)
        dv = d[visible] if visible.any() else np.zeros(1)
        worst_mean = max(worst_mean, float(dv.mean()))
        worst_p99 = max(worst_p99, float(np.percentile(dv, 99)))
    return worst_mean, worst_p99


def main() -> None:
    root = sys.argv[1]
    apply = '--apply' in sys.argv
    saved = 0
    for dirpath, _, names in os.walk(root):
        for name in sorted(names):
            if not name.endswith('.png'):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(os.sep, '/')
            im = Image.open(path)
            if rel in SKIP or im.mode == 'P':
                continue
            src = im.convert('RGBA')
            buf = io.BytesIO()
            imagequant.quantize_pil_image(src, dithering_level=1.0, max_colors=256).save(buf, format='PNG', optimize=True)
            data = buf.getvalue()
            new = np.asarray(Image.open(io.BytesIO(data)).convert('RGBA'), dtype=np.float32)
            mean, p99 = error(np.asarray(src, dtype=np.float32), new)
            before = os.path.getsize(path)
            ok = mean <= MAX_MEAN and p99 <= MAX_P99 and len(data) < before
            verdict = 'quantise' if ok else 'KEEP RGBA'
            print(f'{verdict:9} {rel:46} {before / 1e3:7.1f} -> {len(data) / 1e3:6.1f} kB  mean {mean:4.2f} p99 {p99:4.1f}')
            if ok:
                saved += before - len(data)
                if apply:
                    with open(path, 'wb') as f:
                        f.write(data)
    print(f"{'saved' if apply else 'would save'} {saved / 1e3:.0f} kB")


if __name__ == '__main__':
    main()
