"""Builds the map: a war-torn corner of old Kathmandu. Every collision box from
src/shared/world.ts (exported by build.ts to art/out/layout.json) gets modelled detail that stays
on or behind its faces, so what you see matches what blocks you. Scenery beyond the edge is never
reachable and has no collision.

All lighting is baked with Cycles: large surfaces into a lightmap, detail and scenery into vertex
colours. The far backdrop is then hazed by distance and drawn without fog, so it reaches past the
fog to the horizon. Writes map.glb and arena-light.webp to art/out/.

Props (CC0, Quaternius): Toon Shooter Game Kit."""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from arena import BOXES, LAYOUT  # noqa: E402
from buildings import (  # noqa: E402
    dress_floor, dress_gate, dress_house, dress_plinth, dress_platform, dress_ramp, dress_roof,
    dress_rubble, dress_ruin, dress_stairs, dress_terrace,
)
from common import OUT_DIR, export_glb, join, reset_scene, shared_material  # noqa: E402
from mesh import BACKDROP, VERTEX_LIT, game_to_blender, linear, mesh_data, weld  # noqa: E402
from props import dress_car, dress_container, dress_crate, dress_sandbags, dress_tent, dress_truck, props  # noqa: E402
from scenery import add_scenery  # noqa: E402
from temples import dress_dome, dress_harmika, dress_pillar, dress_shikhara, dress_shrine, dress_spire, dress_tier  # noqa: E402

PREVIEW = "--preview" in sys.argv

ARENA_LIGHTMAP_SIZE = 2048
LIGHTMAP_ISLAND_MARGIN = 0.002
LIGHTMAP_QUALITY = 90
BAKE_SAMPLES = 768
BAKE_MARGIN_PX = 6
SUN_ANGLE_DEG = 1.2
# Air hides the far backdrop's detail: this far away it is half gone into the horizon's colour.
HAZE_HALF_DISTANCE = 1500
HAZE_MAX = 0.8

DRESSERS = {
    "floor": dress_floor,
    "house": dress_house,
    "roof": dress_roof,
    "gate": dress_gate,
    "ruin": dress_ruin,
    "plinth": dress_plinth,
    "terrace": dress_terrace,
    "stairs": dress_stairs,
    "ramp": dress_ramp,
    "rubble": dress_rubble,
    "shrine": dress_shrine,
    "tier": dress_tier,
    "spire": dress_spire,
    "dome": dress_dome,
    "harmika": dress_harmika,
    "shikhara": dress_shikhara,
    "pillar": dress_pillar,
    "sandbags": dress_sandbags,
    "crate": dress_crate,
    "container": dress_container,
    "truck": dress_truck,
    "car": dress_car,
    "tent": dress_tent,
    "platform": dress_platform,
}


def build_geometry():
    for box in BOXES:
        DRESSERS[box["kind"]](box)
    add_scenery()
    weld()
    mesh = bpy.data.meshes.new("Arena")
    mesh_data.to_mesh(mesh)
    arena = bpy.data.objects.new("Arena", mesh)
    bpy.context.scene.collection.objects.link(arena)
    arena.data.materials.append(shared_material("Map"))
    for obj in props:
        obj.data = obj.data.copy()
        layer = obj.data.attributes.new("lighting", "INT", "FACE")
        layer.data.foreach_set("value", [VERTEX_LIT] * len(obj.data.polygons))
    world = join([arena] + props)
    colors = world.data.color_attributes
    colors.active_color = colors["Color"]
    colors.render_color_index = colors.active_color_index
    return world


def select_only(obj):
    for other in bpy.context.scene.objects:
        other.select_set(other == obj)
    bpy.context.view_layer.objects.active = obj


def separate(obj, flags, name):
    """Moves the faces whose lighting flag is one of `flags` into a new object called `name`."""
    mesh = obj.data
    lighting = mesh.attributes["lighting"].data
    for vertex in mesh.vertices:
        vertex.select = False
    for polygon in mesh.polygons:
        polygon.select = lighting[polygon.index].value in flags
        if polygon.select:
            for index in polygon.vertices:
                mesh.vertices[index].select = True
    for edge in mesh.edges:
        edge.select = all(mesh.vertices[index].select for index in edge.vertices)
    before = set(bpy.context.scene.objects)
    select_only(obj)
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    split = next(o for o in bpy.context.scene.objects if o not in before)
    split.name = name
    split.data.materials[0] = shared_material(name)
    return split


def lightmap_uvs(obj):
    obj.data.uv_layers.new(name="Lightmap")
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=LIGHTMAP_ISLAND_MARGIN, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


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
    separate_xyz = nodes.new("ShaderNodeSeparateXYZ")
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
    links.new(coordinates.outputs["Generated"], separate_xyz.inputs["Vector"])
    links.new(separate_xyz.outputs["Z"], to_unit.inputs["Value"])
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
    """Lit colour straight into the vertex colours."""
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


def haze(obj):
    """Fades the backdrop toward the colour of the sky at the horizon, further the further away."""
    lighting = LAYOUT["lighting"]
    horizon = np.array(linear(lighting["horizonColor"])[:3]) * lighting["skyIntensity"] / lighting["sceneryLightRange"]
    mesh = obj.data
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", positions)
    positions = positions.reshape(-1, 3)
    corners = np.empty(len(mesh.loops), dtype=np.int32)
    mesh.loops.foreach_get("vertex_index", corners)
    distance = np.hypot(positions[corners, 0], positions[corners, 1])
    amount = np.minimum(HAZE_MAX, 1 - 0.5 ** (distance / HAZE_HALF_DISTANCE))[:, None]
    lit = mesh.color_attributes["Lit"]
    values = np.empty(len(lit.data) * 4, dtype=np.float32)
    lit.data.foreach_get("color", values)
    rgba = values.reshape(-1, 4)
    rgba[:, :3] = rgba[:, :3] * (1 - amount) + horizon * amount
    lit.data.foreach_set("color", rgba.ravel())


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
    world = build_geometry()
    setup_lighting()
    if PREVIEW:
        render_previews()
        return
    scenery = separate(world, {VERTEX_LIT, BACKDROP}, "Scenery")
    world.name = "Arena"
    world.data.materials[0] = shared_material("Arena")
    lightmap_uvs(world)
    save_lightmap(bake_lightmap(world, ARENA_LIGHTMAP_SIZE), "arena-light.webp")
    bake_vertex_light(scenery)
    backdrop = separate(scenery, {BACKDROP}, "Backdrop")
    haze(backdrop)
    for obj in (world, scenery, backdrop):
        obj.data.attributes.remove(obj.data.attributes["lighting"])
    export_glb("map.glb", [world, scenery, backdrop], normals=False, texcoords=True)


def render_previews():
    scene = bpy.context.scene
    material = bpy.data.materials["Map"]
    nodes = material.node_tree.nodes
    color = nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Color"
    material.node_tree.links.new(color.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
    camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.clip_end = 5000
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    views = (
        ("map_overview", (-95, 80, 95), (0, 0, 0), 18),
        ("map_square", (-24, 1.6, 14), (0, 5, 0), 18),
        ("map_stupa", (24, 1.6, -38), (42, 6, -42), 18),
        ("map_street", (0, 1.6, -62), (0, 3, -20), 18),
        ("map_ruins", (-26, 1.6, 30), (-46, 5, 44), 18),
        ("map_camp", (-24, 1.6, -40), (-50, 1, -50), 18),
        ("map_north", (0, 12, 40), (0, 30, -400), 30),
    )
    for name, position, target, lens in views:
        camera.data.lens = lens
        eye = game_to_blender(position)
        look = game_to_blender(target)
        camera.matrix_world = Matrix.Translation(eye) @ (look - eye).to_track_quat("-Z", "Y").to_matrix().to_4x4()
        scene.render.filepath = os.path.join(OUT_DIR, "preview", name + ".png")
        bpy.ops.render.render(write_still=True)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 160
    camera.matrix_world = Matrix.Translation(game_to_blender((0, 150, 0))) @ Matrix.Rotation(0, 4, "Z")
    scene.render.resolution_x = scene.render.resolution_y = 1400
    scene.render.filepath = os.path.join(OUT_DIR, "preview", "map_top.png")
    bpy.ops.render.render(write_still=True)


main()
