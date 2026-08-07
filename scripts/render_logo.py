#!/usr/bin/env python3
"""Generate a crisp, high-resolution icon from the source PNG.

Reads build/logo.png (the user's icon), extracts the blue color and layout,
then renders a clean vector-style 512x512 version using a system font for
the "启" character.  Outputs all icon sizes needed by Wails.
"""

import io
import os
import struct
from PIL import Image, ImageDraw, ImageFont


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "build"))
SRC = os.path.join(ROOT, "logo.png")

# Font candidates — bold / modern sans-serif first to match the original
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",        # 微软雅黑 Bold
    r"C:\Windows\Fonts\msyh.ttc",          # 微软雅黑 Regular
    r"C:\Windows\Fonts\Dengb.ttf",          # 等线 Bold
    r"C:\Windows\Fonts\Deng.ttf",           # 等线
    r"C:\Windows\Fonts\simhei.ttf",         # 黑体
    r"C:\Windows\Fonts\simsun.ttc",        # 宋体
]


def find_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def extract_dominant_color(img):
    """Extract the most common non-white/transparent color from the image."""
    thumb = img.resize((32, 32), Image.Resampling.LANCZOS)
    data = list(thumb.getdata())
    color_counts = {}
    for r, g, b, a in data:
        if a < 128 or (r > 200 and g > 200 and b > 200):
            continue
        key = (r, g, b)
        color_counts[key] = color_counts.get(key, 0) + 1
    if not color_counts:
        return (0, 120, 215)
    return max(color_counts, key=color_counts.get)


def save_multi_ico(ico_path, images_dict):
    """Save multiple PNG images into a Windows ICO file."""
    sizes = sorted(images_dict.keys())
    count = len(sizes)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + count * 16
    entries = b""
    data_block = b""

    for size in sizes:
        img = images_dict[size].convert("RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        width = size if size < 256 else 0
        height = size if size < 256 else 0
        entries += struct.pack(
            "<BBBBHHII",
            width, height, 0, 0, 1, 32, len(data), offset,
        )
        data_block += data
        offset += len(data)

    with open(ico_path, "wb") as f:
        f.write(header)
        f.write(entries)
        f.write(data_block)


def render_icon(size, bg_color, font_path):
    """Render a crisp icon at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded corners — large but not a full circle (like iOS-style app icons)
    padding = max(1, size // 128)
    radius = size // 5  # about 20% of size, giving a large rounded-rect look
    bounds = [padding, padding, size - padding - 1, size - padding - 1]
    draw.rounded_rectangle(bounds, radius=radius, fill=bg_color + (255,))

    # "启" character, white, centered
    font_size = int(size * 0.55)
    font = ImageFont.truetype(font_path, font_size)
    cx, cy = size // 2, size // 2
    # Slight nudge up because Chinese characters sit a bit low
    cy -= max(1, size // 80)
    draw.text((cx, cy), "启", font=font, fill=(255, 255, 255, 255), anchor="mm")

    return img


def main():
    if not os.path.exists(SRC):
        print(f"ERROR: Source icon not found: {SRC}")
        return 1

    font_path = find_font()
    if not font_path:
        print("ERROR: No suitable Chinese font found on this system.")
        print("Searched:")
        for p in FONT_CANDIDATES:
            print(f"  {p}")
        return 1
    print(f"Using font: {font_path}")

    src_img = Image.open(SRC).convert("RGBA")
    bg_color = extract_dominant_color(src_img)
    print(f"Extracted background color: {bg_color}")

    os.makedirs(ROOT, exist_ok=True)

    appicon = render_icon(512, bg_color, font_path)
    appicon_path = os.path.join(ROOT, "appicon.png")
    appicon.save(appicon_path, "PNG")
    print(f"Wrote {appicon_path} (512x512)")

    trayicon = render_icon(64, bg_color, font_path)
    trayicon_path = os.path.join(ROOT, "trayicon.png")
    trayicon.save(trayicon_path, "PNG")
    print(f"Wrote {trayicon_path} (64x64)")

    tray_ico = {s: render_icon(s, bg_color, font_path) for s in (16, 32, 48, 64)}
    tray_ico_path = os.path.join(ROOT, "trayicon.ico")
    save_multi_ico(tray_ico_path, tray_ico)
    print(f"Wrote {tray_ico_path} (16, 32, 48, 64)")

    win_dir = os.path.join(ROOT, "windows")
    os.makedirs(win_dir, exist_ok=True)
    win_ico = {s: render_icon(s, bg_color, font_path) for s in (16, 32, 48, 64, 128, 256)}
    win_ico_path = os.path.join(win_dir, "icon.ico")
    save_multi_ico(win_ico_path, win_ico)
    print(f"Wrote {win_ico_path} (16, 32, 48, 64, 128, 256)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
