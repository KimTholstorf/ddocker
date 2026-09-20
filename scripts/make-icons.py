#!/usr/bin/env python3
"""Generate the site icons from the same pixel glyphs as the wordmark.

    python3 scripts/make-icons.py

Writes src/favicon.svg, src/favicon.ico and src/icon-180.png.
"""
import struct
import zlib
from pathlib import Path

# 6x7 "d", the same glyph src/hub.client.js draws.
GLYPH_D = ["111110", "110011", "110011", "110011", "110011", "110011", "111110"]
# Row colours, light band at the top down to the deepest blue, as on the page.
BANDS = ["#a4b6ee", "#a4b6ee", "#7f9cf2", "#7f9cf2", "#4a78ef", "#4a78ef", "#1f47b8"]

SRC = Path(__file__).resolve().parent.parent / "src"


def cells():
    """Yield (x, y, colour) for "dd" on a 16x16 grid, centred."""
    glyph_w, glyph_h = len(GLYPH_D[0]), len(GLYPH_D)
    width = glyph_w * 2 + 1  # two glyphs, one column between
    x0 = (16 - width) // 2
    y0 = (16 - glyph_h) // 2
    for copy in range(2):
        for y, row in enumerate(GLYPH_D):
            for x, bit in enumerate(row):
                if bit == "1":
                    yield x0 + copy * (glyph_w + 1) + x, y0 + y, BANDS[y]


def write_svg(path):
    rects = "".join(
        f'<rect x="{x}" y="{y}" width="1" height="1" fill="{colour}"/>'
        for x, y, colour in cells()
    )
    path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" '
        f'shape-rendering="crispEdges">{rects}</svg>\n'
    )


def pixels(size):
    """RGBA pixel rows at the given size, scaled from the 16x16 grid."""
    grid = {(x, y): colour for x, y, colour in cells()}
    scale = size // 16
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            colour = grid.get((px // scale, py // scale))
            if colour:
                r, g, b = (int(colour[i : i + 2], 16) for i in (1, 3, 5))
                row.append((r, g, b, 255))
            else:
                row.append((0, 0, 0, 0))
        rows.append(row)
    return rows


def write_png(path, size):
    rows = pixels(size)
    raw = b"".join(b"\0" + bytes(v for px in row for v in px) for row in rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def write_ico(path, size=32):
    """A single 32x32 BGRA image, stored as a DIB the way .ico expects."""
    rows = pixels(size)
    dib = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    body = b"".join(
        bytes(v for px in row for v in (px[2], px[1], px[0], px[3]))
        for row in reversed(rows)  # .ico stores rows bottom-up
    )
    mask = b"\0" * (size * 4)  # 1 bit per pixel, padded to 4 bytes per row
    image = dib + body + mask
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(image), 22)
    path.write_bytes(header + entry + image)


if __name__ == "__main__":
    write_svg(SRC / "favicon.svg")
    write_ico(SRC / "favicon.ico")
    write_png(SRC / "icon-180.png", 176)  # 16x11 scale, close enough to 180
    for name in ("favicon.svg", "favicon.ico", "icon-180.png"):
        print(f"{name}: {(SRC / name).stat().st_size} bytes")
