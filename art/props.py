"""Dressing for the clutter of war: sandbags, crates, containers, vehicles and tents. All of it is
vertex-lit. Kit models (CC0: Quaternius' Toon Shooter Game Kit, Kenney's Car Kit) are stretched
to fit their collision boxes exactly."""

import math

import bpy
from mathutils import Matrix, Vector

from arena import BURLAP, OLIVE, OLIVE_DARK, RUST, SOOT, box_frame, half_of, rng_for
from common import apply_transform, bounds, flatten_materials, import_gltf, join
from mesh import VERTEX_LIT, game_to_blender, linear, lit, polygon, rect

BAG_LENGTH = 0.6
BAG_HEIGHT = 0.2

prop_templates = {}
props = []


def template(name):
    """A kit model, loaded once: its meshes joined into one, its colours baked into vertex
    colours (`name` may carry a folder and extension, else it is a .gltf in art/source)."""
    found = prop_templates.get(name)
    if found is None:
        objects = import_gltf(name if "." in name else name + ".gltf")
        meshes = [o for o in objects if o.type == "MESH"]
        for obj in objects:
            if obj.type != "MESH":
                bpy.data.objects.remove(obj)
        for obj in meshes:
            obj.parent = None
        found = join(meshes) if len(meshes) > 1 else meshes[0]
        apply_transform(found)
        flatten_materials(found, group_of=lambda _: "Map")
        decimate(found)
        for uv in list(found.data.uv_layers):
            found.data.uv_layers.remove(uv)
        bpy.context.scene.collection.objects.unlink(found)
        prop_templates[name] = found
    return found


# Kit vehicles arrive with thousands of vertices in their wheels and trim; this keeps their shape.
DECIMATE_ABOVE = 1500
DECIMATE_RATIO = 0.35


def decimate(obj):
    if len(obj.data.vertices) < DECIMATE_ABOVE:
        return
    modifier = obj.modifiers.new("Decimate", "DECIMATE")
    modifier.ratio = DECIMATE_RATIO
    with bpy.context.temp_override(object=obj, active_object=obj, selected_editable_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=modifier.name)


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


# Kathmandu's traffic: white Maruti taxis, blue and green microbuses, Tata lorries painted
# green, blue or red. Most of it was caught in the fighting.
CAR_MODELS = ("carkit/sedan.glb", "carkit/hatchback-sports.glb", "carkit/suv.glb", "carkit/taxi.glb", "carkit/van.glb")
CAR_PAINTS = (0xe8e4d8, 0xe8e4d8, 0x2c5aa0, 0x2f7a4a, 0xc9a227, 0x8a2a2a, 0x6d7479)
TRUCK_MODELS = ("carkit/truck.glb", "carkit/delivery.glb")
TRUCK_PAINTS = (0x2f7a4a, 0x2c5aa0, 0xb8302c, 0xd07a2a)
WRECK = "Debris_BrokenCar"
BURNT_OUT_CHANCE = 0.55


def is_paintwork(color):
    """Whether a kit colour is bodywork rather than glass, tyres, chrome or lights: the body is
    the saturated colour; everything else on these kits is grey or black."""
    r, g, b, _ = color
    return max(r, g, b) - min(r, g, b) > 0.06 and max(r, g, b) > 0.08


def repaint(obj, rng, paint, burnt_out):
    """Gives a fitted vehicle its own paint, keeping the kit's light and dark panels apart, then
    scorches and rusts it if it burnt out."""
    colors = obj.data.color_attributes["Color"].data
    paint = linear(paint, 0.12, rng)
    body = [c.color for c in colors if is_paintwork(c.color)]
    reference = max((max(c[:3]) for c in body), default=1.0)
    for face in obj.data.polygons:
        roll = rng.random()
        for index in face.loop_indices:
            color = colors[index].color
            if is_paintwork(color):
                shade = max(color[:3]) / reference
                color = (paint[0] * shade, paint[1] * shade, paint[2] * shade, 1.0)
            if burnt_out and roll < 0.55:
                color = linear(SOOT if roll < 0.3 else RUST, 0.15, rng)
            colors[index].color = color


def dress_truck(box):
    rng = rng_for(box)
    obj = fit(rng.choice(TRUCK_MODELS), box)
    repaint(obj, rng, rng.choice(TRUCK_PAINTS), rng.random() < BURNT_OUT_CHANCE)


def dress_car(box):
    rng = rng_for(box)
    if rng.random() < 0.3:
        fit(WRECK, box)
        return
    obj = fit(rng.choice(CAR_MODELS), box)
    repaint(obj, rng, rng.choice(CAR_PAINTS), rng.random() < BURNT_OUT_CHANCE)


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
