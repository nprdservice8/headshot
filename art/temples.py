"""Dressing for the temples: pagoda shrines and roofs, the stupa and its eyes, the stone
shikhara and the pillars of the temple square."""

import math

from mathutils import Vector

from arena import (
    BRICK, GOLD, GOLD_DARK, SAFFRON, SOOT, STONE, STONE_DARK, STONE_LIGHT, TILE, TILE_DARK, WHITEWASH,
    WOOD, WOOD_DARK, box_frame, half_of, rng_for, stacked,
)
from buildings import sides_of, soffit, top_ring
from mesh import VERTEX_LIT, Frame, block, cylinder, linear, lit, polygon, wall_rect

EYE_WHITE = 0xf4f1e8
EYE_DARK = 0x1f2a4a


def arch(frame, x, y0, width, height, color, lift):
    """A round-headed opening or gilded torana: a rectangle with a half circle on top."""
    half = width / 2
    spring = y0 + height - half
    points = [(x - half, y0, lift), (x + half, y0, lift)]
    for k in range(9):
        angle = math.pi * k / 8
        points.append((x + math.cos(angle) * half, spring + math.sin(angle) * half, lift))
    polygon(frame, points, color)


def dress_shrine(box):
    """The walls of a pagoda's sanctum, or of the drum between two of its roofs."""
    rng = rng_for(box)
    height = 2 * box["hy"]
    for frame, half, _, _ in sides_of(box):
        wall_rect(frame, -half, half, 0, height, linear(BRICK, 0.04, rng))
        with lit(VERTEX_LIT):
            wall_rect(frame, -half, half, 0, 0.25, linear(STONE, 0.05, rng), lift=0.03)
            wall_rect(frame, -half, half, height - 0.22, height, linear(WOOD, 0.08, rng), lift=0.04)
            if height < 2:
                wall_rect(frame, -0.35, 0.35, height * 0.3, height * 0.7, linear(WOOD_DARK, 0.1, rng), lift=0.03)
                continue
            doors = 3 if half > 2 else 1
            for d in range(doors):
                x = (d - (doors - 1) / 2) * 1.5
                wall_rect(frame, x - 0.55, x + 0.55, 0.25, 2.25, linear(WOOD, 0.1, rng), lift=0.02)
                wall_rect(frame, x - 0.4, x + 0.4, 0.25, 2.05, linear(WOOD_DARK, 0.1, rng), lift=0.03)
                arch(frame, x, 2.3, 1.1, 0.75, linear(GOLD, 0.05, rng), 0.03)


def dress_tier(box):
    """One of a pagoda's roofs, sloping from wide eaves up to the drum or finial above it."""
    rng = rng_for(box)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    above = stacked(box, 1)
    below = stacked(box, -1)
    top = above["hx"] if above is not None and above["kind"] == "shrine" else 0.35
    corners = [(-hx, -hy, hz), (hx, -hy, hz), (hx, -hy, -hz), (-hx, -hy, -hz)]
    tops = [(-top, hy, top), (top, hy, top), (top, hy, -top), (-top, hy, -top)]
    courses = 6
    with lit(VERTEX_LIT):
        for k in range(4):
            a, b = Vector(corners[k]), Vector(corners[(k + 1) % 4])
            ta, tb = Vector(tops[k]), Vector(tops[(k + 1) % 4])
            for c in range(courses):
                s0, s1 = c / courses, (c + 1) / courses
                shade = GOLD if c == 0 else (TILE if c % 2 else TILE_DARK)
                polygon(frame, (a.lerp(ta, s0), b.lerp(tb, s0), b.lerp(tb, s1), a.lerp(ta, s1)), linear(shade, 0.05, rng))
        if below is not None:
            soffit(frame, hx, hy, hz, below["hx"], below["hz"], rng)
        if above is None or above["kind"] != "shrine":
            polygon(frame, tops, linear(GOLD_DARK))


def dress_spire(box):
    """A gilded finial; on a stupa, the thirteen rings of the spire under a parasol."""
    frame = Frame((box["x"], box["y"] - box["hy"], box["z"]))
    half, height = box["hx"], 2 * box["hy"]
    gold, dark = linear(GOLD, 0.03), linear(GOLD_DARK)
    with lit(VERTEX_LIT):
        if height < 4:
            cylinder(frame, (0, 0, 0), half, height * 0.15, 8, dark)
            cylinder(frame, (0, height * 0.15, 0), half * 0.9, height * 0.35, 8, gold, radius_top=half * 0.5)
            cylinder(frame, (0, height * 0.5, 0), half * 0.6, height * 0.2, 8, dark, radius_top=half * 0.6)
            cylinder(frame, (0, height * 0.7, 0), half * 0.45, height * 0.3, 8, gold, radius_top=0.02)
            return
        rings = 13
        ring_height = height * 0.72 / rings
        for k in range(rings):
            r0 = half * (0.92 - 0.45 * k / rings)
            r1 = half * (0.92 - 0.45 * (k + 1) / rings)
            cylinder(frame, (0, k * ring_height, 0), r0, ring_height, 12, gold if k % 2 else dark, radius_top=r1)
        y = rings * ring_height
        cylinder(frame, (0, y, 0), half, height * 0.06, 16, linear(GOLD, 0.05), radius_top=half * 0.35)
        cylinder(frame, (0, y + height * 0.06, 0), half * 0.2, height * 0.22, 8, gold, radius_top=0.03)


def dress_dome(box):
    """A whitewashed dome splashed with saffron, with a small chaitya in each corner of its box."""
    rng = rng_for(box)
    frame = Frame((box["x"], box["y"] - box["hy"], box["z"]))
    radius, height = min(box["hx"], box["hz"]), 2 * box["hy"]
    above = stacked(box, 1)
    flat = (above["hx"] * math.sqrt(2) + 0.1) if above is not None else 0.5
    sides, rings = 20, 6
    profile = []
    for i in range(rings + 1):
        t = i / rings
        profile.append((radius - (radius - flat) * t ** 1.3, height * math.sin(t * math.pi / 2)))
    for i in range(rings):
        (r0, y0), (r1, y1) = profile[i], profile[i + 1]
        for k in range(sides):
            a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
            petal = i in (2, 3) and (k + i) % 2 == 0
            polygon(frame, ((math.cos(a0) * r0, y0, -math.sin(a0) * r0), (math.cos(a1) * r0, y0, -math.sin(a1) * r0),
                            (math.cos(a1) * r1, y1, -math.sin(a1) * r1), (math.cos(a0) * r1, y1, -math.sin(a0) * r1)),
                    linear(SAFFRON if petal else WHITEWASH, 0.03, rng))
    polygon(frame, [(math.cos(2 * math.pi * k / sides) * flat, height, -math.sin(2 * math.pi * k / sides) * flat) for k in range(sides)],
            linear(WHITEWASH, 0.03, rng))
    with lit(VERTEX_LIT):
        corner = radius * 0.86
        for sx in (-1, 1):
            for sz in (-1, 1):
                x, z = sx * corner, sz * corner
                block(frame, (x, 0.45, z), (0.6, 0.45, 0.6), linear(WHITEWASH, 0.03, rng))
                cylinder(frame, (x, 0.9, z), 0.55, 0.6, 10, linear(WHITEWASH, 0.03, rng), radius_top=0.2)
                cylinder(frame, (x, 1.5, z), 0.14, 0.9, 6, linear(GOLD), radius_top=0.02)


def eye(frame, x, y, lift):
    """One of the Buddha's eyes: an almond of white under a dark brow, looking down."""
    white, dark = linear(EYE_WHITE), linear(EYE_DARK)
    polygon(frame, [(x - 0.36, y, lift), (x - 0.15, y - 0.11, lift), (x + 0.15, y - 0.11, lift), (x + 0.36, y + 0.01, lift),
                    (x + 0.16, y + 0.15, lift), (x - 0.16, y + 0.15, lift)], white)
    polygon(frame, [(x + 0.02 + math.cos(a) * 0.1, y + 0.04 + math.sin(a) * 0.1, lift + 0.01) for a in
                    (2 * math.pi * k / 8 for k in range(8))], dark)
    brow = [(x + math.cos(a) * 0.42, y + 0.08 + math.sin(a) * 0.28) for a in (math.pi * (0.15 + 0.7 * k / 6) for k in range(7))]
    strip(frame, brow, 0.05, dark, lift + 0.01)


def strip(frame, points, width, color, lift):
    """A painted stroke along a line of 2D points on a `facing` frame."""
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        nx, ny = -dy / length * width / 2, dx / length * width / 2
        polygon(frame, ((x0 - nx, y0 - ny, lift), (x1 - nx, y1 - ny, lift), (x1 + nx, y1 + ny, lift), (x0 + nx, y0 + ny, lift)), color)


def dress_harmika(box):
    """The gilded cube above the dome, with the all-seeing eyes on every side."""
    height = 2 * box["hy"]
    dark = linear(EYE_DARK)
    for frame, half, _, _ in sides_of(box):
        with lit(VERTEX_LIT):
            wall_rect(frame, -half, half, 0, height, linear(GOLD, 0.03))
            wall_rect(frame, -half, half, height - 0.25, height, linear(GOLD_DARK), lift=0.02)
            for x in (-0.55, 0.55):
                eye(frame, x, height * 0.5, 0.02)
            # The nose is the Nepali numeral one, a curl standing for unity.
            curl = [(math.cos(a) * 0.11, height * 0.34 + math.sin(a) * 0.11) for a in (math.pi * (0.9 - 1.3 * k / 7) for k in range(8))]
            strip(frame, curl + [(0.0, height * 0.12)], 0.05, dark, 0.03)
            polygon(frame, [(math.cos(a) * 0.05, height * 0.72 + math.sin(a) * 0.05, 0.03) for a in
                            (2 * math.pi * k / 6 for k in range(6))], linear(0xb0262a))
    above = stacked(box, 1)
    with lit(VERTEX_LIT):
        top_ring(Frame((box["x"], 0, box["z"])), box["y"] + box["hy"], box["hx"], box["hz"], above["hx"] if above else 0,
                 lambda i, j: linear(GOLD_DARK))


def square_frustum(frame, y0, y1, half0, half1, color):
    for k, (sx, sz) in enumerate(((1, 1), (1, -1), (-1, -1), (-1, 1))):
        nx, nz = ((1, 1), (1, -1), (-1, -1), (-1, 1))[(k + 1) % 4]
        polygon(frame, ((sx * half0, y0, sz * half0), (nx * half0, y0, nz * half0), (nx * half1, y1, nz * half1), (sx * half1, y1, sz * half1)), color)


def dress_shikhara(box):
    """A stone tower temple: an arcaded storey, a storey of corner pavilions, then the curving
    spire of stacked stone courses capped by a ribbed amalaka."""
    rng = rng_for(box)
    frame = Frame((box["x"], box["y"] - box["hy"], box["z"]))
    half, height = box["hx"], 2 * box["hy"]
    for side_frame, side_half, _, _ in sides_of(box):
        wall_rect(side_frame, -side_half, side_half, 0, 3.0, linear(STONE, 0.04, rng))
        with lit(VERTEX_LIT):
            for x in (-1.3, 0, 1.3):
                arch(side_frame, x, 0.3, 0.8, 2.2, linear(SOOT, 0.1, rng), 0.02)
    with lit(VERTEX_LIT):
        block(frame, (0, 3.15, 0), (half, 0.15, half), linear(STONE_LIGHT, 0.03, rng))
        block(frame, (0, 4.4, 0), (half * 0.84, 1.1, half * 0.84), linear(STONE, 0.04, rng))
        for sx in (-1, 1):
            for sz in (-1, 1):
                x, z = sx * (half - 0.45), sz * (half - 0.45)
                block(frame, (x, 4.0, z), (0.42, 0.7, 0.42), linear(STONE_LIGHT, 0.04, rng))
                square_frustum(frame, 4.7, 5.4, 0.45, 0.05, linear(STONE_DARK, 0.04, rng))
        courses = 8
        top = height * 0.93
        for k in range(courses):
            y0 = 5.5 + (top - 5.5) * k / courses
            y1 = 5.5 + (top - 5.5) * (k + 1) / courses
            h0 = half * (0.78 - 0.45 * (k / courses) ** 1.6)
            h1 = half * (0.78 - 0.45 * ((k + 1) / courses) ** 1.6)
            square_frustum(frame, y0, y1, h0, h1, linear(STONE if k % 2 else STONE_LIGHT, 0.04, rng))
        cylinder(frame, (0, top, 0), half * 0.4, height - top, 12, lambda k: linear(STONE_DARK if k % 2 else STONE_LIGHT))


def dress_pillar(box):
    """A stone column carrying a gilded king at prayer, as in the Durbar Squares."""
    rng = rng_for(box)
    frame = Frame((box["x"], box["y"] - box["hy"], box["z"]))
    half, height = box["hx"], 2 * box["hy"]
    gold = linear(GOLD, 0.04, rng)
    block(frame, (0, 0.3, 0), (half, 0.3, half), linear(STONE_DARK, 0.04, rng))
    with lit(VERTEX_LIT):
        block(frame, (0, 0.75, 0), (half * 0.8, 0.15, half * 0.8), linear(STONE, 0.04, rng))
        cylinder(frame, (0, 0.9, 0), half * 0.6, height - 2.6, 8, linear(STONE_LIGHT, 0.04, rng), radius_top=half * 0.5)
        cylinder(frame, (0, height - 1.7, 0), half * 0.5, 0.4, 8, linear(STONE, 0.04, rng), radius_top=half * 0.95)
        cylinder(frame, (0, height - 1.3, 0), half * 0.55, 0.55, 8, gold, radius_top=half * 0.35)
        cylinder(frame, (0, height - 0.75, 0), half * 0.22, 0.25, 8, gold)
        cylinder(frame, (0, height - 0.5, 0), half * 0.95, 0.5, 8, linear(GOLD_DARK), radius_top=0.03)
