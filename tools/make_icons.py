#!/usr/bin/env python3
"""Generate the fn-netgui icon set (no external assets, fully reproducible).

Outputs:
  ICON_256.PNG            256x256  (app center detail page)
  ICON.PNG                 64x64   (app center list)
  app/ui/images/icon-256.png
  app/ui/images/icon-64.png

Run:  python tools/make_icons.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SS = 4  # supersampling factor
SIZE = 1024
TOP = (124, 92, 255)      # #7C5CFF
BOTTOM = (63, 43, 190)    # #3F2BBE


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        # ease-in-out for a softer band
        t = 0.5 - math.cos(t * math.pi) / 2
        grad.putpixel(
            (0, y),
            tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)),
        )
    return grad.resize((size, size), Image.BILINEAR)


def draw_glyph(img: Image.Image, size: int) -> None:
    draw = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    line_w = round(size * 0.042)

    left = (size * 0.27, size * 0.52)
    right_top = (size * 0.72, size * 0.30)
    right_bottom = (size * 0.72, size * 0.72)

    for target in (right_top, right_bottom):
        draw.line([left, target], fill=white, width=line_w, joint="curve")

    node_r = size * 0.083
    for centre in (left, right_top, right_bottom):
        draw.ellipse(
            (centre[0] - node_r, centre[1] - node_r, centre[0] + node_r, centre[1] + node_r),
            fill=white,
        )

    # small inner cut so the nodes read as "ports" rather than dots
    inner = size * 0.034
    for centre in (left, right_top, right_bottom):
        draw.ellipse(
            (centre[0] - inner, centre[1] - inner, centre[0] + inner, centre[1] + inner),
            fill=TOP + (255,),
        )


def build() -> Image.Image:
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient = vertical_gradient(SIZE).convert("RGBA")
    base.paste(gradient, (0, 0), rounded_mask(SIZE, int(SIZE * 0.22)))
    draw_glyph(base, SIZE)
    return base


def main() -> None:
    master = build()

    targets = [
        (ROOT / "ICON_256.PNG", 256),
        (ROOT / "ICON.PNG", 64),
        # 桌面入口用 {0} 占位符替换成 64 / 256，所以文件名必须是下划线形式
        (ROOT / "app" / "ui" / "images" / "icon_256.png", 256),
        (ROOT / "app" / "ui" / "images" / "icon_128.png", 128),
        (ROOT / "app" / "ui" / "images" / "icon_64.png", 64),
    ]
    for path, size in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        img = master.resize((size, size), Image.LANCZOS)
        if path.name.startswith("ICON"):
            img.convert("RGB").save(path, format="PNG", optimize=True)
        else:
            img.save(path, format="PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size}, {path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
