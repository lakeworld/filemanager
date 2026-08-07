#!/usr/bin/env python3
"""Generate appicon.png and trayicon.png from scratch using only stdlib."""

import struct
import zlib
import os


def clamp(v):
    return max(0, min(255, int(v)))


def lerp(a, b, t):
    return a + (b - a) * t


def grad_color(x, y, size):
    t = (x / (size - 1) + y / (size - 1)) / 2.0
    r = lerp(15, 5, t)
    g = lerp(118, 150, t)
    b = lerp(110, 105, t)
    return (clamp(r), clamp(g), clamp(b), 255)


def in_rounded_rect(x, y, rx, ry, rw, rh, radius):
    if x < rx or x > rx + rw or y < ry or y > ry + rh:
        return False
    cx = rx + radius if x < rx + radius else rx + rw - radius
    cy = ry + radius if y < ry + radius else ry + rh - radius
    if x < rx + radius or x > rx + rw - radius:
        if y < ry + radius or y > ry + rh - radius:
            return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
    return True


def in_polygon(x, y, pts):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def render(size):
    # Shapes are defined in a 512x512 coordinate space and scaled.
    scale = size / 512.0
    def s(v): return v * scale
    def pts(coords): return [(s(x), s(y)) for x, y in coords]

    folder_back = pts([(128, 192), (224, 192), (256, 160), (384, 160), (384, 352), (128, 352)])
    folder_front = pts([(128, 208), (192, 208), (216, 184), (384, 184), (384, 400), (128, 400)])
    leaf = pts([(230, 240), (290, 180), (350, 240), (290, 360)])
    accent = pts([(252, 320), (296, 320), (296, 364), (252, 364)])
    radius = 96 * scale

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if not in_rounded_rect(x, y, 0, 0, size, size, radius):
                row.extend([0, 0, 0, 0])
                continue

            r, g, b, a = grad_color(x, y, size)

            if in_polygon(x, y, folder_back):
                r, g, b = 19, 78, 74
                a = int(0.4 * 255)

            if in_polygon(x, y, folder_front):
                r, g, b = 240, 253, 244
                a = 255

            if in_polygon(x, y, leaf):
                t = (y - 180 * scale) / (180 * scale)
                lr = lerp(167, 52, t)
                lg = lerp(243, 211, t)
                lb = lerp(208, 153, t)
                r, g, b = clamp(lr), clamp(lg), clamp(lb)
                a = 255

            if in_polygon(x, y, accent):
                r, g, b = 16, 185, 129
                a = int(0.9 * 255)

            row.extend([r, g, b, a])
        pixels.append(row)
    return pixels


def png_chunk(chunk_type, data):
    chunk = chunk_type + data
    crc = zlib.crc32(chunk) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", crc)


def write_png(path, size):
    pixels = render(size)
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        raw.extend(row)

    compressed = zlib.compress(bytes(raw), level=9)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    out = sig
    out += png_chunk(b'IHDR', ihdr)
    out += png_chunk(b'IDAT', compressed)
    out += png_chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(out)
    print(f"Wrote {path} ({size}x{size})")


if __name__ == '__main__':
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'build'))
    os.makedirs(root, exist_ok=True)
    write_png(os.path.join(root, 'appicon.png'), 512)
    write_png(os.path.join(root, 'trayicon.png'), 64)
