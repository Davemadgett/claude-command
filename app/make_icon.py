#!/usr/bin/env python3
"""Generate the app icon: a boxed mark around a kanban board.

Drawn at 4x and downsampled, which is cheaper than fighting PIL's aliasing.
"""
from PIL import Image, ImageDraw
import os
import subprocess
import sys

S = 4  # supersample factor
N = 1024 * S

# A deep green, plus lighter steps of it, so
# the mark stays legible at Dock size against a near-black ground.
BRAND = (6, 88, 22)
BRAND_LIT = (79, 181, 106)
BG_TOP = (17, 32, 22)
BG_BOT = (7, 11, 9)
COL_BG = (20, 33, 25)
COL_BORDER = (38, 66, 46)
CARD = (43, 74, 52)
CARD_HI = (60, 104, 72)
ACCENT = BRAND_LIT
LIVE = (110, 214, 132)
VIOLET = (150, 199, 165)


def px(v):
    return int(round(v * S))


def rounded(draw, box, radius, **kw):
    draw.rounded_rectangle([px(box[0]), px(box[1]), px(box[2]), px(box[3])], radius=px(radius), **kw)


def main(out_png):
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))

    # Squircle body with a vertical gradient, masked to the rounded shape.
    grad = Image.new('RGB', (1, 1024))
    gd = ImageDraw.Draw(grad)
    for y in range(1024):
        t = y / 1023
        gd.point((0, y), fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))
    grad = grad.resize((N, N))

    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [px(100), px(100), px(924), px(924)], radius=px(190), fill=255
    )
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # The logo is a wordmark inside a ruled box — echo that box on the icon.
    d.rounded_rectangle(
        [px(100), px(100), px(924), px(924)], radius=px(190), outline=(52, 92, 62), width=px(3)
    )
    d.rounded_rectangle(
        [px(168), px(168), px(856), px(856)], radius=px(130), outline=BRAND_LIT, width=px(9)
    )

    # Terminal prompt mark, centred above the board — these are terminal sessions.
    cy, arm = 262, 46
    group_w = arm + 40 + 104
    x_start = 512 - group_w / 2
    cx = x_start + arm
    d.line([(px(cx - arm), px(cy - arm)), (px(cx), px(cy)), (px(cx - arm), px(cy + arm))],
           fill=ACCENT, width=px(22), joint='curve')
    rounded(d, (cx + 40, cy - 15, cx + 144, cy + 15), 10, fill=ACCENT)

    # Three columns, sized so the cards fill them rather than floating at the top.
    top, bottom = 360, 800
    left, width, gap = 220, 168, 40
    for i in range(3):
        x0 = left + i * (width + gap)
        rounded(d, (x0, top, x0 + width, bottom), 26, fill=COL_BG, outline=COL_BORDER, width=px(4))

    # Cards thin out left to right, the way a board in motion looks.
    layout = [
        [(0, ACCENT), (0, None), (0, None)],
        [(1, LIVE), (1, None)],
        [(2, VIOLET)],
    ]
    card_h, card_gap, pad = 104, 26, 20
    for column in layout:
        for slot, (col_index, bar) in enumerate(column):
            x0 = left + col_index * (width + gap) + pad
            x1 = x0 + width - 2 * pad
            y0 = top + 30 + slot * (card_h + card_gap)
            rounded(d, (x0, y0, x1, y0 + card_h), 18, fill=CARD_HI if bar else CARD)
            if bar:
                rounded(d, (x0, y0, x0 + 16, y0 + card_h), 8, fill=bar)

    img = img.resize((1024, 1024), Image.LANCZOS)
    img.save(out_png)
    print(f'wrote {out_png}')


def build_icns(png, icns):
    iconset = icns.replace('.icns', '.iconset')
    os.makedirs(iconset, exist_ok=True)
    sizes = [16, 32, 128, 256, 512]
    for s in sizes:
        for scale in (1, 2):
            name = f'icon_{s}x{s}{"@2x" if scale == 2 else ""}.png'
            subprocess.run(
                ['sips', '-z', str(s * scale), str(s * scale), png, '--out', os.path.join(iconset, name)],
                check=True, capture_output=True,
            )
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns], check=True)
    print(f'wrote {icns}')


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    png = os.path.join(here, 'icon.png')
    main(png)
    build_icns(png, os.path.join(here, 'AppIcon.icns'))
    sys.exit(0)
