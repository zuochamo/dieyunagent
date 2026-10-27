#!/usr/bin/env python3
"""生成应用图标：icon.ico / icon.png / icon-tray.png，全部来自 assets/logo-source.png。

唯一美术来源是 assets/logo-source.png（替换为你的品牌图后执行本脚本即可）；
文件不存在时回退为内置的像素风占位图。配方假定源图是「深底 + 亮色线稿」，
换风格美术时需重新审视这个配方。

尺寸自适应（同一份美术、一套配方）：
  ≥48px  描边加粗（512 网格上膨胀 +10px，缩到 48px 仍有约 3.6px 粗）
  ≤32px  描边会退化到 1px 以下，改用同一轮廓的实心剪影（16px 才有实体感）
  统一   6% 安全边距、#000000 纯黑底色、22% 圆角

小尺寸（≤32px）正是 Windows 任务栏 / 托盘 / Alt-Tab 的实际显示尺寸，所以另外出
assets/icon-tray.png（实心版 64px）：Electron 的 nativeImage 读 ICO 只能拿到最大帧，
取不到 32px 帧，托盘只能自己按 DPI 缩放这张图。
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

W = H = 256
SOURCE_NAME = "logo-source.png"
ICO_SIZES = (256, 128, 64, 48, 32, 24, 16)
TRAY_PX = 64

MASTER_PX = 512
STROKE_LUM = 140          # 「亮色线稿」的亮度阈值
TILE_INSET = 0.06         # 安全边距（占整图比例）
TILE_RADIUS = 0.22        # 圆角（占卡片边长比例）
TILE_COLOR = (0, 0, 0, 255)
MARK_COLOR = (255, 255, 255, 255)
SOLID_MAX_PX = 32         # ≤ 此值改实心剪影
STROKE_BOLD_PASSES = 5    # 5 趟 3x3 最大值滤波 = 描边 +10px（512 网格）
MARK_W_SOLID = 0.76       # 小尺寸光学放大
MARK_W_OUTLINE = 0.72


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
    """读高清源并裁成正方形。保持原始像素，让各档尺寸都从它直接缩放。"""
    path = os.path.join(assets, SOURCE_NAME)
    if not os.path.isfile(path):
        return None
    img = Image.open(path).convert("RGBA")
    iw, ih = img.size
    side = min(iw, ih)
    left = (iw - side) // 2
    top = (ih - side) // 2
    return img.crop((left, top, left + side, top + side))


def _stroke_mask(master: Image.Image) -> Image.Image:
    """亮色线稿的掩膜（'L'，255 = 线）。"""
    small = master.resize((MASTER_PX, MASTER_PX), Image.Resampling.LANCZOS)
    lum = small.convert("L").point(lambda v: 255 if v > STROKE_LUM else 0)
    return ImageChops.multiply(lum, small.getchannel("A").point(lambda v: 255 if v > 128 else 0))


def _free_seed(stroke: Image.Image, seed: tuple[int, int]) -> tuple[int, int] | None:
    w, h = stroke.size
    x0, y0 = seed
    if stroke.getpixel((x0, y0)) == 0:
        return seed
    for r in range(1, 60):
        for y in range(max(0, y0 - r), min(h, y0 + r + 1)):
            for x in range(max(0, x0 - r), min(w, x0 + r + 1)):
                if stroke.getpixel((x, y)) == 0:
                    return (x, y)
    return None


def build_marks(master: Image.Image) -> tuple[Image.Image, Image.Image, tuple[int, int, int, int]]:
    """返回 (实心剪影, 加粗描边, 标志包围盒)，都在 MASTER_PX 网格上。"""
    stroke = _stroke_mask(master)
    bbox = stroke.getbbox()
    if bbox is None:
        raise SystemExit("源图里没找到亮色线稿（STROKE_LUM=%d）" % STROKE_LUM)

    # 实心剪影：从轮廓内部洪水填充，保住肩部凹口（行/列填充会把凹口抹平）
    work = stroke.copy()
    seed = _free_seed(stroke, ((bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2))
    if seed is not None:
        ImageDraw.floodfill(work, seed, 128, thresh=0)
    solid = ImageChops.lighter(stroke, work.point(lambda v: 255 if v == 128 else 0))

    # 加粗描边：多趟 3x3 最大值滤波 ≈ 圆形膨胀
    outline = stroke
    for _ in range(STROKE_BOLD_PASSES):
        outline = outline.filter(ImageFilter.MaxFilter(3))

    return solid, outline, bbox


def render_icon(size: int, *, solid_mark: bool, marks) -> Image.Image:
    solid, outline, bbox = marks
    ss = 8 if size <= 64 else 4
    canvas_px = size * ss
    canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))

    inset = round(canvas_px * TILE_INSET)
    tile = canvas_px - inset * 2
    ImageDraw.Draw(canvas).rounded_rectangle(
        [inset, inset, inset + tile, inset + tile],
        radius=round(tile * TILE_RADIUS),
        fill=TILE_COLOR,
    )

    mark_src = solid if solid_mark else outline
    mark_w = MARK_W_SOLID if solid_mark else MARK_W_OUTLINE
    mark_box = mark_src.crop(bbox)
    target_w = max(1, round(tile * mark_w))
    target_h = max(1, round(target_w * mark_box.height / mark_box.width))
    mark = mark_box.resize((target_w, target_h), Image.Resampling.LANCZOS)

    layer = Image.new("L", (canvas_px, canvas_px), 0)
    px = inset + (tile - target_w) // 2
    py = inset + (tile - target_h) // 2 - round(tile * 0.01)  # 视觉中心略上移
    layer.paste(mark, (px, py))

    canvas.paste(MARK_COLOR, (0, 0, canvas_px, canvas_px), layer)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def save_multi_size_ico(path: str, marks) -> None:
    frames = [render_icon(s, solid_mark=s <= SOLID_MAX_PX, marks=marks) for s in ICO_SIZES]
    frames[0].save(
        path,
        format="ICO",
        sizes=[(f.width, f.height) for f in frames],
        append_images=frames[1:],
    )


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    png_path = os.path.join(assets, "icon.png")
    ico_path = os.path.join(assets, "icon.ico")
    tray_path = os.path.join(assets, "icon-tray.png")

    from_source = load_source(assets)
    master = from_source or draw_logo()
    marks = build_marks(master)

    render_icon(W, solid_mark=False, marks=marks).save(png_path, "PNG")
    save_multi_size_ico(ico_path, marks)
    render_icon(TRAY_PX, solid_mark=True, marks=marks).save(tray_path, "PNG")

    src = SOURCE_NAME if from_source is not None else "内置占位"
    print(
        "Wrote", png_path, tray_path, "and", ico_path,
        f"(来源: {src} {master.width}x{master.height}, 实心档: ≤{SOLID_MAX_PX}px)",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
