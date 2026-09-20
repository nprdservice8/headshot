"""Helpers shared by the Blender scripts. `npm run art` runs them; see art/build.ts."""

import os

import bpy
from mathutils import Matrix, Vector

ART_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_DIR = os.path.join(ART_DIR, "source")
OUT_DIR = os.path.join(ART_DIR, "out")


def reset_scene():
    # Removes the startup cube, camera and light. read_factory_settings would be shorter, but in
    # background mode it unregisters Cycles and every bake silently does nothing.
    for collection in (bpy.data.collections, bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                       bpy.data.lights, bpy.data.cameras):
        for item in list(collection):
            collection.remove(item)
    os.makedirs(OUT_DIR, exist_ok=True)


def import_gltf(file_name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SOURCE_DIR, file_name))
    return [o for o in bpy.data.objects if o not in before]


def append_objects(file_name):
    with bpy.data.libraries.load(os.path.join(SOURCE_DIR, file_name)) as (src, dst):
        dst.objects = src.objects
    objects = [o for o in dst.objects if o is not None]
    for o in objects:
        bpy.context.scene.collection.objects.link(o)
    return objects


def base_name(material):
    # Blender suffixes duplicate names (".001") when several files use the same material name.
    return material.name.split(".")[0]


def material_color(material):
    if material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                return socket_color(node.inputs["Base Color"])
            if node.type == "BSDF_DIFFUSE":
                return socket_color(node.inputs["Color"])
    return tuple(material.diffuse_color)


def socket_color(socket):
    """The colour a shader input would show with vertex colours ignored. When a glTF ships (white)
    vertex colours, the importer multiplies them into the base colour through a Mix node, and the
    material's real colour is the Mix node's other input."""
    if not socket.is_linked:
        return tuple(socket.default_value)
    node = socket.links[0].from_node
    if node.type == "MIX":
        # The Mix node has several inputs named "A"/"B", one pair per data type.
        for other in node.inputs:
            if other.identifier in ("A_Color", "B_Color") and not other.is_linked:
                return tuple(other.default_value)
    return tuple(socket.default_value)


_shared_materials = {}


def shared_material(name):
    material = _shared_materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name)
        # The game replaces materials by name. Identical-looking materials would be merged into one
        # by glTF Transform's dedup step, so each gets its own (otherwise unused) base colour.
        shade = 1 - 0.01 * len(_shared_materials)
        material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (
            1, 1, shade, 1
        )
        _shared_materials[name] = material
    return material


def material_image(material):
    """The image a material's base colour comes from, when it is painted from a texture."""
    if not material or not material.node_tree:
        return None
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED" and node.inputs["Base Color"].is_linked:
            source = node.inputs["Base Color"].links[0].from_node
            if source.type == "TEX_IMAGE" and source.image:
                return source.image
    return None


_image_pixels = {}


def sample_image(image, u, v):
    """The linear colour of an image at a texture coordinate. Kits like Kenney's paint every face
    from a flat cell of a small palette image, so sampling one point per face is exact."""
    pixels = _image_pixels.get(image.name)
    if pixels is None:
        # Image.pixels comes back as stored: sRGB-encoded for ordinary 8-bit textures.
        pixels = (list(image.pixels), image.size[0], image.size[1])
        _image_pixels[image.name] = pixels
    data, width, height = pixels
    x = min(width - 1, max(0, int((u % 1) * width)))
    y = min(height - 1, max(0, int((v % 1) * height)))
    at = (y * width + x) * 4

    def to_linear(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (to_linear(data[at]), to_linear(data[at + 1]), to_linear(data[at + 2]), 1.0)


def flatten_materials(obj, color_override=None, group_of=None):
    """Bakes each face's material colour into a vertex colour, then replaces the materials with a
    few shared ones so the exported mesh has one primitive (one draw call) per group.

    `color_override(name)` may return a colour to store instead, and `group_of(name)` names the
    output material for a source material (default "Body"). Faces painted from a palette texture
    take the texture's colour at their centre."""
    mesh = obj.data
    # Colours the source shipped with would otherwise stay the active (exported) attribute.
    for existing in list(mesh.color_attributes):
        mesh.color_attributes.remove(existing)
    colors = mesh.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
    sources = [m for m in mesh.materials]
    uvs = mesh.uv_layers.active.data if mesh.uv_layers.active else None
    groups = []
    face_group = []
    for polygon in mesh.polygons:
        source = sources[polygon.material_index] if sources else None
        name = base_name(source) if source else ""
        image = material_image(source)
        color = color_override and color_override(name)
        if not color and image and uvs:
            u = sum(uvs[i].uv.x for i in polygon.loop_indices) / len(polygon.loop_indices)
            v = sum(uvs[i].uv.y for i in polygon.loop_indices) / len(polygon.loop_indices)
            color = sample_image(image, u, v)
        if not color:
            color = material_color(source) if source else (1, 1, 1, 1)
        for loop_index in polygon.loop_indices:
            colors.data[loop_index].color = color
        group = group_of(name) if group_of else "Body"
        if group not in groups:
            groups.append(group)
        face_group.append(groups.index(group))
    mesh.materials.clear()
    for group in groups:
        mesh.materials.append(shared_material(group))
    for polygon, index in zip(mesh.polygons, face_group):
        polygon.material_index = index
    mesh.color_attributes.active_color = colors


def join(objects):
    target = objects[0]
    with bpy.context.temp_override(
        active_object=target,
        selected_editable_objects=objects,
        selected_objects=objects,
    ):
        bpy.ops.object.join()
    return target


def apply_transform(obj):
    with bpy.context.temp_override(
        active_object=obj, selected_editable_objects=[obj], selected_objects=[obj]
    ):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def bounds(objects):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objects:
        if o.type != "MESH":
            continue
        for corner in o.bound_box:
            world = o.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, world))
            hi = Vector(map(max, hi, world))
    return lo, hi


def export_glb(file_name, objects, animations=False, normals=True, texcoords=False):
    for o in bpy.context.scene.objects:
        o.select_set(o in objects)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT_DIR, file_name),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=texcoords,
        export_normals=normals,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_animations=animations,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_nla_strips=False,
    )


def look_rotation(forward, up):
    """A rotation matrix with local +Y along `forward` and local +Z as close to `up` as possible."""
    y = forward.normalized()
    x = y.cross(up).normalized()
    z = x.cross(y).normalized()
    return Matrix((x, y, z)).transposed().to_4x4()
