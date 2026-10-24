#!/usr/bin/env python3
"""Detect carved ghost notches inside solid candle bodies on the chart screenshot.
A 5m/15m solid body with a 1m ghost bar overlapping it shows a 1-3px dark gap
inside the solid run (the carve), often edged by the ghost outline colour."""
from PIL import Image

im = Image.open('/tmp/ghost15.png').convert('RGB')
W, H = im.size
Y0, Y1 = 110, 240          # spot plot price zone
X0, X1 = 225, 985

def is_red(p):  return p[0] > 190 and p[1] < 120 and p[2] < 130
def is_green(p): return p[1] > 150 and p[0] < 120 and p[2] < 160
def solid(p):   return is_red(p) or is_green(p)

bodies = carved = 0
for y in range(Y0, Y1):
    x = X0
    while x < X1:
        if solid(im.getpixel((x, y))):
            x2 = x
            while x2 < X1 and solid(im.getpixel((x2, y))):
                x2 += 1
            run = x2 - x
            if run >= 7:  # wide enough to hold a ghost bar + outlines
                bodies += 1
                interior_gaps = sum(1 for xx in range(x + 2, x2 - 2) if not solid(im.getpixel((xx, y))))
                if interior_gaps >= 1:
                    carved += 1
            x = x2
        else:
            x += 1
print(f'rows {Y0}-{Y1}: solid runs>=7px: {bodies}, with interior carve gap: {carved}')
