#!/usr/bin/env python3
"""Wrap a PNG image into a Windows ICO container (Vista+ supports PNG inside ICO)."""

import os
import struct
import sys


def png_to_ico(png_path, ico_path):
    with open(png_path, 'rb') as f:
        png_data = f.read()

    # ICONDIR
    icondir = struct.pack('<HHH', 0, 1, 1)
    # ICONDIRENTRY
    # For 64x64 image, use width/height as bytes. bitcount=32, planes=1.
    entry = struct.pack('<BBBBHHII', 64, 64, 0, 0, 1, 32, len(png_data), 22)

    with open(ico_path, 'wb') as f:
        f.write(icondir)
        f.write(entry)
        f.write(png_data)
    print(f"Wrote {ico_path}")


if __name__ == '__main__':
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'build'))
    png_to_ico(os.path.join(root, 'trayicon.png'), os.path.join(root, 'trayicon.ico'))
