#!/usr/bin/env python3
"""从高清美术源生成 Android mipmap 与手机 PWA 图标。"""
from __future__ import annotations

import os

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# 与 scripts/generate-icons.py 同一个美术源；1254x1254 才能真下采样出 432/512，
# 回退到 256 的 icon.png 会把大尺寸图标放大糊掉。
SOURCE_CANDIDATES = ("logo-source.png", "icon.png")
RES = os.path.join(ROOT, "mobile-app", "android", "app", "src", "main", "res")
PWA = os.path.join(ROOT, "src", "mobile", "public")

LEGACY_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}
FOREGROUND_SIZES = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}
PWA_SIZES = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "apple-touch-icon.png": 180,
}


def load_square_source() -> Image.Image:
    assets = os.path.join(ROOT, "assets")
    src_path = next(
        (os.path.join(assets, name) for name in SOURCE_CANDIDATES if os.path.isfile(os.path.join(assets, name))),
        None,
    )
    if src_path is None:
        raise SystemExit(f"缺少源图标: {assets}/{SOURCE_CANDIDATES[0]}")
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def save_png(img: Image.Image, path: str, size: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = img.resize((size, size), Image.Resampling.LANCZOS)
    out.save(path, "PNG", optimize=True)


def main() -> None:
    src = load_square_source()

    for folder, size in LEGACY_SIZES.items():
        base = os.path.join(RES, folder)
        save_png(src, os.path.join(base, "ic_launcher.png"), size)
        save_png(src, os.path.join(base, "ic_launcher_round.png"), size)

    for folder, size in FOREGROUND_SIZES.items():
        save_png(src, os.path.join(RES, folder, "ic_launcher_foreground.png"), size)

    save_png(src, os.path.join(RES, "drawable-nodpi", "dieyun_logo.png"), 512)
    # 连接页等 UI 仍引用 @drawable/dieyun_logo
    save_png(src, os.path.join(RES, "drawable", "dieyun_logo.png"), 512)

    os.makedirs(PWA, exist_ok=True)
    for name, size in PWA_SIZES.items():
        save_png(src, os.path.join(PWA, name), size)

    print("[generate-mobile-icons] OK")


if __name__ == "__main__":
    main()
