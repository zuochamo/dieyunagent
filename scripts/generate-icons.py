#!/usr/bin/env python3
"""生成托盘/任务栏用的 PNG 与 Windows 打包用的 ICO。

优先使用 assets/logo-source.png（替换为你的品牌图后执行本脚本即可）。
若不存在该文件，则回退为内置的像素风占位图。

小尺寸（≤32px）使用「实心云」：在 256px 高清描边上提取内部填充后再缩小，
线条粗细不变，仅避免托盘 16px 时描边断成碎点。
"""
from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image, ImageDraw

W = H = 256
SOURCE_NAME = "logo-source.png"
TRAY_PX = 32
ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
SOLID_MAX_PX = 32


def draw_logo() -> Image.Image:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    teal = (78, 204, 163, 255)
    dark = (22, 33, 62, 255)
    navy = (15, 52, 96, 255)
    screen_bg = (26, 26, 46, 255)

    m = 10
    d.rounded_rectangle([m, m, W - m, H - m], radius=52, fill=dark, outline=teal, width=8)

    mx0, my0, mx1, my1 = 44, 52, 212, 188
    d.rounded_rectangle([mx0, my0, mx1, my1], radius=14, fill=navy, outline=teal, width=5)

    sx0, sy0, sx1, sy1 = 58, 68, 198, 158
    d.rectangle([sx0, sy0, sx1, sy1], fill=screen_bg)

    cols, rows = 6, 5
    cell_w = (sx1 - sx0) // cols
    cell_h = (sy1 - sy0) // rows
    for i in range(cols):
        for j in range(rows):
            x0 = sx0 + i * cell_w + 2
            y0 = sy0 + j * cell_h + 2
            x1 = x0 + cell_w - 4
            y1 = y0 + cell_h - 4
            fill = teal if (i + j) % 2 == 0 else (40, 70, 110, 255)
            d.rounded_rectangle([x0, y0, x1, y1], radius=3, fill=fill)

    d.rectangle([110, 194, 146, 218], fill=teal)
    d.rounded_rectangle([82, 218, 174, 242], radius=10, fill=teal)

    return img


def load_source(assets: str) -> Image.Image | None:
    path = os.path.join(assets, SOURCE_NAME)
    if not os.path.isfile(path):
        return None
    img = Image.open(path).convert("RGBA")

    iw, ih = img.size
    side = min(iw, ih)
    left = (iw - side) // 2
    top = (ih - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((W, H), Image.Resampling.LANCZOS)
    return img


def _is_stroke(rgba: tuple[int, ...]) -> bool:
    r, g, b, a = rgba
    return a > 80 and r > 160


def solid_cloud_from_outline(img: Image.Image) -> Image.Image:
    """在高清描边图里填充云朵内部，得到完整实心云（不增加描边粗细）。"""
    w, h = img.size
    px = img.load()
    stroke = [[_is_stroke(px[x, y]) for x in range(w)] for y in range(h)]

    xs: list[int] = []
    ys: list[int] = []
    for y in range(h):
        for x in range(w):
            if stroke[y][x]:
                xs.append(x)
                ys.append(y)
    if not xs:
        return img

    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    seed: tuple[int, int] | None = None
    mid_x = (x0 + x1) // 2
    target_y = y0 + (y1 - y0) * 2 // 5
    for dy in range(y1 - y0 + 1):
        y = target_y + dy
        if y0 <= y <= y1 and not stroke[y][mid_x]:
            seed = (mid_x, y)
            break
        y = target_y - dy
        if y0 <= y <= y1 and not stroke[y][mid_x]:
            seed = (mid_x, y)
            break
    if seed is None:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if not stroke[y][x]:
                    seed = (x, y)
                    break
            if seed:
                break
    if seed is None:
        return img

    filled = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque([seed])
    filled[seed[1]][seed[0]] = True
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < w and 0 <= ny < h and not filled[ny][nx] and not stroke[ny][nx]:
                filled[ny][nx] = True
                q.append((nx, ny))

    out = img.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            if filled[y][x] or stroke[y][x]:
                op[x, y] = (255, 255, 255, 255)
    return out


def save_multi_size_ico(path: str, outline: Image.Image, solid: Image.Image) -> None:
    frames: list[Image.Image] = []
    for size in ICO_SIZES:
        sz = size[0]
        source = solid if sz <= SOLID_MAX_PX else outline
        frames.append(source.resize(size, Image.Resampling.LANCZOS))
    frames[0].save(
        path,
        format="ICO",
        sizes=[(frame.width, frame.height) for frame in frames],
        append_images=frames[1:],
    )


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    png_path = os.path.join(assets, "icon.png")
    tray_path = os.path.join(assets, "icon-tray.png")
    ico_path = os.path.join(assets, "icon.ico")

    from_source = load_source(assets)
    outline = from_source or draw_logo()
    solid = solid_cloud_from_outline(outline)

    outline.save(png_path, "PNG")
    solid.resize((TRAY_PX, TRAY_PX), Image.Resampling.LANCZOS).save(tray_path, "PNG")
    save_multi_size_ico(ico_path, outline, solid)

    src = SOURCE_NAME if from_source is not None else "内置占位"
    print("Wrote", png_path, tray_path, "and", ico_path, f"(来源: {src})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
