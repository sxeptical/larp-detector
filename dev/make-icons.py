#!/usr/bin/env python3
"""Generate the LARP Detector crab icons. Pure stdlib, no deps.

Renders a fat little crab at 768x768 (6x supersample of the 128 design grid),
then box-downsamples to icons/icon-{16,32,48,128}.png.
"""

import os
import struct
import zlib

MASTER = 768
SCALE = MASTER / 128.0  # design grid is 128x128

# Colors (RGBA)
RED = (232, 70, 45)
DARK_RED = (201, 58, 36)
WHITE = (255, 255, 255)
BLACK = (26, 26, 30)


class Canvas:
    def __init__(self, size):
        self.size = size
        self.pixels = bytearray(size * size * 4)  # RGBA

    def paint_disc(self, cx, cy, r, color):
        x0, x1 = max(0, int(cx - r - 1)), min(self.size, int(cx + r + 2))
        y0, y1 = max(0, int(cy - r - 1)), min(self.size, int(cy + r + 2))
        r2 = r * r
        px = self.pixels
        for y in range(y0, y1):
            dy = y - cy
            row = y * self.size * 4
            for x in range(x0, x1):
                dx = x - cx
                if dx * dx + dy * dy <= r2:
                    i = row + x * 4
                    px[i : i + 4] = bytes((*color, 255))

    def paint_ellipse(self, cx, cy, rx, ry, color):
        x0, x1 = max(0, int(cx - rx - 1)), min(self.size, int(cx + rx + 2))
        y0, y1 = max(0, int(cy - ry - 1)), min(self.size, int(cy + ry + 2))
        px = self.pixels
        for y in range(y0, y1):
            dy = (y - cy) / ry
            row = y * self.size * 4
            for x in range(x0, x1):
                dx = (x - cx) / rx
                if dx * dx + dy * dy <= 1:
                    i = row + x * 4
                    px[i : i + 4] = bytes((*color, 255))

    def paint_capsule(self, x1, y1, x2, y2, width, color):
        """Round-capped line = a trail of discs. Good enough at 6x supersample."""
        length = max(abs(x2 - x1), abs(y2 - y1))
        steps = max(2, int(length / 1.5))
        for s in range(steps + 1):
            t = s / steps
            self.paint_disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color)


def build_master():
    c = Canvas(MASTER)
    S = SCALE

    def d(x, y, r, color):
        c.paint_disc(x * S, y * S, r * S, color)

    def el(x, y, rx, ry, color):
        c.paint_ellipse(x * S, y * S, rx * S, ry * S, color)

    def cap(x1, y1, x2, y2, w, color):
        c.paint_capsule(x1 * S, y1 * S, x2 * S, y2 * S, w * S, color)

    # Legs (behind the body), three per side, splayed
    for (x1, y1, x2, y2) in [
        (42, 96, 18, 114),
        (50, 100, 34, 122),
        (60, 101, 50, 124),
    ]:
        cap(x1, y1, x2, y2, 6, DARK_RED)
        cap(128 - x1, y1, 128 - x2, y2, 6, DARK_RED)

    # Arms + claws, clearly held up and out
    cap(32, 62, 20, 44, 7, RED)
    cap(96, 62, 108, 44, 7, RED)
    d(14, 34, 12, RED)
    d(114, 34, 12, RED)

    # Body: a wide little ellipse
    el(64, 82, 32, 24, RED)

    # Eyes
    d(53, 76, 8, WHITE)
    d(75, 76, 8, WHITE)
    d(54, 75, 3.5, BLACK)
    d(76, 75, 3.5, BLACK)

    return c


def downsample(canvas, target):
    factor = canvas.size / target
    out = bytearray(target * target * 4)
    px = canvas.pixels
    size = canvas.size
    for j in range(target):
        sy0, sy1 = int(j * factor), int((j + 1) * factor)
        for i in range(target):
            sx0, sx1 = int(i * factor), int((i + 1) * factor)
            acc_r = acc_g = acc_b = acc_a = 0.0
            n = 0
            for y in range(sy0, sy1):
                row = y * size * 4
                for x in range(sx0, sx1):
                    o = row + x * 4
                    a = px[o + 3] / 255.0
                    acc_r += px[o] * a
                    acc_g += px[o + 1] * a
                    acc_b += px[o + 2] * a
                    acc_a += a
                    n += 1
            o = (j * target + i) * 4
            if acc_a > 0:
                out[o] = int(acc_r / acc_a)
                out[o + 1] = int(acc_g / acc_a)
                out[o + 2] = int(acc_b / acc_a)
            out[o + 3] = int(255 * acc_a / n)
    return out


def write_png(path, size, rgba):
    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload))

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        raw.extend(rgba[y * size * 4 : (y + 1) * size * 4])

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    master = build_master()
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out_dir, f"icon-{size}.png"), size, downsample(master, size))
        print(f"wrote icons/icon-{size}.png")


if __name__ == "__main__":
    main()
