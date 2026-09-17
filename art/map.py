"""Builds the arena. Every collision box from src/shared/world.ts (exported by build.ts to
art/out/layout.json) gets modelled detail that stays on or behind its faces, so what you see
matches what blocks you. Scenery outside the walls is never reachable and has no collision.
All lighting is baked with Cycles: the arena into a lightmap, the scenery into vertex colours.
Writes map.glb and arena-light.webp to art/out/.

Props (CC0, Quaternius): Toon Shooter Game Kit."""

import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    OUT_DIR,
    export_glb,
    flatten_materials,
    import_gltf,
    join,
    shared_material,
    reset_scene,
)

PREVIEW = "--preview" in sys.argv
LAYOUT = json.load(open(os.path.join(OUT_DIR, "layout.json")))
HALF = LAYOUT["halfSize"]

# Lightmap for everything players can reach or stand next to.
ARENA_LIGHTMAP_SIZE = 2048
LIGHTMAP_ISLAND_MARGIN = 0.003
LIGHTMAP_QUALITY = 92
BAKE_SAMPLES = 384
BAKE_MARGIN_PX = 8
WELD_DISTANCE = 0.001
SUN_ANGLE_DEG = 1.2

TILE = 2.0
WALL_HEIGHT = 5.0
WALL_PANEL = 4.0
WALL_PILASTER = 0.6
WALL_RECESS = 0.1
WALL_KERB = 0.35
WALL_BAND = 1.4
WALL_CAP = 0.4
HAZARD_BAND = 0.2
HAZARD_STRIPE = 0.5
ZONE_LINE_HALF = 10
BLOCK_WIDTH = 1.2
BLOCK_HEIGHT = 0.4
STAIN_COUNT = 14
STAIN_SIDES = 9
LINE_WIDTH = 0.12
DECAL_LIFT = 0.006

random.seed(11)


def linear(hex_color, jitter=0.0):
    """sRGB hex to a linear RGBA tuple, optionally brightened or darkened at random."""
    r, g, b = ((hex_color >> shift) & 255 for shift in (16, 8, 0))
    scale = 1 + random.uniform(-jitter, jitter)

    def channel(c):
        c = c / 255
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return min(1.0, c * scale)

    return (channel(r), channel(g), channel(b), 1.0)


CONCRETE = 0x9d9c96
CONCRETE_DARK = 0x6e706f
CONCRETE_LIGHT = 0xbab8b0
FLOOR = 0x9a9892
ASPHALT = 0x696b6f
STAIN = 0x3a3b3e
BLOCK = 0xa39d92
# One accent per perimeter wall, so players can tell which way they are facing.
WALL_ACCENTS = {(0, 1): 0x9c3b32, (0, -1): 0xb58a2a, (1, 0): 0x3a5f8f, (-1, 0): 0x4d7a45}
METAL = 0x5d6772
METAL_DARK = 0x363c44
HAZARD_YELLOW = 0xe3ae1d
HAZARD_BLACK = 0x25262a
PAINT_YELLOW = 0xdcaa2e

mesh_data = bmesh.new()
color_layer = mesh_data.loops.layers.color.new("Color")


def game_to_blender(v):
    return Vector((v[0], -v[2], v[1]))


class Frame:
    """Places geometry built in a box's own (game, Y-up) space into Blender's world."""

    def __init__(self, center, rotation):
        self.center = Vector(center)
        self.rotation = rotation

    def point(self, local):
        return game_to_blender(self.center + self.rotation @ Vector(local))


def rect(frame, center, u, v, color):
    """A quad facing along u x v."""
    center, u, v = Vector(center), Vector(u), Vector(v)
    corners = (center - u - v, center + u - v, center + u + v, center - u + v)
    verts = [mesh_data.verts.new(frame.point(c)) for c in corners]
    face = mesh_data.faces.new(verts)
    for loop in face.loops:
        loop[color_layer] = color
    return face


def grid(frame, center, u, v, count_u, count_v, color_at):
    center, u, v = Vector(center), Vector(u), Vector(v)
    for i in range(count_u):
        for j in range(count_v):
            offset = u * ((2 * i + 1) / count_u - 1) + v * ((2 * j + 1) / count_v - 1)
            rect(frame, center + offset, u / count_u, v / count_v, color_at(i, j))


def box_faces(frame, half, color_of, skip=()):
    """The six faces of a box centred on the frame. `color_of(face)` takes "+x", "-y" and so on."""
    hx, hy, hz = half
    faces = {
        "+x": ((hx, 0, 0), (0, hy, 0), (0, 0, hz)),
        "-x": ((-hx, 0, 0), (0, 0, hz), (0, hy, 0)),
        "+y": ((0, hy, 0), (0, 0, hz), (hx, 0, 0)),
        "-y": ((0, -hy, 0), (hx, 0, 0), (0, 0, hz)),
        "+z": ((0, 0, hz), (hx, 0, 0), (0, hy, 0)),
        "-z": ((0, 0, -hz), (0, hy, 0), (hx, 0, 0)),
    }
    for name, (center, u, v) in faces.items():
        if name not in skip:
            rect(frame, center, u, v, color_of(name))


def side_bands(frame, half, bands, skip_top=False):
    """Vertical sides of a box split into horizontal bands: [(height, color_fn(face, i)), ...]
    listed from the bottom. Each color_fn gets the face name and a stripe index."""
    hx, hy, hz = half
    # "along" runs so that along x up points out of the box.
    sides = {
        "+x": ((hx, 0, 0), (0, 0, -hz)),
        "-x": ((-hx, 0, 0), (0, 0, hz)),
        "+z": ((0, 0, hz), (hx, 0, 0)),
        "-z": ((0, 0, -hz), (-hx, 0, 0)),
    }
    for name, (center, along) in sides.items():
        along = Vector(along)
        width = along.length
        y = -hy
        for height, color_fn, stripe in bands:
            mid = Vector(center) + Vector((0, y + height / 2, 0))
            up = Vector((0, height / 2, 0))
            count = max(1, round(2 * width / stripe)) if stripe else 1
            for i in range(count):
                offset = along * ((2 * i + 1) / count - 1)
                rect(frame, mid + offset, along / count, up, color_fn(name, i))
            y += height


def hazard(face, i):
    return linear(HAZARD_YELLOW if i % 2 == 0 else HAZARD_BLACK)


def dress_floor(box):
    frame = Frame((0, 0, 0), Quaternion())
    count = round(2 * HALF / TILE)

    def slab(i, j):
        # Concrete slabs inside the painted square, asphalt outside it.
        x = -HALF + (j + 0.5) * TILE
        z = -HALF + (i + 0.5) * TILE
        inside = max(abs(x), abs(z)) < ZONE_LINE_HALF
        return linear(FLOOR, 0.05) if inside else linear(ASPHALT, 0.06)

    grid(frame, (0, 0, 0), (0, 0, HALF), (HALF, 0, 0), count, count, slab)
    for _ in range(STAIN_COUNT):
        x, z = random.uniform(-HALF + 2, HALF - 2), random.uniform(-HALF + 2, HALF - 2)
        if max(abs(x), abs(z)) > ZONE_LINE_HALF + 1:
            stain(frame, x, z, random.uniform(0.4, 1.3))
    lift = (0, DECAL_LIFT, 0)
    for sign in (-1, 1):
        # A painted square around the middle of the arena.
        rect(frame, Vector((0, 0, sign * ZONE_LINE_HALF)) + Vector(lift), (0, 0, LINE_WIDTH / 2), (ZONE_LINE_HALF, 0, 0), linear(PAINT_YELLOW))
        rect(frame, Vector((sign * ZONE_LINE_HALF, 0, 0)) + Vector(lift), (0, 0, ZONE_LINE_HALF), (LINE_WIDTH / 2, 0, 0), linear(PAINT_YELLOW))


def stain(frame, x, z, radius):
    """A dark, irregular oil stain lying on the floor."""
    center = mesh_data.verts.new(frame.point((x, DECAL_LIFT / 2, z)))
    ring = []
    for k in range(STAIN_SIDES):
        angle = -2 * math.pi * k / STAIN_SIDES
        r = radius * random.uniform(0.6, 1.0)
        ring.append(mesh_data.verts.new(frame.point((x + math.cos(angle) * r, DECAL_LIFT / 2, z + math.sin(angle) * r))))
    color = linear(STAIN, 0.1)
    for k in range(STAIN_SIDES):
        face = mesh_data.faces.new((center, ring[k], ring[(k + 1) % STAIN_SIDES]))
        for loop in face.loops:
            loop[color_layer] = color


def dress_wall(box):
    center = Vector((box["x"], box["y"], box["z"]))
    thin_is_x = box["hx"] < box["hz"]
    # The face that looks into the arena, and the direction along it.
    normal = Vector((-math.copysign(1, center.x), 0, 0)) if thin_is_x else Vector((0, 0, -math.copysign(1, center.z)))
    tangent = Vector((0, 0, 1)) if thin_is_x else Vector((1, 0, 0))
    if normal.cross(tangent).y < 0:
        tangent = -tangent
    plane = center + normal * (box["hx"] if thin_is_x else box["hz"])
    origin = Vector((plane.x, 0, plane.z))
    rotation = Matrix((tangent, (0, 1, 0), normal)).transposed().to_quaternion()
    frame = Frame(origin, rotation)
    accent = WALL_ACCENTS[(round(normal.x), round(normal.z))]
    # Local space: x along the wall, y up, z out of the wall into the arena.
    top = WALL_HEIGHT - WALL_CAP
    rect(frame, (0, WALL_KERB / 2, 0), (HALF, 0, 0), (0, WALL_KERB / 2, 0), linear(CONCRETE_DARK))
    rect(frame, (0, top + WALL_CAP / 2, 0), (HALF, 0, 0), (0, WALL_CAP / 2, 0), linear(CONCRETE_LIGHT))
    panel_height = top - WALL_KERB
    count = round(2 * HALF / WALL_PANEL)
    for k in range(count + 1):
        middle = -HALF + k * WALL_PANEL
        start = max(-HALF, middle - WALL_PILASTER / 2)
        end = min(HALF, middle + WALL_PILASTER / 2)
        width = end - start
        pilaster = linear(CONCRETE, 0.03)
        rect(frame, (start + width / 2, WALL_KERB + panel_height / 2, 0), (width / 2, 0, 0), (0, panel_height / 2, 0), pilaster)
        if k < count:
            recessed_panel(frame, end, middle + WALL_PANEL - WALL_PILASTER / 2, top, accent)


def recessed_panel(frame, start, end, top, accent):
    width = end - start
    mid = start + width / 2
    band = WALL_BAND - WALL_KERB
    upper = top - WALL_BAND
    z = -WALL_RECESS
    rect(frame, (mid, WALL_KERB + band / 2, z), (width / 2, 0, 0), (0, band / 2, 0), linear(accent, 0.04))
    rect(frame, (mid, WALL_BAND + upper / 2, z), (width / 2, 0, 0), (0, upper / 2, 0), linear(CONCRETE, 0.05))
    height = top - WALL_KERB
    reveal = linear(CONCRETE_DARK)
    # Reveals: the short faces between the recessed panel and the wall face around it.
    rect(frame, (start, WALL_KERB + height / 2, z / 2), (0, height / 2, 0), (0, 0, WALL_RECESS / 2), reveal)
    rect(frame, (end, WALL_KERB + height / 2, z / 2), (0, 0, WALL_RECESS / 2), (0, height / 2, 0), reveal)
    rect(frame, (mid, WALL_KERB, z / 2), (0, 0, WALL_RECESS / 2), (width / 2, 0, 0), reveal)
    rect(frame, (mid, top, z / 2), (width / 2, 0, 0), (0, 0, WALL_RECESS / 2), reveal)


def box_frame(box):
    q = box["rotation"]
    return Frame((box["x"], box["y"], box["z"]), Quaternion((q["w"], q["x"], q["y"], q["z"])))


def half_of(box):
    return (box["hx"], box["hy"], box["hz"])


def dress_platform(box):
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    body = lambda face, i: linear(CONCRETE_DARK, 0.03)
    side_bands(frame, (hx, hy, hz), [(2 * hy - HAZARD_BAND, body, None), (HAZARD_BAND, hazard, HAZARD_STRIPE)])
    plates = lambda i, j: linear(METAL, 0.07)
    grid(frame, (0, hy, 0), (0, 0, hz), (hx, 0, 0), round(2 * hz), round(2 * hx), plates)


def dress_ramp(box):
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    box_faces(frame, (hx, hy, hz), lambda face: linear(METAL_DARK), skip=("-y", "+y"))
    steps = max(1, round(2 * hz / 0.4))
    grid(frame, (0, hy, 0), (0, 0, hz), (hx, 0, 0), steps, 1, lambda i, j: linear(METAL if i % 2 else METAL_DARK))


def dress_cover(box):
    """A wall of concrete blocks laid in a running bond, with a capping slab on top."""
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    cap = 0.12
    sides = {
        "+x": ((hx, 0, 0), (0, 0, -1), hz),
        "-x": ((-hx, 0, 0), (0, 0, 1), hz),
        "+z": ((0, 0, hz), (1, 0, 0), hx),
        "-z": ((0, 0, -hz), (-1, 0, 0), hx),
    }
    rows = max(1, round((2 * hy - cap) / BLOCK_HEIGHT))
    row_height = (2 * hy - cap) / rows
    for center, along, half_width in sides.values():
        along = Vector(along)
        for row in range(rows):
            y = -hy + (row + 0.5) * row_height
            s = -half_width - (BLOCK_WIDTH / 2 if row % 2 else 0)
            while s < half_width - 1e-6:
                start = max(s, -half_width)
                end = min(s + BLOCK_WIDTH, half_width)
                mid = Vector(center) + along * ((start + end) / 2) + Vector((0, y, 0))
                rect(frame, mid, along * ((end - start) / 2), (0, row_height / 2, 0), linear(BLOCK, 0.09))
                s += BLOCK_WIDTH
        rect(frame, Vector(center) + Vector((0, hy - cap / 2, 0)), along * half_width, (0, cap / 2, 0), linear(CONCRETE_LIGHT))
    rect(frame, (0, hy, 0), (0, 0, hz), (hx, 0, 0), linear(CONCRETE_LIGHT))


def dress_step(box):
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    edge = 0.08
    side_bands(frame, (hx, hy, hz), [(2 * hy, lambda face, i: linear(CONCRETE, 0.04), None)])
    rect(frame, (0, hy, 0), (0, 0, hz - edge), (hx - edge, 0, 0), linear(METAL, 0.05))
    for sign in (-1, 1):
        rect(frame, (0, hy, sign * (hz - edge / 2)), (0, 0, edge / 2), (hx, 0, 0), linear(HAZARD_YELLOW))
        rect(frame, (sign * (hx - edge / 2), hy, 0), (0, 0, hz - edge), (edge / 2, 0, 0), linear(HAZARD_YELLOW))


def dress_pillar(box):
    frame = box_frame(box)
    hx, hy, hz = half_of(box)
    height = 2 * hy
    stripes = lambda face, i: linear(HAZARD_YELLOW if i % 2 == 0 else HAZARD_BLACK)
    bands = [(0.4, lambda face, i: linear(CONCRETE_DARK), None)]
    bands += [(0.1, lambda face, i, k=k: linear(HAZARD_YELLOW if k % 2 == 0 else HAZARD_BLACK), None) for k in range(5)]
    bands += [(height - 1.2, lambda face, i: linear(CONCRETE, 0.03), None), (0.3, lambda face, i: linear(CONCRETE_LIGHT), None)]
    side_bands(frame, (hx, hy, hz), bands)
    rect(frame, (0, hy, 0), (0, 0, hz), (hx, 0, 0), linear(CONCRETE_LIGHT))


prop_templates = {}
props = []


def prop(name, position, yaw=0.0, scale=1.0, scenery=False):
    """Places a kit model. `position` is in game coordinates (Y up) at the model's base."""
    template = prop_templates.get(name)
    if template is None:
        objects = import_gltf(name + ".gltf")
        template = objects[0]
        for uv in list(template.data.uv_layers):
            template.data.uv_layers.remove(uv)
        flatten_materials(template, group_of=lambda _: "Map")
        bpy.context.scene.collection.objects.unlink(template)
        prop_templates[name] = template
    obj = template.copy()
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = (
        Matrix.Translation(game_to_blender(position))
        @ Matrix.Rotation(yaw, 4, "Z")
        @ Matrix.Diagonal((scale, scale, scale, 1))
        @ template.matrix_world
    )
    obj["scenery"] = scenery
    props.append(obj)
    return obj


def dress_crate(box):
    size = 2 * box["hx"]
    prop("Crate", (box["x"], box["y"] - box["hy"], box["z"]), box["yaw"], size / 0.79)


DRESSERS = {
    "floor": dress_floor,
    "wall": dress_wall,
    "platform": dress_platform,
    "ramp": dress_ramp,
    "cover": dress_cover,
    "crate": dress_crate,
    "step": dress_step,
    "pillar": dress_pillar,
}


def around(radius_min, radius_max, count, offset=0.0):
    """Evenly spread points in a ring outside the arena, with some randomness."""
    for i in range(count):
        angle = offset + 2 * math.pi * i / count + random.uniform(-0.15, 0.15)
        radius = random.uniform(radius_min, radius_max)
        yield math.sin(angle) * radius, math.cos(angle) * radius, angle


def add_scenery():
    # Stacked shipping containers just outside the walls, tall enough to show above them.
    for x, z, angle in around(24, 27, 10, 0.2):
        for level in range(random.choice((2, 3))):
            name = random.choice(("Container_Long", "Container_Small"))
            prop(name, (x, level * 2.75, z), angle + math.pi / 2 + random.uniform(-0.2, 0.2), 1.3, scenery=True)
    for x, z, angle in around(27, 34, 14, 0.5):
        prop(random.choice(("Tree_1", "Tree_2", "Tree_3", "Tree_4")), (x, 0, z), random.uniform(0, 6.28), random.uniform(1.4, 1.9), scenery=True)
    for x, z, angle in around(32, 40, 4, 0.9):
        prop(random.choice(("Structure_1", "Structure_2", "Structure_3", "Structure_4")), (x, 0, z), angle, 1.7, scenery=True)
    prop("WaterTank_Platform", (-27, 0, -27), 0.7, 2.6, scenery=True)
    prop("WaterTank_Platform", (29, 0, 26), 2.2, 2.4, scenery=True)
    # Floodlights on posts outside, leaning over the walls.
    for side in range(4):
        for along in (-12, 0, 12):
            yaw = side * math.pi / 2
            x = math.sin(yaw) * (HALF + 1.3) + math.cos(yaw) * along
            z = math.cos(yaw) * (HALF + 1.3) - math.sin(yaw) * along
            prop("StreetLight", (x, 0, z), yaw + street_light_facing(), 1.3, scenery=True)
    add_skyline()


_street_light_facing = None


def street_light_facing():
    """Yaw that turns the StreetLight model's arm toward -Y (Blender), i.e. into the arena."""
    global _street_light_facing
    if _street_light_facing is None:
        objects = import_gltf("StreetLight.gltf")
        corners = [objects[0].matrix_world @ Vector(c) for c in objects[0].bound_box]
        reach = sum(c.y for c in corners) / 8
        _street_light_facing = 0.0 if reach < 0 else math.pi
        for obj in objects:
            bpy.data.objects.remove(obj)
    return _street_light_facing


def add_skyline():
    """Plain tower blocks far away, so the horizon over the walls is never empty."""
    frame = Frame((0, 0, 0), Quaternion())
    colors = (0xb7ab98, 0x9aa3ab, 0x8f7f73, 0xc2beb4, 0x7d8791)
    for x, z, angle in around(60, 85, 18):
        width = random.uniform(10, 20)
        depth = random.uniform(10, 18)
        height = random.uniform(16, 36)
        rotation = Quaternion((0, 1, 0), angle)
        block = Frame((x, 0, z), rotation)
        wall = random.choice(colors)
        start = len(mesh_data.faces)
        box_faces(block, (width / 2, height / 2, depth / 2), lambda face: linear(wall, 0.04), skip=("-y",))
        # Shift the box up so it stands on the ground.
        for face in list(mesh_data.faces)[start:]:
            for vert in face.verts:
                vert.co.z += height / 2
            face[scenery_layer] = 1
        # Dark window rows on each floor, a hair in front of the walls.
        floors = int(height // 3.2)
        for level in range(1, floors):
            y = level * 3.2
            start = len(mesh_data.faces)
            for sign in (-1, 1):
                rect(block, (0, y, sign * (depth / 2 + 0.02)), (sign * width / 2 * 0.86, 0, 0), (0, 0.55, 0), linear(0x3b4350, 0.1))
                rect(block, (sign * (width / 2 + 0.02), y, 0), (0, 0, -sign * depth / 2 * 0.86), (0, 0.55, 0), linear(0x3b4350, 0.1))
            for face in list(mesh_data.faces)[start:]:
                face[scenery_layer] = 1


scenery_layer = mesh_data.faces.layers.int.new("scenery")


def build_geometry():
    for box in LAYOUT["boxes"]:
        DRESSERS[box["kind"]](box)
    add_scenery()
    for x, z in ((-6, 3), (8, -9), (-13, 10), (11, 7), (3, 15)):
        prop(random.choice(("Debris_Papers_1", "Debris_Papers_2", "Debris_Papers_3")), (x, 0.01, z), random.uniform(0, 6.28), 1.2)
    # Every quad was built with its own corners; welding them lets whole surfaces unwrap as one
    # lightmap island instead of hundreds of tiles with seams between them.
    bmesh.ops.remove_doubles(mesh_data, verts=mesh_data.verts, dist=WELD_DISTANCE)
    mesh = bpy.data.meshes.new("Arena")
    mesh_data.to_mesh(mesh)
    arena = bpy.data.objects.new("Arena", mesh)
    bpy.context.scene.collection.objects.link(arena)
    arena.data.materials.append(shared_material("Map"))
    arena.data.color_attributes.active_color = arena.data.color_attributes["Color"]
    return arena


def mark_scenery_props():
    for obj in props:
        mesh = obj.data = obj.data.copy()
        layer = mesh.attributes.get("scenery") or mesh.attributes.new("scenery", "INT", "FACE")
        layer.data.foreach_set("value", [1 if obj["scenery"] else 0] * len(mesh.polygons))


def split_scenery(world):
    """Moves the scenery into its own object, so it can have a smaller lightmap of its own."""
    mesh = world.data
    scenery = mesh.attributes["scenery"].data
    for polygon in mesh.polygons:
        far = bool(scenery[polygon.index].value)
        polygon.select = far
        for index in polygon.vertices:
            mesh.vertices[index].select = far
    for edge in mesh.edges:
        edge.select = all(mesh.vertices[index].select for index in edge.vertices)
    select_only(world)
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    far = next(o for o in bpy.context.scene.objects if o.type == "MESH" and o != world)
    world.name = "Arena"
    far.name = "Scenery"
    for obj in (world, far):
        obj.data.materials[0] = shared_material(obj.name)
        colors = obj.data.color_attributes
        colors.active_color = colors["Color"]
        colors.render_color_index = colors.active_color_index
    return world, far


def lightmap_uvs(obj):
    obj.data.uv_layers.new(name="Lightmap")
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=LIGHTMAP_ISLAND_MARGIN, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def select_only(obj):
    for other in bpy.context.scene.objects:
        other.select_set(other == obj)
    bpy.context.view_layer.objects.active = obj


def setup_lighting():
    lighting = LAYOUT["lighting"]
    scene = bpy.context.scene
    azimuth = math.radians(lighting["sunAzimuthDeg"])
    elevation = math.radians(lighting["sunElevationDeg"])
    toward_sun = game_to_blender((math.cos(elevation) * math.sin(azimuth), math.sin(elevation), math.cos(elevation) * math.cos(azimuth)))
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = lighting["sunIntensity"]
    sun.data.color = linear(lighting["sunColor"])[:3]
    sun.data.angle = math.radians(SUN_ANGLE_DEG)
    sun.rotation_euler = toward_sun.to_track_quat("Z", "Y").to_euler()
    scene.collection.objects.link(sun)

    world = bpy.data.worlds.new("Sky")
    scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = nodes["Background"]
    background.inputs["Strength"].default_value = lighting["skyIntensity"]
    coordinates = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "LINEAR"
    ramp.color_ramp.elements[0].position = 0.5
    ramp.color_ramp.elements[0].color = linear(lighting["horizonColor"])
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = linear(lighting["zenithColor"])
    ground = ramp.color_ramp.elements.new(0.49)
    ground.color = linear(lighting["groundColor"])
    to_unit = nodes.new("ShaderNodeMapRange")
    to_unit.inputs["From Min"].default_value = -1
    links.new(coordinates.outputs["Generated"], separate.inputs["Vector"])
    links.new(separate.outputs["Z"], to_unit.inputs["Value"])
    links.new(to_unit.outputs["Result"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], background.inputs["Color"])


def prepare_bake(obj):
    """Cycles settings, and a material whose surface colour comes from the vertex colours."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = BAKE_SAMPLES
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 3
    material = obj.data.materials[0]
    nodes = material.node_tree.nodes
    shader = nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = 1.0
    albedo = nodes.new("ShaderNodeVertexColor")
    albedo.layer_name = "Color"
    material.node_tree.links.new(albedo.outputs["Color"], shader.inputs["Base Color"])
    select_only(obj)
    return nodes


def bake_lightmap(obj, size):
    """Light only (no surface colour) into a texture; the game multiplies the vertex colours in."""
    nodes = prepare_bake(obj)
    image = bpy.data.images.new(obj.name + "Light", size, size, float_buffer=True, alpha=False)
    target = nodes.new("ShaderNodeTexImage")
    target.image = image
    nodes.active = target
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=BAKE_MARGIN_PX, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")
    return image


def bake_vertex_light(obj):
    """Lit colour straight into the vertex colours. Scenery is far away and full of small curved
    pieces that would each need their own lightmap island, so per-face light looks the same."""
    prepare_bake(obj)
    mesh = obj.data
    lit = mesh.color_attributes.new("Lit", "FLOAT_COLOR", "CORNER")
    mesh.color_attributes.active_color = lit
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"}, use_clear=True, target="VERTEX_COLORS")
    lit = mesh.color_attributes["Lit"]
    values = np.empty(len(lit.data) * 4, dtype=np.float32)
    lit.data.foreach_get("color", values)
    rgba = values.reshape(-1, 4)
    rgba[:, :3] = np.clip(rgba[:, :3] / LAYOUT["lighting"]["sceneryLightRange"], 0, 1)
    rgba[:, 3] = 1
    lit.data.foreach_set("color", rgba.ravel())
    mesh.color_attributes.remove(mesh.color_attributes["Color"])
    colors = mesh.color_attributes
    colors.active_color = colors["Lit"]
    colors.render_color_index = colors.active_color_index


def save_lightmap(image, file_name):
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    rgba = pixels.reshape(-1, 4)
    light = np.clip(rgba[:, :3] / LAYOUT["lighting"]["lightmapRange"], 0, 1)
    # sRGB encoding spends the 8 bits where the eye notices steps: in the shadows.
    encoded = np.where(light <= 0.0031308, light * 12.92, 1.055 * np.power(light, 1 / 2.4) - 0.055)
    rgba[:, :3] = encoded
    rgba[:, 3] = 1
    output = bpy.data.images.new(file_name, width, height, alpha=False)
    output.colorspace_settings.name = "Non-Color"
    output.pixels.foreach_set(rgba.ravel())
    output.file_format = "WEBP"
    output.save(filepath=os.path.join(OUT_DIR, file_name), quality=LIGHTMAP_QUALITY)


def main():
    reset_scene()
    arena = build_geometry()
    mark_scenery_props()
    world = join([arena] + props)
    colors = world.data.color_attributes
    colors.active_color = colors["Color"]
    colors.render_color_index = colors.active_color_index
    setup_lighting()
    if PREVIEW:
        render_previews()
        return
    arena, scenery = split_scenery(world)
    lightmap_uvs(arena)
    save_lightmap(bake_lightmap(arena, ARENA_LIGHTMAP_SIZE), "arena-light.webp")
    bake_vertex_light(scenery)
    export_glb("map.glb", [arena, scenery], normals=False, texcoords=True)


def render_previews():
    scene = bpy.context.scene
    material = bpy.data.materials["Map"]
    material.use_nodes = True
    nodes = material.node_tree.nodes
    color = nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Color"
    material.node_tree.links.new(color.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.lens = 18
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    for name, position, target in (
        ("map_overview", (-30, 28, 30), (0, 0, 0)),
        ("map_player", (-17, 1.6, 17), (0, 1.5, 0)),
        ("map_platform", (12, 3.6, 13), (-10, 1, -10)),
    ):
        eye = game_to_blender(position)
        look = game_to_blender(target)
        camera.matrix_world = Matrix.Translation(eye) @ (look - eye).to_track_quat("-Z", "Y").to_matrix().to_4x4()
        scene.render.filepath = os.path.join(OUT_DIR, "preview", name + ".png")
        bpy.ops.render.render(write_still=True)


main()
