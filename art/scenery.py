"""Everything with no collision: the city beyond the edge, the Dharahara tower, prayer flags and
power cables strung high over the streets, and far away the valley's hills, Swayambhu on its hill
and the Himalaya to the north. None of it can be reached."""

import math
import random

from mathutils import Vector

from arena import BRICK, GOLD, PLASTERS, PRAYER_FLAGS, WHITEWASH
from mesh import BACKDROP, VERTEX_LIT, Frame, cylinder, facing, linear, lit, polygon, rect, wall_rect

CITY_CELL = 14
CITY_NEAR = 84
CITY_FAR = 170
DHARAHARA = (-96, 104)
SWAYAMBHU = (-470, 50)
HILLS_RADIUS = 560
HIMALAYA_RADIUS = 1650
SNOWLINE = 190
FLAG_SPACING = 0.4
FLAG_SIZE = (0.14, 0.17)

rng = random.Random(21)
ORIGIN = Frame((0, 0, 0))


def add_scenery():
    with lit(VERTEX_LIT):
        add_city()
        add_dharahara()
        add_flags()
        add_cables()
    with lit(BACKDROP):
        add_hills()
        add_swayambhu()
        add_himalaya()


def add_city():
    """Houses packed beyond the edge, taller further out so they show over the ones in front.
    Only the sides facing the map are built."""
    steps = range(-CITY_FAR, CITY_FAR + 1, CITY_CELL)
    for cx in steps:
        for cz in steps:
            if max(abs(cx), abs(cz)) < CITY_NEAR or math.hypot(cx - DHARAHARA[0], cz - DHARAHARA[1]) < 16 or rng.random() < 0.15:
                continue
            x, z = cx + rng.uniform(-2, 2), cz + rng.uniform(-2, 2)
            hx, hz = rng.uniform(4.5, 6.5), rng.uniform(4.5, 6.5)
            height = 10 + (max(abs(cx), abs(cz)) - CITY_NEAR) * 0.14 + rng.uniform(0, 9)
            city_house(x, z, hx, hz, height)


def city_house(x, z, hx, hz, height):
    brick = rng.random() < 0.3
    wall = linear(BRICK if brick else rng.choice(PLASTERS), 0.06, rng)
    glass = linear(0x2f3640, 0.1, rng)
    storeys = int(height // 3)
    for nx, nz, half, depth in ((1, 0, hz, hx), (-1, 0, hz, hx), (0, 1, hx, hz), (0, -1, hx, hz)):
        # Only sides turned toward the middle of the map can be seen from it.
        if nx * x + nz * z > 0:
            continue
        frame = facing((x + nx * depth, 0, z + nz * depth), (nx, 0, nz))
        wall_rect(frame, -half, half, 0, height, wall)
        for s in range(1, storeys):
            wall_rect(frame, -half * 0.85, half * 0.85, s * 3 + 0.5, s * 3 + 1.8, glass, lift=0.03)
    top = Frame((x, height, z))
    rect(top, (0, 0, 0), (0, 0, hz), (hx, 0, 0), linear(0x8f8a82, 0.08, rng))
    if not brick:
        # The black plastic water tanks on every roof in Kathmandu.
        for _ in range(rng.randint(1, 3)):
            cylinder(top, (rng.uniform(-hx + 1, hx - 1), 0, rng.uniform(-hz + 1, hz - 1)), 0.6, 1.3, 8, linear(0x1c1c1e))


def add_dharahara():
    """The white nine-storey watch tower of Kathmandu, standing over the rooftops."""
    x, z = DHARAHARA
    frame = Frame((x, 0, z))
    white = linear(WHITEWASH, 0.02, rng)
    cylinder(frame, (0, 0, 0), 5.5, 6, 12, white, radius_top=5.0)
    cylinder(frame, (0, 6, 0), 4.0, 44, 12, white, radius_top=3.0)
    for y in (18, 30, 42):
        cylinder(frame, (0, y, 0), 4.3 - y * 0.025, 0.6, 12, linear(0xcfc8b8))
    cylinder(frame, (0, 50, 0), 3.0, 5, 12, linear(0x8a6a3a), radius_top=0.6)
    cylinder(frame, (0, 55, 0), 0.5, 4, 8, linear(GOLD), radius_top=0.05)


def sag(a, b, t, drop):
    return Vector(a).lerp(Vector(b), t) - Vector((0, drop * 4 * t * (1 - t), 0))


def two_sided(corners, color):
    polygon(ORIGIN, corners, color)
    polygon(ORIGIN, corners[::-1], color)


def flag_line(a, b, drop):
    """A string of prayer flags in their five colours, sagging between two points."""
    length = (Vector(b) - Vector(a)).length
    count = int(length / FLAG_SPACING)
    across = (Vector(b) - Vector(a)).normalized()
    half, hang = FLAG_SIZE
    for k in range(count):
        top = sag(a, b, (k + 0.5) / count, drop)
        color = linear(PRAYER_FLAGS[k % len(PRAYER_FLAGS)], 0.05, rng)
        two_sided([top - across * half - Vector((0, 2 * hang, 0)), top + across * half - Vector((0, 2 * hang, 0)),
                   top + across * half, top - across * half], color)


def add_flags():
    """Flags from the stupa's spire down to the houses around its courtyard, and across the streets."""
    spire = (42, 14.6, -42)
    for end in ((16.1, 7, -45), (30, 8, -65.9), (42, 8, -65.9), (56, 8, -65.9), (65.9, 8, -30),
                (65.9, 8, -52), (45, 7, -16.1), (58, 7.5, -16.1)):
        flag_line(spire, end, 1.2)
    for z in (-50, -58, 44, 52):
        flag_line((-6.4, 7, z), (6.4, 7, z), 0.8)
    for x in (-50, -58, 46, 58):
        flag_line((x, 7, -6.4), (x, 7, 6.4), 0.8)


def add_cables():
    """Tangles of power and phone cables sagging over the streets."""
    black = linear(0x151515)
    for along in (-40, -46, -62, 40, 48, 60):
        for k in range(3):
            y = 6.2 + k * 0.25
            for a, b in (((-6.4, y, along), (6.4, y, along + 1)), ((along, y, -6.4), (along + 1, y, 6.4))):
                points = [sag(a, b, t / 8, 0.5 + 0.2 * k) for t in range(9)]
                for p, q in zip(points, points[1:]):
                    two_sided([p, q, q + Vector((0, 0.03, 0)), p + Vector((0, 0.03, 0))], black)


def ring_strip(radius_of, height_of, color_of, steps, start=0.0, sweep=2 * math.pi, base=-15):
    """A band of hillside all the way round (or part way), seen from the middle, built in rows
    from its foot up to its ridge. `color_of(angle, height)` colours each quad by the height of its
    upper edge."""
    rows = ((0.94, 0.0), (0.97, 0.45), (0.99, 0.75), (1.0, 1.0))
    for k in range(steps):
        a0, a1 = start + sweep * k / steps, start + sweep * (k + 1) / steps
        for (s0, f0), (s1, f1) in zip(rows, rows[1:]):
            quad = []
            for angle, scale, frac in ((a0, s0, f0), (a1, s0, f0), (a1, s1, f1), (a0, s1, f1)):
                r = radius_of(angle) * scale
                y = base + (height_of(angle) - base) * frac
                quad.append(Vector((math.sin(angle) * r, y, -math.cos(angle) * r)))
            polygon(ORIGIN, quad, color_of(a0, max(quad[2].y, quad[3].y)))


def add_hills():
    """The green hills that ring the Kathmandu valley, low enough for the Himalaya to show over them."""
    def height(angle):
        return 34 + 14 * math.sin(3 * angle + 1) + 8 * math.sin(7 * angle) + 5 * math.sin(13 * angle + 2)

    def color(angle, y):
        return linear(0x3f5a30 if y > 40 else 0x4f6a3a, 0.12, rng)

    ring_strip(lambda a: HILLS_RADIUS + 60 * math.sin(2 * a + 0.5), height, color, 120)


def add_swayambhu():
    """The forested hill in the west with the Swayambhu stupa gleaming on its top."""
    x, z = SWAYAMBHU
    frame = Frame((x, 0, z))
    green = lambda k: linear(0x3e5a2f, 0.12, rng)
    cylinder(frame, (0, -10, 0), 120, 40, 16, green, radius_top=55, top=False)
    cylinder(frame, (0, 30, 0), 55, 22, 16, green, radius_top=16)
    cylinder(frame, (0, 52, 0), 12, 5, 16, linear(WHITEWASH), radius_top=4)
    cylinder(frame, (0, 57, 0), 2.4, 3, 4, linear(GOLD))
    cylinder(frame, (0, 60, 0), 2.0, 10, 12, linear(GOLD), radius_top=0.3)


def add_himalaya():
    """The snow range along the northern horizon: broad massifs, smaller summits along their
    ridges, snow above the snowline and bare rock streaking through it."""
    massifs = [(rng.uniform(-1.25, 1.25), rng.uniform(110, 230), rng.uniform(0.1, 0.26)) for _ in range(9)]
    summits = [(rng.uniform(-1.3, 1.3), rng.uniform(30, 90), rng.uniform(0.02, 0.06)) for _ in range(40)]

    def height(angle):
        tallest = 100.0
        for centre, top, width in massifs:
            tallest = max(tallest, 100 + top * max(0.0, 1 - abs(angle - centre) / width) ** 1.6)
        for centre, top, width in summits:
            tallest += top * 0.35 * max(0.0, 1 - abs(angle - centre) / width) ** 1.3
        return tallest + 8 * math.sin(angle * 61) + 5 * math.sin(angle * 137)

    def color(angle, y):
        # Snow doesn't lie on the steepest faces.
        steep = abs(height(angle + 0.004) - height(angle - 0.004)) / (0.008 * HIMALAYA_RADIUS) > 1.4
        if y > SNOWLINE and not steep:
            return linear(0xf4f6fa, 0.03, rng)
        return linear(0x5e6878, 0.08, rng)

    ring_strip(lambda a: HIMALAYA_RADIUS, height, color, 200, start=-1.3, sweep=2.6, base=-40)
