"""Building blocks for the map: one bmesh holding every face map.py makes, a colour per face
corner, and a per-face flag saying how the face gets its light."""

import math
import random
from contextlib import contextmanager

import bmesh
from mathutils import Matrix, Quaternion, Vector

# How a face is lit. Large surfaces players walk on or stand beside get the arena lightmap. Small
# detail would waste lightmap space on hundreds of tiny islands, and scenery is too far away to
# need it, so both get their light baked into vertex colours. The backdrop (hills and mountains)
# is vertex-lit too, then hazed by distance and drawn without fog.
LIGHTMAPPED = 0
VERTEX_LIT = 1
BACKDROP = 2

mesh_data = bmesh.new()
# Float colours: the byte kind stores sRGB, so linear values put in it come out far too dark.
color_layer = mesh_data.loops.layers.float_color.new("Color")
lighting_layer = mesh_data.faces.layers.int.new("lighting")
_lighting = LIGHTMAPPED


@contextmanager
def lit(mode):
    """Faces made inside `with lit(VERTEX_LIT):` are lit that way."""
    global _lighting
    previous, _lighting = _lighting, mode
    try:
        yield
    finally:
        _lighting = previous


def linear(hex_color, jitter=0.0, rng=random):
    """sRGB hex to a linear RGBA tuple, optionally brightened or darkened at random."""
    r, g, b = ((hex_color >> shift) & 255 for shift in (16, 8, 0))
    scale = 1 + rng.uniform(-jitter, jitter)

    def channel(c):
        c = c / 255
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return min(1.0, c * scale)

    return (channel(r), channel(g), channel(b), 1.0)


def game_to_blender(v):
    return Vector((v[0], -v[2], v[1]))


class Frame:
    """Places geometry built in a local game-style space (Y up) into Blender's world."""

    def __init__(self, center, rotation=None):
        self.center = Vector(center)
        self.rotation = rotation if rotation is not None else Quaternion()

    def point(self, local):
        return game_to_blender(self.center + self.rotation @ Vector(local))


def facing(origin, normal):
    """A frame on a vertical face: local x runs along the face, y up, z out along `normal`."""
    normal = Vector(normal).normalized()
    tangent = Vector((0, 1, 0)).cross(normal)
    return Frame(origin, Matrix((tangent, (0, 1, 0), normal)).transposed().to_quaternion())


def turned(center, yaw):
    return Frame(center, Quaternion((0, 1, 0), yaw))


def polygon(frame, corners, color):
    """A flat face through `corners`, counter-clockwise seen from the front."""
    verts = [mesh_data.verts.new(frame.point(c)) for c in corners]
    face = mesh_data.faces.new(verts)
    for loop in face.loops:
        loop[color_layer] = color
    face[lighting_layer] = _lighting
    return face


def rect(frame, center, u, v, color):
    """A quad facing along u x v."""
    center, u, v = Vector(center), Vector(u), Vector(v)
    return polygon(frame, (center - u - v, center + u - v, center + u + v, center - u + v), color)


def wall_rect(frame, x0, x1, y0, y1, color, lift=0.0):
    """An upright rectangle on a `facing` frame, `lift` metres out from the face."""
    return rect(frame, ((x0 + x1) / 2, (y0 + y1) / 2, lift), ((x1 - x0) / 2, 0, 0), (0, (y1 - y0) / 2, 0), color)


def grid(frame, center, u, v, count_u, count_v, color_at):
    center, u, v = Vector(center), Vector(u), Vector(v)
    for i in range(count_u):
        for j in range(count_v):
            offset = u * ((2 * i + 1) / count_u - 1) + v * ((2 * j + 1) / count_v - 1)
            rect(frame, center + offset, u / count_u, v / count_v, color_at(i, j))


BOX_FACES = {
    "+x": ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    "-x": ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    "+y": ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
    "-y": ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    "+z": ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    "-z": ((0, 0, -1), (0, 1, 0), (1, 0, 0)),
}


def box_faces(frame, half, color_of, skip=(), center=(0, 0, 0)):
    """The faces of a box. `color_of(face)` takes "+x", "-y" and so on."""
    half = Vector(half)
    for name, (normal, u, v) in BOX_FACES.items():
        if name in skip:
            continue
        mid = Vector(center) + Vector(normal) * abs(Vector(normal).dot(half))
        rect(frame, mid, Vector(u) * abs(Vector(u).dot(half)), Vector(v) * abs(Vector(v).dot(half)), color_of(name))


def block(frame, center, half, color, skip=("-y",)):
    """A plain box of one colour, sitting centred on `center`."""
    box_faces(frame, half, lambda face: color, skip, center)


def cylinder(frame, base, radius, height, sides, color, radius_top=None, top=True):
    """An upright n-sided cylinder, or frustum when `radius_top` differs, standing on `base`."""
    radius_top = radius if radius_top is None else radius_top
    bx, by, bz = base
    ring = [(math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    for k in range(sides):
        c0, s0 = ring[k]
        c1, s1 = ring[(k + 1) % sides]
        polygon(frame, (
            (bx + c0 * radius, by, bz - s0 * radius),
            (bx + c1 * radius, by, bz - s1 * radius),
            (bx + c1 * radius_top, by + height, bz - s1 * radius_top),
            (bx + c0 * radius_top, by + height, bz - s0 * radius_top),
        ), color(k) if callable(color) else color)
    if top and radius_top > 0:
        polygon(frame, [(bx + c * radius_top, by + height, bz - s * radius_top) for c, s in ring],
                color(-1) if callable(color) else color)


def weld():
    """Every face was built with its own corners; welding lets whole surfaces unwrap as one
    lightmap island instead of hundreds of tiles with seams between them."""
    bmesh.ops.remove_doubles(mesh_data, verts=mesh_data.verts, dist=0.001)
