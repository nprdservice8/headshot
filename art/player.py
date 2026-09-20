"""Builds everything a player carries: the two characters with their animations and rifle, the
first-person arms and weapons, and the grenade. Writes character.glb, viewmodel.glb and
grenade.glb to art/out/.

The characters are two adversaries of the 1814 war dressed from the same modular body: the King
(you) after the portrait of Girvan Yuddha Bikram Shah, and the General (everyone else) after Sir
David Ochterlony. Both share one skeleton and one set of animations.

Sources (CC0, Quaternius): Swat.gltf (rig and animations) and Suit.gltf (body parts) from
Ultimate Modular Men, AssaultRifle2_1.blend and SubmachineGun_2.blend from the Ultimate Gun Pack,
Grenade.gltf and RocketLauncher.gltf from the Toon Shooter Game Kit."""

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
    base_name,
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

# Linear RGB albedos, like the packs' material colours. Real-world values, since the sun and sky
# lights blow anything lighter out to white.
SILK_BLUE = (0.18, 0.32, 0.6, 1)
CREAM = (0.55, 0.42, 0.2, 1)
PEARL = (0.85, 0.85, 0.82, 1)
WHITE = (0.7, 0.7, 0.7, 1)
GOLD = (0.5, 0.27, 0.03, 1)
EMERALD = (0.05, 0.45, 0.15, 1)
SCARLET = (0.55, 0.03, 0.03, 1)
NAVY = (0.02, 0.03, 0.1, 1)
BLACK = (0.02, 0.02, 0.02, 1)
DARK_HAIR = (0.03, 0.02, 0.015, 1)
WHITE_HAIR = (0.5, 0.5, 0.48, 1)
GREY = (0.4, 0.4, 0.4, 1)
NEPALI_SKIN = (0.2, 0.11, 0.06, 1)
BRITISH_SKIN = (0.36, 0.23, 0.18, 1)
# Sleeve faces further out along the arm than this (metres from the spine, in the T-pose) are
# the cuffs, which both uniforms trim in gold.
CUFF_FROM_X = 0.49

FORWARD = Vector((0, -1, 0))  # the imported soldier faces -Y
UP = Vector((0, 0, 1))
RIGHT = Vector((-1, 0, 0))

# Points on the rifle after scaling, with its grip at the origin and the barrel along -Y.
RIFLE_HANDGUARD = Vector((0, -0.22, 0.075))
RIFLE_MUZZLE = Vector((0, -0.585, 0.1035))
RIFLE_BUTT = Vector((0, 0.2535, 0.057))
# Where the reflex sight's mount stands on the top rail. Its dot sits REFLEX_HEIGHT above, high
# enough that the pack's front post hides behind the ring's rim when aiming.
RIFLE_REFLEX = Vector((0, -0.12, 0.132))

# The SMG and bazooka share the rifle's grip-at-origin, barrel-along--Y convention and ride its
# hand pose rather than getting their own IK, which is close enough for a held prop.
# The gun pack's SMG has the same grip origin and unit scale as its rifle; the support hand
# holds the front of its receiver, just ahead of the magazine.
SMG_SCALE = RIFLE_SCALE
SMG_MUZZLE = Vector((0, -0.365, 0.092))
SMG_HANDGUARD = Vector((0, -0.2, 0.06))
SMG_REFLEX = Vector((0, -0.1, 0.147))
# The toon kit's launcher is fat and comes in metres with its grip 13 cm ahead of the origin;
# it's shrunk to a shoulder-sized tube, then shifted so the grip lands in the hand and the
# support hand cups the tube's underside.
BAZOOKA_SCALE = 0.5
BAZOOKA_OFFSET = Vector((0, 0.065, -0.05))
BAZOOKA_MUZZLE = Vector((0, -0.325, 0.134))
BAZOOKA_HANDGUARD = Vector((0, -0.16, 0.01))

# The reflex sight both guns carry: a ring standing on a post, with a dot floating at its centre.
# The dot is its own material so the game can draw it unlit; the eye looks through the ring's
# centre when aiming (client/render.ts lines the `Sight` point up on the camera's axis).
REFLEX_HEIGHT = 0.075
REFLEX_RING_RADIUS = 0.04
REFLEX_RING_SECTION = 0.005
REFLEX_RING_DEPTH = 0.016
REFLEX_POST_HALF_WIDTH = 0.01
REFLEX_POST_HALF_LENGTH = 0.016
REFLEX_DOT_RADIUS = 0.004
REFLEX_COLOR = (0.05, 0.05, 0.06, 1)
REFLEX_DOT_COLOR = (1, 0.04, 0.04, 1)

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
# First-person grip positions relative to the eye (right, forward, up). The launcher's grip is
# mid-tube, so it's held further out to keep its rear end clear of the camera.
VIEW_GRIP_OFFSET = (0.17, 0.36, -0.25)
VIEW_BAZOOKA_GRIP_OFFSET = (0.18, 0.4, -0.27)
VIEW_YAW_DEG = 5
VIEW_FOV_DEG = 60
# Must match VIEWMODEL_SIGHT_DISTANCE in client/render.ts: how far ahead of the eye the rear sight
# sits when aiming, so the preview shows the sight picture the game will.
VIEW_SIGHT_DISTANCE = 0.22
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


def sight_frame(rear, front):
    """A frame at `rear` whose +Y looks along the sight line to `front` and whose +Z is the gun's
    up: a camera pose that sees the sights lined up, which the exporter turns into three.js
    camera space (forward -Z, up +Y) like everything else in the viewmodel."""
    forward = (front - rear).normalized()
    up = (UP - UP.dot(forward) * forward).normalized()
    right = forward.cross(up)
    return Matrix(
        (
            (right.x, forward.x, up.x, rear.x),
            (right.y, forward.y, up.y, rear.y),
            (right.z, forward.z, up.z, rear.z),
            (0, 0, 0, 1),
        )
    )


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


def _colored_object(name, verts, faces, color, bone=None):
    """A standalone mesh object from raw geometry, built without bpy.ops so it works the same in
    background mode, weighted entirely to `bone` (if given) so it rides along once joined into a
    character. Normals are recalculated rather than trusted, since the winding above is whatever
    was convenient to write."""
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
    if bone:
        obj.vertex_groups.new(name=bone).add(list(range(len(verts))), 1.0, "REPLACE")
    return obj


def _lathe(name, center, profile, color, bone, sides=12, closed=False):
    """A surface of revolution about the vertical axis through `center`. `profile` lists
    (radius, height) pairs from bottom to top; the ends are capped unless the profile is a
    `closed` loop (a ring)."""
    cx, cy, cz = center
    ring = [(math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    verts = [(cx + c * r, cy + s * r, cz + h) for r, h in profile for c, s in ring]
    count = len(profile)
    faces = []
    for i in range(count if closed else count - 1):
        j = (i + 1) % count
        for k in range(sides):
            faces.append((i * sides + k, i * sides + (k + 1) % sides, j * sides + (k + 1) % sides, j * sides + k))
    if not closed:
        faces.append(tuple(range(sides)))
        faces.append(tuple(range(count * sides - 1, (count - 1) * sides - 1, -1)))
    return _colored_object(name, verts, faces, color, bone)


def _ring(name, center, radius, thickness, color, bone):
    profile = [
        (radius + thickness * math.cos(t), thickness * math.sin(t))
        for t in (2 * math.pi * k / 6 for k in range(6))
    ]
    return _lathe(name, center, profile, color, bone, sides=16, closed=True)


def _tube(name, start, end, color, bone, radius, radius_end=None, flat=1.0, flat_axis=None, sides=8):
    """A tube from `start` to `end`, tapering to `radius_end`. `flat` squashes its section to that
    fraction along `flat_axis`, which makes a strip lying against a surface with that normal."""
    start, end = Vector(start), Vector(end)
    axis = (end - start).normalized()
    across = (flat_axis or UP).cross(axis)
    if across.length < 1e-3:
        across = RIGHT.cross(axis)
    across.normalize()
    thin = axis.cross(across)
    verts = []
    for point, r in ((start, radius), (end, radius if radius_end is None else radius_end)):
        for k in range(sides):
            a = 2 * math.pi * k / sides
            verts.append(tuple(point + across * (math.cos(a) * r) + thin * (math.sin(a) * r * flat)))
    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
    faces.append(tuple(range(sides)))
    faces.append(tuple(range(2 * sides - 1, sides - 1, -1)))
    return _colored_object(name, verts, faces, color, bone)


def paint_faces(obj, color, indices):
    """Recolours the given faces of a flattened mesh."""
    colors = obj.data.color_attributes["Color"]
    for index in indices:
        for loop_index in obj.data.polygons[index].loop_indices:
            colors.data[loop_index].color = color


def cuff_faces(body):
    """The coat's sleeve faces out at the wrists, found before flattening loses the materials."""
    materials = [base_name(m) for m in body.data.materials]
    return [
        p.index
        for p in body.data.polygons
        if materials[p.material_index] == "Suit" and abs(p.center.x) > CUFF_FROM_X
    ]


def import_rig():
    """The pack's shared skeleton with its animations. The SWAT's clothes come along but are the
    wrong century, so only the armature is kept."""
    objects = import_gltf("Swat.gltf")
    armature = next(o for o in objects if o.type == "ARMATURE")
    for obj in objects:
        if obj.type == "MESH":
            bpy.data.objects.remove(obj)
    return armature


def import_body_parts(armature):
    """The Suit's head, coat, trousers and shoes, rehomed onto the shared rig. The importer brings
    a second copy of the rig and its animations; the rig copy goes now and keep_clips drops the
    duplicate actions later."""
    objects = import_gltf("Suit.gltf")
    wanted = [o for o in objects if o.type == "MESH" and o.parent and not o.name.startswith("Pistol")]
    parts = {}
    for obj in wanted:
        parts[obj.name.split("_")[1].split(".")[0]] = obj
        obj.parent = armature
        for modifier in obj.modifiers:
            if modifier.type == "ARMATURE":
                modifier.object = armature
    for obj in objects:
        if obj not in wanted:
            bpy.data.objects.remove(obj)
    return parts


def copy_parts(parts):
    copies = {}
    for name, part in parts.items():
        copy = part.copy()
        copy.data = part.data.copy()
        bpy.context.scene.collection.objects.link(copy)
        copies[name] = copy
    return copies


def dress(name, parts, palettes, accessories):
    """One look: each body part recoloured from its palette (material name to colour), gold cuffs,
    plus accessories, all joined into a single skinned mesh."""
    meshes = []
    cuffs = cuff_faces(parts["Body"])
    for part_name, part in parts.items():
        palette = palettes[part_name]
        flatten_materials(part, color_override=lambda material, palette=palette: palette.get(material))
        meshes.append(part)
    paint_faces(parts["Body"], GOLD, cuffs)
    for accessory in accessories:
        flatten_materials(accessory)
        meshes.append(accessory)
    look = join(meshes)
    look.name = name
    return look


def build_king(parts):
    """After the c. 1815 portrait: pale blue silk robe with a gold sash and pearls, a white
    jewelled headdress with a tall plume, dark hair."""
    # The band sits just above the brow: the eyes are at about z 1.7 and must stay uncovered.
    crown = Vector((0, -0.045, 1.735))
    accessories = [
        _lathe(
            "Cap",
            crown,
            [(0.145, 0), (0.16, 0.045), (0.16, 0.1), (0.135, 0.16), (0.085, 0.21), (0.005, 0.24)],
            WHITE,
            "Head",
            sides=14,
        ),
        _lathe("Band", crown - UP * 0.005, [(0.155, 0), (0.155, 0.035)], GOLD, "Head", sides=14),
        _tube("Plume", (0, -0.13, 1.94), (0.03, -0.03, 2.24), WHITE, "Head", 0.035, 0.008),
        _ring("Necklace", (0, -0.06, 1.48), 0.11, 0.018, PEARL, "Chest"),
        _ring("Necklace2", (0, -0.07, 1.43), 0.13, 0.014, PEARL, "Chest"),
        _tube("Sash", (0.1, -0.205, 1.47), (-0.12, -0.175, 1.12), CREAM, "Chest", 0.04, flat=0.25, flat_axis=FORWARD),
    ]
    for i, x in enumerate((-0.055, 0, 0.055)):
        profile = [(0.012, 0), (0.017, 0.012), (0.012, 0.024)]
        color = EMERALD if i == 1 else PEARL
        accessories.append(_lathe(f"Gem{i}", (x, crown.y - 0.15, crown.z + 0.004), profile, color, "Head"))
    return dress(
        "King",
        parts,
        {
            "Head": {"Skin": NEPALI_SKIN, "Hair": DARK_HAIR, "Eyebrows": DARK_HAIR},
            "Body": {"Skin": NEPALI_SKIN, "Suit": SILK_BLUE, "White": CREAM, "Tie": PEARL},
            "Legs": {"Suit": WHITE},
            "Feet": {"Black": GOLD},
        },
        accessories,
    )


def build_general(parts):
    """After the engraving: scarlet coat with gold epaulettes and chest cords over a sash, white
    cravat and breeches, black boots, white curls."""
    accessories = [
        _tube("Cord", (-0.13, -0.13, 1.46), (0.0, -0.2, 1.3), GOLD, "Chest", 0.008),
        _tube("Cord2", (-0.15, -0.14, 1.44), (-0.02, -0.2, 1.24), GOLD, "Chest", 0.008),
        _tube("Sash", (0.1, -0.205, 1.47), (-0.12, -0.175, 1.12), PEARL, "Chest", 0.045, flat=0.25, flat_axis=FORWARD),
    ]
    for side, x in (("L", 0.15), ("R", -0.15)):
        profile = [(0.05, 0), (0.058, 0.015), (0.045, 0.03)]
        accessories.append(_lathe(f"Epaulette.{side}", (x, -0.06, 1.465), profile, GOLD, f"Shoulder.{side}"))
    return dress(
        "General",
        parts,
        {
            "Head": {"Skin": BRITISH_SKIN, "Hair": WHITE_HAIR, "Eyebrows": GREY},
            "Body": {"Skin": BRITISH_SKIN, "Suit": SCARLET, "White": WHITE, "Tie": NAVY},
            "Legs": {"Suit": WHITE},
            "Feet": {"Black": BLACK},
        },
        accessories,
    )


def build_characters():
    """The shared rig with the King and the General skinned to it."""
    armature = import_rig()
    parts = import_body_parts(armature)
    king = build_king(copy_parts(parts))
    general = build_general(parts)
    return armature, king, general


def build_gun(file_name, name, scale, yaw_deg, offset=Vector()):
    """A gun from the packs, scaled to metres with its grip at the origin and barrel along -Y."""
    load = append_objects if file_name.endswith(".blend") else import_gltf
    gun = load(file_name)[0]
    gun.name = name
    flatten_materials(gun)
    # Composed onto the import's own transform: glTF files arrive with a node scale and rotation.
    gun.matrix_world = (
        Matrix.Translation(offset)
        @ Matrix.Rotation(math.radians(yaw_deg), 4, "Z")
        @ Matrix.Scale(scale, 4)
        @ gun.matrix_world
    )
    apply_transform(gun)
    return gun


def build_rifle():
    rifle = build_gun("AssaultRifle2_1.blend", "Rifle", RIFLE_SCALE, -90)
    return mount_reflex_sight(rifle, RIFLE_REFLEX)


def build_smg():
    smg = build_gun("SubmachineGun_2.blend", "Smg", SMG_SCALE, -90)
    return mount_reflex_sight(smg, SMG_REFLEX)


def reflex_centre(mount):
    """The middle of the ring, where the dot floats and the eye looks through."""
    return mount + UP * REFLEX_HEIGHT


def reflex_sight_line(mount):
    centre = reflex_centre(mount)
    return centre, centre + FORWARD


def mount_reflex_sight(gun, mount):
    """Joins the sight's post and ring onto a gun (grip at the origin, barrel along -Y)."""
    cx, cy, cz = reflex_centre(mount)
    hw, hl = REFLEX_POST_HALF_WIDTH, REFLEX_POST_HALF_LENGTH
    top = cz - REFLEX_RING_RADIUS
    post = _colored_object(
        "ReflexPost",
        [(cx + x, cy + y, z) for z in (mount.z, top) for x, y in ((-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl))],
        [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
        REFLEX_COLOR,
    )
    sides = 16
    inner = REFLEX_RING_RADIUS - REFLEX_RING_SECTION
    outer = REFLEX_RING_RADIUS + REFLEX_RING_SECTION
    front, back = cy - REFLEX_RING_DEPTH / 2, cy + REFLEX_RING_DEPTH / 2
    verts = []
    for k in range(sides):
        c, s = math.cos(2 * math.pi * k / sides), math.sin(2 * math.pi * k / sides)
        for r, y in ((inner, front), (outer, front), (outer, back), (inner, back)):
            verts.append((cx + c * r, y, cz + s * r))
    faces = []
    for k in range(sides):
        a, b = k * 4, ((k + 1) % sides) * 4
        for i, j in ((0, 1), (1, 2), (2, 3), (3, 0)):
            faces.append((a + i, a + j, b + j, b + i))
    ring = _colored_object("ReflexRing", verts, faces, REFLEX_COLOR)
    for part in (post, ring):
        flatten_materials(part)
    return join([gun, post, ring])


def reflex_dot(name, frame, mount):
    """The dot at the ring's centre, in its own material group so the game draws it unlit."""
    cx, cy, cz = reflex_centre(mount)
    sides = 8
    verts = [
        (cx + math.cos(2 * math.pi * k / sides) * REFLEX_DOT_RADIUS, cy, cz + math.sin(2 * math.pi * k / sides) * REFLEX_DOT_RADIUS)
        for k in range(sides)
    ]
    dot = _colored_object(name, verts, [tuple(range(sides))], REFLEX_DOT_COLOR)
    flatten_materials(dot, group_of=lambda _name: "Dot")
    dot.matrix_world = frame
    return dot


def build_bazooka():
    return build_gun("RocketLauncher.gltf", "Bazooka", BAZOOKA_SCALE, 90, BAZOOKA_OFFSET)


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


def pose_hands(armature, frame, handguard):
    """Both hands on a gun held at `frame`: the right on its grip, the left under `handguard`."""
    bones = armature.pose.bones
    solve_arm(
        armature,
        "R",
        frame @ WRIST_IN_GRIP,
        bones["UpperArm.R"].head + Vector((-0.4, 0.1, -0.4)),
    )
    solve_arm(
        armature,
        "L",
        left_wrist_on(frame @ handguard),
        bones["UpperArm.L"].head + Vector((0.35, -0.1, -0.4)),
    )


def build_viewmodel(armature, soldier, rifle):
    """The first-person arms and weapons. Each weapon gets its own hand pose and so its own copy
    of the arms; the client shows one weapon and its arms at a time. Each also gets a muzzle
    empty and, if it has sights, a sight empty, for the client to line things up on."""
    eye = eye_matrix(armature).translation
    bones = armature.pose.bones
    for side, shift in VIEW_SHOULDER_SHIFT.items():
        shoulder = bones[f"Shoulder.{side}"]
        shoulder.matrix = Matrix.Translation(shift) @ shoulder.matrix
        update()

    # The launcher has no sight: aiming it only narrows the view.
    weapons = [
        ("Rifle", rifle, VIEW_GRIP_OFFSET, RIFLE_HANDGUARD, RIFLE_MUZZLE, RIFLE_REFLEX),
        ("Smg", build_smg(), VIEW_GRIP_OFFSET, SMG_HANDGUARD, SMG_MUZZLE, SMG_REFLEX),
        ("Bazooka", build_bazooka(), VIEW_BAZOOKA_GRIP_OFFSET, BAZOOKA_HANDGUARD, BAZOOKA_MUZZLE, None),
    ]
    arms = []
    view_weapons = []
    points = []
    for name, source, grip_offset, handguard, muzzle_point, reflex in weapons:
        right, forward, up = grip_offset
        grip = eye + RIGHT * right + FORWARD * forward + UP * up
        frame = Matrix.Translation(grip) @ Matrix.Rotation(math.radians(VIEW_YAW_DEG), 4, "Z")
        pose_hands(armature, frame, handguard)
        weapon_arms = extract_arms(soldier)
        weapon_arms.name = f"Arms{name}"
        arms.append(weapon_arms)
        view_weapon = source.copy()
        view_weapon.data = source.data.copy()
        view_weapon.parent = None
        bpy.context.scene.collection.objects.link(view_weapon)
        view_weapon.name = f"View{name}"
        view_weapon.matrix_world = frame
        if reflex is not None:
            view_weapon = join([view_weapon, reflex_dot(f"Dot{name}", frame, reflex)])
        view_weapons.append(view_weapon)
        # The rifle source is still needed for the third-person soldier; the others are not.
        if source is not rifle:
            bpy.data.objects.remove(source)
        points.append(empty(f"Muzzle{name}", frame @ Matrix.Translation(muzzle_point)))
        if reflex is not None:
            points.append(empty(f"Sight{name}", frame @ sight_frame(*reflex_sight_line(reflex))))

    # Camera space: the eye at the origin, forward along +Y and up along +Z, which the glTF
    # exporter turns into three.js camera space (forward -Z, up +Y).
    to_camera = Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation(-eye)
    for obj in (*arms, *view_weapons, *points):
        obj.matrix_world = to_camera @ obj.matrix_world
    for obj in (*arms, *view_weapons):
        apply_transform(obj)
    return arms, view_weapons, points


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


def export_character(armature, looks, rifle, rifle_frame):
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
    export_glb("character.glb", [root, armature, *looks, rifle, muzzle], animations=True)
    armature.parent = None
    bpy.data.objects.remove(root)
    update()


def main():
    reset_scene()
    bpy.context.scene.render.fps = ANIMATION_FPS
    armature, king, general = build_characters()
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
        for look, other in ((king, general), (general, king)):
            other.hide_render = True
            look.hide_render = False
            name = look.name.lower()
            render_preview(f"{name}_side", camera_looking(Vector((-2.2, -0.4, 1.4)), target), lens=35)
            render_preview(f"{name}_front", camera_looking(Vector((-0.8, -2.2, 1.5)), target), lens=35)
            render_preview(f"{name}_back", camera_looking(Vector((0.9, 1.8, 1.9)), target), lens=35)

    # The viewmodel comes first: exporting animations leaves the armature in some other pose.
    arms, view_weapons, points = build_viewmodel(armature, king, rifle)
    if PREVIEW:
        king.hide_render = True
        general.hide_render = True
        rifle.hide_render = True
        eye_camera = Matrix.Rotation(math.radians(90), 4, "X")
        sights = {obj.name: obj for obj in points if obj.name.startswith("Sight")}
        for shown_arms, shown_weapon in zip(arms, view_weapons):
            for obj in (*arms, *view_weapons):
                obj.hide_render = obj not in (shown_arms, shown_weapon)
            name = shown_weapon.name[len("View") :]
            render_preview(f"viewmodel_{name.lower()}", eye_camera, lens=VIEW_FOV_DEG)
            sight = sights.get(f"Sight{name}")
            if sight is None:
                continue
            # The eye behind the rear sight, looking along the sight line: what aiming shows.
            aim_camera = (
                sight.matrix_world @ Matrix.Translation((0, -VIEW_SIGHT_DISTANCE, 0)) @ eye_camera
            )
            render_preview(f"viewmodel_{name.lower()}_ads", aim_camera, lens=VIEW_FOV_DEG)
        return
    export_glb("viewmodel.glb", [*arms, *view_weapons, *points])
    for obj in (*arms, *view_weapons, *points):
        bpy.data.objects.remove(obj)
    export_character(armature, [king, general], rifle, rifle_frame)
    export_glb("grenade.glb", [build_grenade()])


main()
