"""Dressing for the clutter of war: sandbags, crates, containers, burnt-out vehicles and tents.
All of it is vertex-lit. Kit models (CC0, Quaternius: Toon Shooter Game Kit) are stretched to fit
their collision boxes exactly."""

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

from arena import BURLAP, CHARCOAL, OLIVE, OLIVE_DARK, RUST, SOOT, box_frame, half_of, rng_for
from common import bounds, flatten_materials, import_gltf
from mesh import VERTEX_LIT, Frame, block, cylinder, game_to_blender, linear, lit, polygon, rect

BAG_LENGTH = 0.6
BAG_HEIGHT = 0.2

prop_templates = {}
props = []


def template(name):
    found = prop_templates.get(name)
    if found is None:
        found = import_gltf(name + ".gltf")[0]
        for uv in list(found.data.uv_layers):
            found.data.uv_layers.remove(uv)
        flatten_materials(found, group_of=lambda _: "Map")
        bpy.context.scene.collection.objects.unlink(found)
        prop_templates[name] = found
    return found


def place(name, matrix):
    """A copy of a kit model. Every prop is vertex-lit."""
    obj = template(name).copy()
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = matrix @ template(name).matrix_world
    props.append(obj)
    return obj


def fit(name, box):
    """A kit model stretched to fill a box, its long side along the box's long side."""
    lo, hi = bounds([template(name)])
    size = hi - lo
    turn = 0.0 if (size.x >= size.y) == (box["hx"] >= box["hz"]) else math.pi / 2
    across, along = (size.x, size.y) if turn == 0 else (size.y, size.x)
    scale = Matrix.Diagonal((2 * box["hx"] / across, 2 * box["hz"] / along, 2 * box["hy"] / size.z, 1))
    base = game_to_blender((box["x"], box["y"] - box["hy"], box["z"]))
    return place(name, Matrix.Translation(base) @ Matrix.Rotation(box["yaw"], 4, "Z") @ scale
                 @ Matrix.Rotation(turn, 4, "Z") @ Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))


def dress_crate(box):
    fit("Crate", box)


def dress_container(box):
    fit("Container_Long" if max(box["hx"], box["hz"]) > 4 else "Container_Small", box)


def dress_sandbags(box):
    """Filled bags laid in courses like bricks, each a little fuller in the middle."""
    rng = rng_for(box)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    rows = max(1, round(2 * hy / BAG_HEIGHT))
    row_height = 2 * hy / rows
    with lit(VERTEX_LIT):
        for normal, along, half in (((1, 0, 0), (0, 0, -1), hz), ((-1, 0, 0), (0, 0, 1), hz),
                                    ((0, 0, 1), (1, 0, 0), hx), ((0, 0, -1), (-1, 0, 0), hx)):
            normal, along = Vector(normal), Vector(along)
            face = normal * (hx if normal.x else hz)
            for row in range(rows):
                y = -hy + (row + 0.5) * row_height
                s = -half - (BAG_LENGTH / 2 if row % 2 else 0)
                while s < half - 1e-6:
                    start, end = max(s, -half), min(s + BAG_LENGTH, half)
                    mid = face + along * ((start + end) / 2)
                    shade = linear(BURLAP, 0.12, rng)
                    darker = tuple(c * 0.8 for c in shade[:3]) + (1.0,)
                    rect(frame, mid + Vector((0, y + row_height / 4, 0)), along * ((end - start) / 2), (0, row_height / 4, 0), shade)
                    rect(frame, mid + Vector((0, y - row_height / 4, 0)), along * ((end - start) / 2), (0, row_height / 4, 0), darker)
                    s += BAG_LENGTH
        across = max(1, round(2 * hx / 0.35))
        lengthwise = max(1, round(2 * hz / BAG_LENGTH))
        for i in range(across):
            for j in range(lengthwise):
                x = -hx + (i + 0.5) * 2 * hx / across
                z = -hz + (j + 0.5) * 2 * hz / lengthwise
                rect(frame, (x, hy, z), (0, 0, hz / lengthwise), (hx / across, 0, 0), linear(BURLAP, 0.12, rng))


def wheel(frame, x, y, z, radius, width, color):
    """A wheel on an axle along local x."""
    hub = Frame(frame.center + frame.rotation @ Vector((x, y, z)), frame.rotation @ Quaternion((0, 0, 1), math.pi / 2))
    cylinder(hub, (0, -width / 2, 0), radius, width, 10, color)
    polygon(hub, [(math.cos(2 * math.pi * k / 10) * radius, -width / 2, math.sin(2 * math.pi * k / 10) * radius) for k in range(10)], color)


def burnt(rng, paint):
    """Burnt-out paintwork: mostly soot and rust, with some of the old colour left."""
    roll = rng.random()
    return linear(SOOT if roll < 0.45 else RUST if roll < 0.75 else paint, 0.15, rng)


def dress_truck(box):
    """A burnt-out cab-over lorry with a canvas tilt over its load bed. Front is local +z."""
    rng = rng_for(box)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    floor = -hy
    paint = rng.choice((OLIVE, 0xd07a2a, 0x3d6db0))
    with lit(VERTEX_LIT):
        for z in (hz - 1.1, -hz + 2.3, -hz + 1.0):
            for side in (-1, 1):
                wheel(frame, side * (hx - 0.2), floor + 0.5, z, 0.5, 0.36, linear(0x3a3a3a, 0.1, rng))
        block(frame, (0, floor + 0.8, 0), (hx - 0.25, 0.25, hz - 0.1), linear(CHARCOAL, 0.1, rng))
        block(frame, (0, floor + 1.8, hz - 1.0), (hx, 0.85, 1.0), burnt(rng, paint))
        for side in (-1, 1):
            rect(frame, (side * (hx + 0.01), floor + 2.1, hz - 0.8), (0, 0, -side * 0.5), (0, 0.35, 0), linear(SOOT, 0.1, rng))
        rect(frame, (0, floor + 2.1, hz + 0.01), (hx - 0.2, 0, 0), (0, 0.4, 0), linear(SOOT, 0.1, rng))
        block(frame, (0, floor + 1.55, -1.0), (hx, 0.5, hz - 2.0), burnt(rng, paint))
        block(frame, (0, floor + 2.6, -1.05), (hx, 0.5, hz - 2.05), linear(OLIVE_DARK if rng.random() < 0.6 else SOOT, 0.1, rng))


def dress_car(box):
    """A burnt-out taxi. Front is local +z."""
    rng = rng_for(box)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    floor = -hy
    paint = rng.choice((0xe8e4d8, 0x2f7a4a, 0xc9a227))
    with lit(VERTEX_LIT):
        for z in (hz - 0.6, -hz + 0.6):
            for side in (-1, 1):
                wheel(frame, side * (hx - 0.12), floor + 0.32, z, 0.32, 0.22, linear(0x333333, 0.1, rng))
        block(frame, (0, floor + 0.62, 0), (hx, 0.32, hz), burnt(rng, paint))
        block(frame, (0, floor + 1.26, -0.2), (hx - 0.08, 0.32, hz * 0.55), burnt(rng, paint))
        for side in (-1, 1):
            rect(frame, (side * (hx - 0.07), floor + 1.28, -0.2), (0, 0, -side * hz * 0.5), (0, 0.22, 0), linear(SOOT, 0.1, rng))


def dress_tent(box):
    """An army ridge tent, its ridge along the long side, door at the +z end."""
    rng = rng_for(box)
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    wall = 0.8
    canvas = linear(OLIVE, 0.06, rng)
    with lit(VERTEX_LIT):
        for side in (-1, 1):
            rect(frame, (side * hx, -hy + wall / 2, 0), (0, 0, -side * hz), (0, wall / 2, 0), canvas)
            polygon(frame, ((side * hx, -hy + wall, side * hz), (side * hx, -hy + wall, -side * hz), (0, hy, -side * hz), (0, hy, side * hz)),
                    linear(OLIVE, 0.06, rng))
        for end in (-1, 1):
            points = [(-hx, -hy, end * hz), (hx, -hy, end * hz), (hx, -hy + wall, end * hz), (0, hy, end * hz), (-hx, -hy + wall, end * hz)]
            polygon(frame, points if end > 0 else points[::-1], linear(OLIVE_DARK, 0.06, rng))
        polygon(frame, ((-0.6, -hy, hz + 0.01), (0.6, -hy, hz + 0.01), (0, hy - 0.6, hz + 0.01)), linear(0x2a2f20))
