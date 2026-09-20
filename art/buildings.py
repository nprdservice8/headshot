"""Dressing for the ground, the houses and everything built of brick or stone that players walk
on or take cover behind. Detail stays on or behind each collision box's faces."""

import math
import random

from mathutils import Quaternion, Vector

from arena import (
    ASPHALT, BRICK, BRICK_DARK, BRICK_PAVING, CONCRETE, CONCRETE_DARK, DIRT, EARTH, HALF, HAZARD_YELLOW,
    LAYOUT, METAL_ROOF, PAINT_WHITE, PLASTERS, RUST, SAFFRON, SHUTTERS, SIGNS, SOOT, STONE, STONE_DARK,
    STONE_LIGHT, TILE, TILE_DARK, WHITEWASH, WOOD, WOOD_DARK, box_frame, covered, half_of, is_plastered,
    rng_for, stacked,
)
from mesh import VERTEX_LIT, Frame, block, facing, grid, linear, lit, polygon, rect, turned, wall_rect
from signs import lettering, shop_name, wall_word

STOREY = 3.0
BAY = 2.7
GROUND_TILE = 2.0
FLAGSTONE = 1.5
CAP = 0.14
RISER = 0.22
SURFACES = {"paving": BRICK_PAVING, "asphalt": ASPHALT, "dirt": DIRT, "flagstones": STONE_LIGHT}
SIGN_INKS = (0xf4efe2, 0xffd84a)
# Lettering is the map's most expensive detail, so only some boards are named (the rest are
# painted plain), few signs hang out from the wall, and slogans are rare.
LETTERED_SIGNS = 0.22
HANGING_SIGNS = 0.04
WALL_WORDS = 0.05
INK_DARK = 0x1a1410
AWNINGS = ((0xb8302c, 0xe8e2d0), (0x2c5aa0, 0xe8e2d0), (0x2f7a4a, 0x2f7a4a), (0xe39a2c, 0xe39a2c), (0xb8302c, 0xb8302c))
AWNING_REACH = 0.7
AWNING_DROP = 0.3
PAINTS = (0xb8302c, 0x2c5aa0, 0x1a1410, 0x2f7a4a)


def sides_of(box):
    """A `facing` frame at the foot of each side of an unturned box, skipping the backs of the
    houses around the edge, which face out of the map."""
    x, y, z = box["x"], box["y"] - box["hy"], box["z"]
    for nx, nz, half, depth in ((1, 0, box["hz"], box["hx"]), (-1, 0, box["hz"], box["hx"]),
                                (0, 1, box["hx"], box["hz"]), (0, -1, box["hx"], box["hz"])):
        fx, fz = x + nx * depth, z + nz * depth
        if abs(fx * nx + fz * nz) >= HALF - 1e-3:
            continue
        yield facing((fx, y, fz), (nx, 0, nz)), half, (nx, nz), (fx, fz)


def band_hidden(face_at, normal, half, y):
    """Whether a band of a face is pressed against a neighbouring building all the way along."""
    (fx, fz), (nx, nz) = face_at, normal
    return all(covered(fx + nx * 0.05 + nz * a, y, fz + nz * 0.05 - nx * a) for a in (-0.8 * half, 0, 0.8 * half))


def top_ring(frame, y, outer_x, outer_z, inner, color_at):
    """The top of a box, leaving out the square `inner` half-size that the box above covers."""
    if inner <= 0:
        grid(frame, (0, y, 0), (0, 0, outer_z), (outer_x, 0, 0), max(1, round(outer_z * 2 / FLAGSTONE)), max(1, round(outer_x * 2 / FLAGSTONE)), color_at)
        return
    for sign in (-1, 1):
        mid = sign * (outer_z + inner) / 2
        grid(frame, (0, y, mid), (0, 0, (outer_z - inner) / 2), (outer_x, 0, 0), 1, max(1, round(outer_x * 2 / FLAGSTONE)), color_at)
        mid = sign * (outer_x + inner) / 2
        grid(frame, (mid, y, 0), (0, 0, inner), ((outer_x - inner) / 2, 0, 0), max(1, round(inner * 2 / FLAGSTONE)), 1, color_at)


def scorch(frame, x, y, radius, rng, lift=0.03):
    """A blackened splash on a wall (frame from `facing`) or, with `y` None, on the ground."""
    points = []
    for k in range(9):
        angle = 2 * math.pi * k / 9
        r = radius * rng.uniform(0.55, 1.0)
        if y is None:
            points.append((x[0] + math.cos(angle) * r, lift, x[1] - math.sin(angle) * r))
        else:
            points.append((x + math.cos(angle) * r, y + math.sin(angle) * r, lift))
    polygon(frame, points, linear(SOOT, 0.2, rng))


def bullet_holes(frame, half, y0, y1, rng):
    for _ in range(rng.randint(3, 9)):
        x, y = rng.uniform(-half + 0.3, half - 0.3), rng.uniform(y0 + 0.4, y1 - 0.4)
        size = rng.uniform(0.04, 0.08)
        wall_rect(frame, x - size, x + size, y - size, y + size, linear(SOOT, 0.3, rng), lift=0.035)


# The ground --------------------------------------------------------------------------------------


def surface_at(x, z):
    surface = "earth"
    for patch in LAYOUT["ground"]:
        if abs(x - patch["x"]) < patch["hx"] and abs(z - patch["z"]) < patch["hz"]:
            surface = patch["surface"]
    return surface


def ground_color(x, z, rng):
    surface = surface_at(x, z)
    if surface == "paving":
        # Brick laid in panels framed by stone, as in the squares of the old city.
        border = round(x) % 8 == 0 or round(z) % 8 == 0
        return linear(STONE if border else BRICK_PAVING, 0.07, rng)
    if surface == "asphalt":
        return linear(ASPHALT, 0.08, rng)
    return linear(SURFACES.get(surface, EARTH), 0.1, rng)


def dress_floor(box):
    rng = random.Random(3)
    frame = Frame((0, 0, 0))
    count = round(2 * HALF / GROUND_TILE)
    edge = GROUND_TILE / 2 - 0.01
    for i in range(count):
        for j in range(count):
            x = -HALF + (i + 0.5) * GROUND_TILE
            z = -HALF + (j + 0.5) * GROUND_TILE
            # Tiles under a building are never seen.
            if all(covered(x + dx, 0.2, z + dz) for dx in (-edge, edge) for dz in (-edge, edge)):
                continue
            rect(frame, (x, 0, z), (0, 0, GROUND_TILE / 2), (GROUND_TILE / 2, 0, 0), ground_color(x, z, rng))
    with lit(VERTEX_LIT):
        road_markings(frame)
        for _ in range(26):
            x, z = rng.uniform(-60, 60), rng.uniform(-60, 60)
            if not covered(x, 0.2, z):
                scorch(frame, (x, z), None, rng.uniform(0.8, 2.2), rng, lift=0.008)


def road_markings(frame):
    """Faded dashes down the middle of the streets."""
    color = linear(PAINT_WHITE)
    for along in range(-64, 65, 4):
        if abs(along) < 34:
            continue
        rect(frame, (0, 0.006, along), (0, 0, 0.9), (0.07, 0, 0), color)
        rect(frame, (along, 0.006, 0), (0, 0, 0.07), (0.9, 0, 0), color)


# Houses -----------------------------------------------------------------------------------------


def sign_colors(rng):
    """A board colour and lettering that reads against it: dark ink on light boards."""
    board = rng.choice(SIGNS)
    r, g, b = ((board >> shift) & 255 for shift in (16, 8, 0))
    light = 0.299 * r + 0.587 * g + 0.114 * b > 150
    return board, INK_DARK if light else rng.choice(SIGN_INKS)


def awning(frame, mid, half, y0, rng):
    """A striped cloth awning sloping out over the shop, with a valance hanging off its edge.
    It reaches past the collision box, but only above head height."""
    top = y0 + 2.35
    low = top - AWNING_DROP
    colors = rng.choice(AWNINGS)
    stripes = 4
    width = 2 * half / stripes
    for k in range(stripes):
        x0 = mid - half + k * width
        x1 = x0 + width
        color = linear(colors[k % 2], 0.08, rng)
        polygon(frame, ((x0, low, AWNING_REACH), (x1, low, AWNING_REACH), (x1, top, 0.02), (x0, top, 0.02)), color)
        polygon(frame, ((x0, low - 0.18, AWNING_REACH), (x1, low - 0.18, AWNING_REACH), (x1, low, AWNING_REACH), (x0, low, AWNING_REACH)), color)


def side_frame(frame, x, direction):
    """A frame at `x` along a wall whose front looks along the wall (`direction` +1 or -1), for
    signs that stick out from the wall."""
    return Frame(frame.center + frame.rotation @ Vector((x, 0, 0)), frame.rotation @ Quaternion((0, 1, 0), direction * math.pi / 2))


def hanging_sign(frame, x, y0, rng):
    """A small board sticking out from the wall, lettered on both sides."""
    board, ink = sign_colors(rng)
    inner, outer = 0.05, 0.65
    bottom, top = y0 + 2.0, y0 + 2.42
    name = shop_name(rng)
    paint = linear(board, 0.1, rng)
    polygon(frame, ((x, bottom, outer), (x, bottom, inner), (x, top, inner), (x, top, outer)), paint)
    polygon(frame, ((x, bottom, inner), (x, bottom, outer), (x, top, outer), (x, top, inner)), paint)
    # Each side's frame runs its x along the board, so the lettering is centred halfway out.
    for direction in (1, -1):
        lettering(side_frame(frame, x, direction), name, -direction * (inner + outer) / 2, bottom + 0.09, 0.24, linear(ink), 0.012, outer - inner - 0.08)
    wall_rect(frame, x - 0.02, x + 0.02, top - 0.05, top + 0.25, linear(0x3a3d40), lift=0.03)


def shopfront(frame, mid, width, y0, rng):
    """Ground floors are shops: a rolled-down shutter or a dark doorway, a named signboard
    above, an awning or a hanging sign for some."""
    half = min(width - 0.6, 2.3) / 2
    if rng.random() < 0.7:
        shade = rng.choice(SHUTTERS)
        wall_rect(frame, mid - half, mid + half, y0 + 0.1, y0 + 2.3, linear(shade, 0.08, rng), lift=0.02)
        for k in range(1, 5):
            y = y0 + 0.1 + k * 0.44
            wall_rect(frame, mid - half, mid + half, y - 0.025, y + 0.025, linear(0x3a3d40), lift=0.03)
    else:
        wall_rect(frame, mid - 0.55, mid + 0.55, y0, y0 + 2.1, linear(WOOD_DARK, 0.1, rng), lift=0.02)
    if rng.random() < 0.8:
        board, ink = sign_colors(rng)
        wall_rect(frame, mid - half, mid + half, y0 + 2.4, y0 + 2.9, linear(board, 0.1, rng), lift=0.06)
        if rng.random() < LETTERED_SIGNS:
            lettering(frame, shop_name(rng), mid, y0 + 2.49, 0.3, linear(ink), 0.075, 2 * half - 0.25)
    roll = rng.random()
    if roll < 0.4:
        awning(frame, mid, half, y0, rng)
    elif roll < 0.4 + HANGING_SIGNS:
        hanging_sign(frame, mid + half + 0.12, y0, rng)


def window(frame, mid, y0, y1, plastered, rng):
    y = (y0 + y1) / 2 + 0.1
    broken = rng.random() < 0.25
    if plastered:
        wall_rect(frame, mid - 0.6, mid + 0.6, y - 0.6, y + 0.6, linear(0xb8bcc0, 0.05, rng), lift=0.02)
        wall_rect(frame, mid - 0.5, mid + 0.5, y - 0.5, y + 0.5, linear(SOOT if broken else 0x2d3a45, 0.1, rng), lift=0.03)
        return
    # A carved window: dark frame, latticed opening, projecting sill.
    wide = rng.random() < 0.2
    half = 1.0 if wide else 0.55
    wall_rect(frame, mid - half, mid + half, y - 0.65, y + 0.65, linear(WOOD, 0.1, rng), lift=0.02)
    wall_rect(frame, mid - half + 0.14, mid + half - 0.14, y - 0.5, y + 0.5, linear(SOOT if broken else WOOD_DARK, 0.1, rng), lift=0.03)
    wall_rect(frame, mid - half - 0.1, mid + half + 0.1, y - 0.75, y - 0.65, linear(WOOD, 0.1, rng), lift=0.06)


def dress_house(box):
    rng = rng_for(box)
    plastered = is_plastered(box)
    height = 2 * box["hy"]
    storeys = max(1, round(height / STOREY))
    storey = height / storeys
    wall = rng.choice(PLASTERS) if plastered else BRICK
    for frame, half, normal, face_at in sides_of(box):
        for s in range(storeys):
            y0, y1 = s * storey, (s + 1) * storey
            if band_hidden(face_at, normal, half, (y0 + y1) / 2):
                continue
            base = 0.5 if s == 0 else 0
            wall_rect(frame, -half, half, y0 + base, y1, linear(wall, 0.05, rng))
            if base:
                wall_rect(frame, -half, half, 0, base, linear(CONCRETE_DARK if plastered else BRICK_DARK, 0.05, rng))
            with lit(VERTEX_LIT):
                bays = max(1, int(2 * half / BAY))
                width = 2 * half / bays
                for b in range(bays):
                    mid = -half + (b + 0.5) * width
                    if s == 0:
                        shopfront(frame, mid, width, y0, rng)
                    elif rng.random() < 0.85:
                        window(frame, mid, y0, y1, plastered, rng)
                if s > 0 and not plastered:
                    wall_rect(frame, -half, half, y0 - 0.08, y0 + 0.1, linear(WOOD, 0.1, rng), lift=0.04)
                if s > 0 and half > 2 and rng.random() < WALL_WORDS:
                    lettering(frame, wall_word(rng), rng.uniform(-half + 1.4, half - 1.4), y0 + rng.uniform(0.5, 1.3), 0.34, linear(rng.choice(PAINTS), 0.1, rng), 0.015, 2.6)
                if s < 2 and rng.random() < 0.35:
                    scorch(frame, rng.uniform(-half + 1, half - 1), rng.uniform(y0 + 0.8, y1 - 0.3), rng.uniform(0.6, 1.4), rng)
                if s == 0 and rng.random() < 0.6:
                    bullet_holes(frame, half, y0, y1, rng)


def dress_gate(box):
    """A city gate, its doors shut and barricaded."""
    rng = rng_for(box)
    height = 2 * box["hy"]
    for frame, half, (nx, nz), (fx, fz) in sides_of(box):
        wall_rect(frame, -half, half, 0, height, linear(BRICK, 0.05, rng))
        # Only the side facing into the map has the gateway.
        if fx * nx + fz * nz > 0:
            continue
        with lit(VERTEX_LIT):
            wall_rect(frame, -3.4, 3.4, 0, 5.4, linear(STONE, 0.05, rng), lift=0.02)
            for side in (-1, 1):
                wall_rect(frame, min(0, side * 2.9), max(0, side * 2.9), 0, 4.9, linear(WOOD, 0.1, rng), lift=0.04)
                for k in range(6):
                    y = 0.5 + k * 0.8
                    wall_rect(frame, min(0.1 * side, side * 2.8), max(0.1 * side, side * 2.8), y, y + 0.08, linear(0x2c2c2c), lift=0.05)
            wall_rect(frame, -half, half, height - 0.5, height, linear(WOOD, 0.1, rng), lift=0.04)
            scorch(frame, rng.uniform(-2, 2), 2.2, 1.6, rng, lift=0.06)
            bullet_holes(frame, 3, 0, 4.9, rng)


def dress_roof(box):
    """A hipped roof filling its box: eaves at the bottom, ridge at the top."""
    rng = rng_for(box)
    house = stacked(box, -1)
    metal = house is not None and is_plastered(house)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    along_x = hx >= hz
    ridge = abs(hx - hz)
    rx, rz = (ridge, 0) if along_x else (0, ridge)
    corners = [(-hx, -hy, hz), (hx, -hy, hz), (hx, -hy, -hz), (-hx, -hy, -hz)]
    top = {0: (-rx, hy, rz), 1: (rx, hy, rz), 2: (rx, hy, -rz), 3: (-rx, hy, -rz)}
    base = METAL_ROOF if metal else TILE
    courses = 7
    with lit(VERTEX_LIT):
        for k in range(4):
            a, b = Vector(corners[k]), Vector(corners[(k + 1) % 4])
            ta, tb = Vector(top[k]), Vector(top[(k + 1) % 4])
            for c in range(courses):
                s0, s1 = c / courses, (c + 1) / courses
                shade = (RUST if metal and rng.random() < 0.3 else base) if c % 2 else (TILE_DARK if not metal else base)
                quad = (a.lerp(ta, s0), b.lerp(tb, s0), b.lerp(tb, s1), a.lerp(ta, s1))
                if (quad[0] - quad[3]).length < 1e-4 and (quad[1] - quad[2]).length < 1e-4:
                    continue
                points = [quad[0], quad[1], quad[2]] if (quad[2] - quad[3]).length < 1e-4 else list(quad)
                polygon(frame, points, linear(shade, 0.06, rng))
        if house is not None:
            soffit(frame, hx, hy, hz, house["hx"], house["hz"], rng)


def soffit(frame, hx, hy, hz, inner_x, inner_z, rng):
    """The underside of the eaves, where it overhangs the walls."""
    color = linear(WOOD, 0.1, rng)
    y = -hy
    for sign in (-1, 1):
        rect(frame, (0, y, sign * (hz + inner_z) / 2), (hx, 0, 0), (0, 0, (hz - inner_z) / 2), color)
        rect(frame, (sign * (hx + inner_x) / 2, y, 0), ((hx - inner_x) / 2, 0, 0), (0, 0, inner_z), color)


def dress_ruin(box):
    """A shelled house: jagged walls round a heap of its own rubble."""
    rng = rng_for(box)
    height = 2 * box["hy"]
    for frame, half, _, _ in sides_of(box):
        count = max(2, round(2 * half))
        tops = [height * rng.uniform(0.45, 1.0) for _ in range(count + 1)]
        for k in range(count):
            x0 = -half + 2 * half * k / count
            x1 = -half + 2 * half * (k + 1) / count
            polygon(frame, ((x0, 0, 0), (x1, 0, 0), (x1, tops[k + 1], 0), (x0, tops[k], 0)), linear(BRICK, 0.06, rng))
        with lit(VERTEX_LIT):
            for k in range(count):
                x = -half + 2 * half * (k + 0.5) / count
                if min(tops[k], tops[k + 1]) > 2.4 and rng.random() < 0.5:
                    wall_rect(frame, x - 0.4, x + 0.4, 1.0, 2.1, linear(SOOT, 0.2, rng), lift=0.02)
            scorch(frame, rng.uniform(-half + 1, half - 1), rng.uniform(0.8, 2.5), rng.uniform(0.8, 1.6), rng)
    with lit(VERTEX_LIT):
        top = Frame((box["x"], 0, box["z"]))
        for _ in range(round(box["hx"] * box["hz"] * 0.7)):
            x, z = rng.uniform(-box["hx"] + 0.4, box["hx"] - 0.4), rng.uniform(-box["hz"] + 0.4, box["hz"] - 0.4)
            size = rng.uniform(0.25, 0.7)
            y = height * rng.uniform(0.35, 0.6)
            block(turned((box["x"] + x, 0, box["z"] + z), rng.uniform(0, 3)), (0, y, 0), (size, size * 0.6, size * 0.8),
                  linear(rng.choice((BRICK, BRICK_DARK, CONCRETE, WOOD)), 0.1, rng))
        rect(top, (0, height * 0.45, 0), (0, 0, box["hz"]), (box["hx"], 0, 0), linear(BRICK_DARK, 0.1, rng))


# Plinths, terraces and stairs -------------------------------------------------------------------


def dress_plinth(box, wall=BRICK, top=STONE, trim=STONE_LIGHT):
    """One level of a temple plinth: brick sides under a stone cap, paved with flagstones."""
    rng = rng_for(box)
    height = 2 * box["hy"]
    for frame, half, _, _ in sides_of(box):
        wall_rect(frame, -half, half, 0, height - CAP, linear(wall, 0.04, rng))
        wall_rect(frame, -half, half, height - CAP, height, linear(trim, 0.03, rng))
    above = stacked(box, 1)
    inner = min(above["hx"], above["hz"]) if above is not None else 0
    top_ring(Frame((box["x"], 0, box["z"])), box["y"] + box["hy"], box["hx"], box["hz"], inner, lambda i, j: linear(top, 0.06, rng))


def dress_terrace(box):
    dress_plinth(box, wall=WHITEWASH, top=0xd9d4c8, trim=SAFFRON)


def ramp_frame(box):
    """A frame at the foot of a ramp, turned so local +z runs uphill, and the ramp's run and rise."""
    hz = box["hz"]
    run = 2 * hz * math.cos(box["tilt"])
    rise = 2 * hz * math.sin(-box["tilt"])
    yaw = box["yaw"]
    # The top surface's low edge, from the box centre: back down the slope, up by the thickness.
    normal_y, normal_forward = math.cos(box["tilt"]), math.sin(box["tilt"])
    cx = box["x"] + math.sin(yaw) * normal_forward * box["hy"] - math.sin(yaw) * run / 2
    cz = box["z"] + math.cos(yaw) * normal_forward * box["hy"] - math.cos(yaw) * run / 2
    return turned((cx, 0, cz), yaw), run, rise


def ramp_sides(frame, run, rise, width, color):
    for side in (-1, 1):
        x = side * width / 2
        points = [(x, 0, 0), (x, 0, run), (x, rise, run)]
        polygon(frame, points if side < 0 else points[::-1], color)


def dress_stairs(box):
    """Stone steps whose front edges lie on the ramp players actually walk on."""
    rng = rng_for(box)
    frame, run, rise = ramp_frame(box)
    width = 2 * box["hx"]
    steps = max(1, round(rise / RISER))
    riser, tread = rise / steps, run / steps
    for k in range(1, steps + 1):
        d = k * tread
        rect(frame, (0, (k - 0.5) * riser, d), (-width / 2, 0, 0), (0, riser / 2, 0), linear(STONE_DARK, 0.05, rng))
        if k < steps:
            rect(frame, (0, k * riser, d + tread / 2), (0, 0, tread / 2), (width / 2, 0, 0), linear(STONE_LIGHT, 0.05, rng))
    ramp_sides(frame, run, rise, width, linear(STONE, 0.04, rng))


def dress_ramp(box):
    """A steel ramp up to the helipad."""
    rng = rng_for(box)
    frame, run, rise = ramp_frame(box)
    width = 2 * box["hx"]
    strips = max(1, round(run / 0.4))
    for k in range(strips):
        s0, s1 = k / strips, (k + 1) / strips
        polygon(frame, ((-width / 2, rise * s0, run * s0), (-width / 2, rise * s1, run * s1),
                        (width / 2, rise * s1, run * s1), (width / 2, rise * s0, run * s0)),
                linear(0x5d6772 if k % 2 else 0x363c44))
    ramp_sides(frame, run, rise, width, linear(0x363c44))
    rect(frame, (0, rise / 2, run), (width / 2, 0, 0), (0, rise / 2, 0), linear(0x363c44))


def dress_rubble(box):
    """A slope of broken brick and plaster from a collapsed wall."""
    rng = rng_for(box)
    frame, run, rise = ramp_frame(box)
    width = 2 * box["hx"]
    polygon(frame, ((-width / 2, 0, 0), (-width / 2, rise, run), (width / 2, rise, run), (width / 2, 0, 0)), linear(0x8a6a58, 0.05, rng))
    ramp_sides(frame, run, rise, width, linear(0x7d6150, 0.05, rng))
    rect(frame, (0, rise / 2, run), (width / 2, 0, 0), (0, rise / 2, 0), linear(0x7d6150, 0.05, rng))
    slope = math.atan2(rise, run)
    with lit(VERTEX_LIT):
        for _ in range(round(width * run * 1.6)):
            u, d = rng.uniform(-width / 2 + 0.3, width / 2 - 0.3), rng.uniform(0.3, run - 0.3)
            size = rng.uniform(0.15, 0.4)
            chunk = Frame(frame.center + frame.rotation @ Vector((u, d * rise / run - 0.02, d)),
                          frame.rotation @ Quaternion((1, 0, 0), -slope) @ Quaternion((0, 1, 0), rng.uniform(0, 3)))
            block(chunk, (0, 0, 0), (size, size * 0.4, size * 0.7), linear(rng.choice((BRICK, BRICK_DARK, 0xcfc6b4, CONCRETE)), 0.1, rng))


def dress_platform(box):
    """A sandbagged concrete helipad."""
    rng = rng_for(box)
    height = 2 * box["hy"]
    for frame, half, _, _ in sides_of(box):
        wall_rect(frame, -half, half, 0, height - 0.2, linear(CONCRETE_DARK, 0.03, rng))
        wall_rect(frame, -half, half, height - 0.2, height, linear(HAZARD_YELLOW))
    top = Frame((box["x"], box["y"] + box["hy"], box["z"]))
    grid(top, (0, 0, 0), (0, 0, box["hz"]), (box["hx"], 0, 0), 7, 7, lambda i, j: linear(CONCRETE, 0.05, rng))
    with lit(VERTEX_LIT):
        white = linear(PAINT_WHITE)
        sides = 24
        for k in range(sides):
            a0, a1 = 2 * math.pi * k / sides, 2 * math.pi * (k + 1) / sides
            r0, r1 = box["hx"] - 1.6, box["hx"] - 1.2
            polygon(top, ((math.cos(a0) * r1, 0.01, -math.sin(a0) * r1), (math.cos(a1) * r1, 0.01, -math.sin(a1) * r1),
                          (math.cos(a1) * r0, 0.01, -math.sin(a1) * r0), (math.cos(a0) * r0, 0.01, -math.sin(a0) * r0)), white)
        for x in (-1.1, 1.1):
            rect(top, (x, 0.01, 0), (0, 0, 2.2), (0.3, 0, 0), white)
        rect(top, (0, 0.01, 0), (0, 0, 0.3), (0.8, 0, 0), white)
