"""Builds everything a player carries: the soldier with its animations and rifle, the first-person
arms and rifle, and the grenade. Writes character.glb, viewmodel.glb and grenade.glb to art/out/.

Sources (CC0, Quaternius): Swat.gltf from Ultimate Modular Men, AssaultRifle2_1.blend from the
Ultimate Gun Pack, Grenade.gltf from the Toon Shooter Game Kit."""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    OUT_DIR,
    append_objects,
    apply_transform,
    bounds,
    export_glb,
    flatten_materials,
    import_gltf,
    join,
    look_rotation,
    reset_scene,
)

PREVIEW = "--preview" in sys.argv

# The soldier's head centre ends up at the hitbox's HEAD_CENTER_Y (1.6 m).
SOLDIER_SCALE = 0.965
RIFLE_SCALE = 0.84 / 5.169
GRENADE_SIZE = 0.2
ANIMATION_FPS = 30

FORWARD = Vector((0, -1, 0))  # the imported soldier faces -Y
UP = Vector((0, 0, 1))
RIGHT = Vector((-1, 0, 0))

# Points on the rifle after scaling, with its grip at the origin and the barrel along -Y.
RIFLE_HANDGUARD = Vector((0, -0.22, 0.075))
RIFLE_MUZZLE = Vector((0, -0.585, 0.1035))
RIFLE_BUTT = Vector((0, 0.2535, 0.057))

# The SMG and bazooka are built procedurally (no CC0 source model for either), in the same
# grip-at-origin, barrel-along-Y convention as the rifle. Muzzle only: they ride the rifle's
# grip pose rather than getting their own hand IK, which is close enough for a held prop.
GUNMETAL = (0.05, 0.05, 0.055, 1)
OLIVE_DRAB = (0.14, 0.17, 0.1, 1)
MATTE_BLACK = (0.02, 0.02, 0.02, 1)
SMG_MUZZLE = Vector((0, -0.34, 0.05))
BAZOOKA_MUZZLE = Vector((0, -0.75, 0))

# Where the right wrist sits relative to a grip, measured from the pack's pistol pose.
WRIST_IN_GRIP = Matrix(
    (
        (-0.176, -0.021, -0.984, -0.016),
        (0.045, -0.999, 0.014, 0.15),
        (-0.983, -0.042, 0.177, 0.031),
        (0, 0, 0, 1),
    )
)

AIM_TWIST_DEG = -28
# Third-person rifle butt, relative to the right shoulder once the chest has twisted.
AIM_BUTT_OFFSET = Vector((0.04, -0.06, 0.03))
# First-person rifle grip, relative to the eye (right, forward, up).
VIEW_GRIP_OFFSET = (0.17, 0.36, -0.25)
VIEW_YAW_DEG = 5
VIEW_FOV_DEG = 60
# The first-person arms have no body, so their shoulders move forward to reach the rifle.
VIEW_SHOULDER_SHIFT = {"R": Vector((0, -0.1, -0.05)), "L": Vector((-0.08, -0.2, -0.2))}
EYE_OFFSET = Vector((0, -0.09, 0.08))

UPPER_BODY_ROOTS = ("Torso",)
ARM_BONE_PREFIXES = ("UpperArm", "LowerArm", "Wrist", "Index", "Middle", "Ring", "Pinky", "Thumb")
CLIPS = {
    "Idle_Gun_Pointing": "Idle",
    "Run": "RunForward",
    "Run_Back": "RunBack",
    "Run_Left": "RunLeft",
    "Run_Right": "RunRight",
}


def update():
    bpy.context.view_layer.update()


def descendants(bone):
    result = [bone]
    for child in bone.children:
        result.extend(descendants(child))
    return result


def rotate_about(point, axis, degrees):
    return (
        Matrix.Translation(point)
        @ Matrix.Rotation(math.radians(degrees), 4, axis)
        @ Matrix.Translation(-point)
    )


def empty(name, matrix):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = matrix
    return obj


def solve_arm(armature, side, wrist_matrix, pole_location):
    """Places the wrist with two-bone IK, then keeps the result as a plain pose."""
    target = empty(f"IKTarget.{side}", wrist_matrix)
    pole = empty(f"IKPole.{side}", Matrix.Translation(pole_location))
    lower = armature.pose.bones[f"LowerArm.{side}"]
    wrist = armature.pose.bones[f"Wrist.{side}"]
    ik = lower.constraints.new("IK")
    ik.target = target
    ik.pole_target = pole
    ik.pole_angle = math.radians(-90)
    ik.chain_count = 2
    rotation = wrist.constraints.new("COPY_ROTATION")
    rotation.target = target
    update()
    names = [f"UpperArm.{side}", f"LowerArm.{side}", f"Wrist.{side}"]
    solved = {name: armature.pose.bones[name].matrix.copy() for name in names}
    lower.constraints.remove(ik)
    wrist.constraints.remove(rotation)
    for name in names:
        armature.pose.bones[name].matrix = solved[name]
        update()
    reached = (armature.pose.bones[f"Wrist.{side}"].head - wrist_matrix.translation).length
    print(f"IK {side}: wrist is {reached * 100:.1f} cm from its target")
    bpy.data.objects.remove(target)
    bpy.data.objects.remove(pole)


def left_wrist_on(handguard):
    """The support hand under the handguard: palm up, fingers wrapping round from the left."""
    fingers = Vector((-1, -0.35, 0.25)).normalized()
    palm = UP
    rotation = look_rotation(fingers, -palm)
    # look_rotation keeps +Z near its `up`; the left wrist's palm faces its -Z.
    return Matrix.Translation(handguard - UP * 0.045 - fingers * 0.07) @ rotation


def mirror_fingers(armature):
    for bone in armature.pose.bones:
        if not bone.name.endswith(".R") or not bone.name.startswith(ARM_BONE_PREFIXES[3:]):
            continue
        left = armature.pose.bones[bone.name[:-2] + ".L"]
        w, x, y, z = bone.rotation_quaternion
        left.rotation_quaternion = (w, x, -y, -z)
    update()


def build_soldier():
    objects = import_gltf("Swat.gltf")
    armature = next(o for o in objects if o.type == "ARMATURE")
    meshes = [o for o in objects if o.parent == armature and o.name != "Pistol"]
    # The importer also brings in the pistol and a bone-display sphere, neither of which we want.
    for obj in objects:
        if obj.type == "MESH" and obj not in meshes:
            bpy.data.objects.remove(obj)
    for mesh in meshes:
        # "Swat" is the uniform colour: white in the vertex colours, tinted per player at runtime.
        flatten_materials(
            mesh,
            color_override=lambda name: (1, 1, 1, 1) if name == "Swat" else None,
            group_of=lambda name: "Team" if name == "Swat" else "Body",
        )
    soldier = join(meshes)
    soldier.name = "Soldier"
    return armature, soldier


def build_rifle():
    rifle = append_objects("AssaultRifle2_1.blend")[0]
    rifle.name = "Rifle"
    flatten_materials(rifle)
    rifle.scale = (RIFLE_SCALE,) * 3
    rifle.rotation_euler = (0, 0, math.radians(-90))
    apply_transform(rifle)
    return rifle


def _colored_object(name, verts, faces, color):
    """A standalone mesh object from raw geometry, built without bpy.ops so it works the same in
    background mode. Normals are recalculated rather than trusted, since face winding above is
    whatever was convenient to write, not guaranteed outward."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    edit = bmesh.new()
    edit.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(edit, faces=edit.faces)
    edit.to_mesh(mesh)
    edit.free()
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _box(name, center, half, color):
    cx, cy, cz = center
    hx, hy, hz = half
    verts = [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return _colored_object(name, verts, faces, color)


def _tube(name, base_y, tip_y, radius, color, radius_tip=None, sides=10):
    """A cylinder (a frustum, when `radius_tip` differs) running along Y from `base_y` to `tip_y`."""
    radius_tip = radius if radius_tip is None else radius_tip
    ring = [(math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    verts = [(c * radius, base_y, s * radius) for c, s in ring]
    verts += [(c * radius_tip, tip_y, s * radius_tip) for c, s in ring]
    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
    faces.append(tuple(range(sides)))
    faces.append(tuple(range(2 * sides - 1, sides - 1, -1)))
    return _colored_object(name, verts, faces, color)


def build_smg():
    """No CC0 source for an SMG, so it's a handful of boxes: a short, blocky compact gun."""
    parts = [
        _box("SmgReceiver", (0, -0.04, 0.05), (0.0275, 0.15, 0.0375), GUNMETAL),
        _tube("SmgBarrel", -0.19, -0.34, 0.016, GUNMETAL),
        _box("SmgStock", (0, 0.155, 0.05), (0.015, 0.045, 0.015), GUNMETAL),
        _box("SmgMag", (0, -0.05, -0.09), (0.015, 0.045, 0.07), MATTE_BLACK),
        _box("SmgGrip", (0, 0.02, -0.07), (0.014, 0.025, 0.06), MATTE_BLACK),
    ]
    smg = join(parts)
    smg.name = "Smg"
    flatten_materials(smg)
    return smg


def build_bazooka():
    """A real bazooka silhouette: a long tube with a flared rear vent, sights, and two grips."""
    parts = [
        _tube("BazookaTube", -0.7, 0.3, 0.055, OLIVE_DRAB),
        _tube("BazookaFlare", 0.3, 0.45, 0.055, GUNMETAL, radius_tip=0.085),
        _box("BazookaFrontSight", (0, -0.45, 0.09), (0.01, 0.025, 0.025), MATTE_BLACK),
        _box("BazookaRearSight", (0, -0.05, 0.075), (0.009, 0.015, 0.02), MATTE_BLACK),
        _box("BazookaFrontGrip", (0, -0.15, -0.1), (0.015, 0.025, 0.045), MATTE_BLACK),
        _box("BazookaGrip", (0, 0.02, -0.09), (0.015, 0.025, 0.065), MATTE_BLACK),
    ]
    bazooka = join(parts)
    bazooka.name = "Bazooka"
    flatten_materials(bazooka)
    return bazooka


def freeze_pose(armature, action_name, frame):
    """Copies an animation frame into the pose so it can be edited without the action."""
    action = bpy.data.actions[action_name]
    armature.animation_data.action = action
    armature.animation_data.action_slot = action.slots[0]
    bpy.context.scene.frame_set(frame)
    basis = {b.name: b.matrix_basis.copy() for b in armature.pose.bones}
    armature.animation_data.action = None
    for bone in armature.pose.bones:
        bone.matrix_basis = basis[bone.name]
    update()


def pose_aim(armature, rifle):
    freeze_pose(armature, "Idle_Gun_Pointing", 10)
    bones = armature.pose.bones
    torso = bones["Torso"]
    torso.matrix = rotate_about(torso.head, UP, AIM_TWIST_DEG) @ torso.matrix
    update()
    neck = bones["Neck"]
    neck.matrix = rotate_about(neck.head, UP, -AIM_TWIST_DEG) @ neck.matrix
    update()

    butt = bones["UpperArm.R"].head + AIM_BUTT_OFFSET
    grip = butt - RIFLE_BUTT
    rifle_frame = Matrix.Translation(grip)
    solve_arm(
        armature,
        "R",
        rifle_frame @ WRIST_IN_GRIP,
        bones["UpperArm.R"].head + Vector((-0.35, 0.15, -0.45)),
    )
    solve_arm(
        armature,
        "L",
        left_wrist_on(grip + RIFLE_HANDGUARD),
        bones["UpperArm.L"].head + Vector((0.3, -0.1, -0.45)),
    )
    mirror_fingers(armature)
    return rifle_frame


def key_aim_action(armature):
    action = bpy.data.actions.new("Aim")
    armature.animation_data.action = action
    upper = descendants(armature.data.bones[UPPER_BODY_ROOTS[0]])
    for bone in upper:
        armature.pose.bones[bone.name].keyframe_insert("rotation_quaternion", frame=0)
        armature.pose.bones[bone.name].keyframe_insert("location", frame=0)
    armature.animation_data.action = None


def eye_matrix(armature):
    head = armature.pose.bones["Head"].head
    return Matrix.Translation(head + EYE_OFFSET)


def extract_arms(soldier):
    """A static copy of the posed soldier with everything but the arms deleted."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(
        soldier.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph
    )
    arms = bpy.data.objects.new("Arms", mesh)
    bpy.context.scene.collection.objects.link(arms)
    arms.matrix_world = soldier.matrix_world
    groups = {g.index: g.name for g in soldier.vertex_groups}
    keep = set()
    for vertex in soldier.data.vertices:
        if not vertex.groups:
            continue
        strongest = max(vertex.groups, key=lambda g: g.weight)
        if groups[strongest.group].startswith(ARM_BONE_PREFIXES):
            keep.add(vertex.index)
    edit = bmesh.new()
    edit.from_mesh(mesh)
    edit.verts.ensure_lookup_table()
    bmesh.ops.delete(edit, geom=[v for v in edit.verts if v.index not in keep], context="VERTS")
    edit.to_mesh(mesh)
    edit.free()
    return arms


def build_viewmodel(armature, soldier, rifle):
    eye = eye_matrix(armature).translation
    right, forward, up = VIEW_GRIP_OFFSET
    grip = eye + RIGHT * right + FORWARD * forward + UP * up
    rifle_frame = Matrix.Translation(grip) @ Matrix.Rotation(math.radians(VIEW_YAW_DEG), 4, "Z")
    bones = armature.pose.bones
    for side, shift in VIEW_SHOULDER_SHIFT.items():
        shoulder = bones[f"Shoulder.{side}"]
        shoulder.matrix = Matrix.Translation(shift) @ shoulder.matrix
        update()
    solve_arm(
        armature,
        "R",
        rifle_frame @ WRIST_IN_GRIP,
        bones["UpperArm.R"].head + Vector((-0.4, 0.1, -0.4)),
    )
    solve_arm(
        armature,
        "L",
        left_wrist_on(rifle_frame @ RIFLE_HANDGUARD),
        bones["UpperArm.L"].head + Vector((0.35, -0.1, -0.4)),
    )
    arms = extract_arms(soldier)

    # The SMG and bazooka ride the same grip pose as the rifle (see build_smg/build_bazooka):
    # one held-prop pose for all three weapons, swapped by visibility client-side.
    weapons = [
        ("ViewRifle", rifle, "MuzzleRifle", RIFLE_MUZZLE),
        ("ViewSmg", build_smg(), "MuzzleSmg", SMG_MUZZLE),
        ("ViewBazooka", build_bazooka(), "MuzzleBazooka", BAZOOKA_MUZZLE),
    ]
    view_weapons = []
    muzzles = []
    for name, source, muzzle_name, muzzle_point in weapons:
        view_weapon = source.copy()
        view_weapon.data = source.data.copy()
        view_weapon.parent = None
        bpy.context.scene.collection.objects.link(view_weapon)
        view_weapon.name = name
        view_weapon.matrix_world = rifle_frame
        view_weapons.append(view_weapon)
        muzzles.append(empty(muzzle_name, rifle_frame @ Matrix.Translation(muzzle_point)))

    # Camera space: the eye at the origin, forward along +Y and up along +Z, which the glTF
    # exporter turns into three.js camera space (forward -Z, up +Y).
    to_camera = Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation(-eye)
    for obj in (arms, *view_weapons, *muzzles):
        obj.matrix_world = to_camera @ obj.matrix_world
    apply_transform(arms)
    for view_weapon in view_weapons:
        apply_transform(view_weapon)
    return arms, view_weapons, muzzles


def build_grenade():
    objects = import_gltf("Grenade.gltf")
    grenade = objects[0]
    flatten_materials(grenade)
    lo, hi = bounds([grenade])
    grenade.scale = (GRENADE_SIZE / max(hi - lo),) * 3
    apply_transform(grenade)
    lo, hi = bounds([grenade])
    for vertex in grenade.data.vertices:
        vertex.co -= (lo + hi) / 2
    return grenade


def show_vertex_colors():
    for material in bpy.data.materials:
        material.use_nodes = True
        nodes = material.node_tree.nodes
        shader = nodes.get("Principled BSDF")
        if shader is None or nodes.get("Color Attribute"):
            continue
        attribute = nodes.new("ShaderNodeVertexColor")
        attribute.layer_name = "Color"
        material.node_tree.links.new(attribute.outputs["Color"], shader.inputs["Base Color"])


def render_preview(name, camera_matrix, lens=None, ortho=None):
    scene = bpy.context.scene
    show_vertex_colors()
    camera = bpy.data.objects.get("PreviewCamera")
    if camera is None:
        camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
        scene.collection.objects.link(camera)
        sun = bpy.data.objects.new("PreviewSun", bpy.data.lights.new("PreviewSun", "SUN"))
        sun.data.energy = 3.5
        sun.rotation_euler = (math.radians(45), math.radians(15), math.radians(-35))
        scene.collection.objects.link(sun)
        world = bpy.data.worlds.new("PreviewWorld")
        world.color = (0.45, 0.5, 0.55)
        scene.world = world
        scene.camera = camera
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x = 960
        scene.render.resolution_y = 540
    camera.matrix_world = camera_matrix
    if ortho:
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = ortho
    else:
        camera.data.type = "PERSP"
        camera.data.sensor_fit = "VERTICAL"
        camera.data.angle_y = math.radians(lens)
    scene.render.filepath = os.path.join(OUT_DIR, "preview", name + ".png")
    bpy.ops.render.render(write_still=True)


def camera_looking(position, target):
    direction = (target - position).normalized()
    return Matrix.Translation(position) @ direction.to_track_quat("-Z", "Y").to_matrix().to_4x4()


def keep_clips():
    for action in list(bpy.data.actions):
        if action.name in CLIPS:
            action.name = CLIPS[action.name]
        elif action.name != "Aim":
            bpy.data.actions.remove(action)


def export_character(armature, soldier, rifle, rifle_frame):
    muzzle = empty("Muzzle", rifle_frame @ Matrix.Translation(RIFLE_MUZZLE))
    muzzle.parent = rifle
    muzzle.matrix_world = rifle_frame @ Matrix.Translation(RIFLE_MUZZLE)
    # Turned to face -Z in three.js (yaw 0) and scaled so the head matches the head hitbox.
    root = empty("Character", Matrix())
    armature.parent = root
    root.rotation_euler = (0, 0, math.pi)
    root.scale = (SOLDIER_SCALE,) * 3
    update()
    keep_clips()
    export_glb("character.glb", [root, armature, soldier, rifle, muzzle], animations=True)
    armature.parent = None
    bpy.data.objects.remove(root)
    update()


def main():
    reset_scene()
    bpy.context.scene.render.fps = ANIMATION_FPS
    armature, soldier = build_soldier()
    rifle = build_rifle()
    rifle_frame = pose_aim(armature, rifle)
    rifle.parent = armature
    rifle.parent_type = "BONE"
    rifle.parent_bone = "Wrist.R"
    rifle.matrix_world = rifle_frame
    update()
    key_aim_action(armature)

    if PREVIEW:
        target = Vector((0, -0.2, 1.3))
        render_preview("aim_side", camera_looking(Vector((-2.2, -0.4, 1.4)), target), lens=35)
        render_preview("aim_front", camera_looking(Vector((-0.8, -2.2, 1.5)), target), lens=35)
        render_preview("aim_back", camera_looking(Vector((0.9, 1.8, 1.9)), target), lens=35)

    # The viewmodel comes first: exporting animations leaves the armature in some other pose.
    arms, view_weapons, muzzles = build_viewmodel(armature, soldier, rifle)
    if PREVIEW:
        for obj in (soldier, rifle, *view_weapons[1:]):
            obj.hide_render = True
        eye_camera = Matrix.Rotation(math.radians(90), 4, "X")
        render_preview("viewmodel", eye_camera, lens=VIEW_FOV_DEG)
        return
    export_glb("viewmodel.glb", [arms, *view_weapons, *muzzles])
    for obj in (arms, *view_weapons, *muzzles):
        bpy.data.objects.remove(obj)
    export_character(armature, soldier, rifle, rifle_frame)
    export_glb("grenade.glb", [build_grenade()])


main()
