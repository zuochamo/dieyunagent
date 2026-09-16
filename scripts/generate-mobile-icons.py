#!/usr/bin/env python3
"""从 assets/icon.png 生成 Android mipmap 与手机 PWA 图标。"""
from __future__ import annotations

import os

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets", "icon.png")
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
    if not os.path.isfile(SRC):
        raise SystemExit(f"缺少源图标: {SRC}")
    img = Image.open(SRC).convert("RGBA")
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
