"""The layout build.ts exports from src/shared/world.ts, the colours of the map, and the helpers
every dresser uses to find its way around the layout."""

import json
import os
import random

from mathutils import Quaternion

from common import OUT_DIR
from mesh import Frame

LAYOUT = json.load(open(os.path.join(OUT_DIR, "layout.json")))
HALF = LAYOUT["halfSize"]
BOXES = LAYOUT["boxes"]

# Old Kathmandu: brick and carved wood, tile roofs, whitewash and gold, with the grey and olive
# of a war laid over it.
BRICK = 0x93503a
BRICK_DARK = 0x6a3a2b
BRICK_PAVING = 0x8a5646
WOOD = 0x4a3020
WOOD_DARK = 0x2e1f15
TILE = 0x6e4032
TILE_DARK = 0x51301f
PLASTERS = (0xe2dccd, 0xd8b877, 0x9bb3c4, 0xc98f7e, 0xb9c49a, 0xe6d3a8)
METAL_ROOF = 0x7b8087
RUST = 0x7a4a30
STONE = 0x9c968a
STONE_LIGHT = 0xb8b2a4
STONE_DARK = 0x6f6a61
WHITEWASH = 0xf1eee6
SAFFRON = 0xe39a2c
GOLD = 0xd4a02a
GOLD_DARK = 0x9a6d16
ASPHALT = 0x5f5d59
EARTH = 0x877b66
DIRT = 0x7b7255
SOOT = 0x33302d
CHARCOAL = 0x3a3633
OLIVE = 0x566040
OLIVE_DARK = 0x3f4730
BURLAP = 0xb3a176
CONCRETE = 0x9d9c96
CONCRETE_DARK = 0x6e706f
HAZARD_YELLOW = 0xe3ae1d
PAINT_WHITE = 0xe8e8e2
SHUTTERS = (0x6d7479, 0x44607a, 0x5b7a52, 0x8a4a3a, 0x767067)
SIGNS = (0xc8322a, 0x2f5fb0, 0xe0b52a, 0x2f8a4a, 0xe8e2d0)
PRAYER_FLAGS = (0x2f6fd0, 0xf2f2ee, 0xc8322a, 0x2f9a4a, 0xe8c32a)

# Boxes that hide what is inside them: a face pressed against one of these is never seen.
HIDING_KINDS = {"house", "gate", "ruin", "plinth", "terrace", "shrine"}


def box_frame(box):
    q = box["rotation"]
    return Frame((box["x"], box["y"], box["z"]), Quaternion((q["w"], q["x"], q["y"], q["z"])))


def half_of(box):
    return box["hx"], box["hy"], box["hz"]


def rng_for(box, salt=0):
    """The same random choices for the same box on every build."""
    return random.Random(round(box["x"] * 7919 + box["z"] * 104729 + box["y"] * 31) + salt)


def covered(x, y, z, ignore=None):
    """Whether the point is inside a box that hides faces (upright boxes only)."""
    for other in BOXES:
        if other is ignore or other["kind"] not in HIDING_KINDS or other["yaw"] or other["tilt"]:
            continue
        if abs(x - other["x"]) < other["hx"] and abs(y - other["y"]) < other["hy"] and abs(z - other["z"]) < other["hz"]:
            return True
    return False


def stacked(box, direction):
    """The box standing on this one (direction 1) or this one stands on (-1), centred with it."""
    edge = box["y"] + direction * box["hy"]
    for other in BOXES:
        if other is box or abs(other["x"] - box["x"]) > 1e-3 or abs(other["z"] - box["z"]) > 1e-3:
            continue
        if abs(other["y"] - direction * other["hy"] - edge) < 1e-3:
            return other
    return None


def is_plastered(box):
    """Newer houses are rendered and painted; the old ones show their brick."""
    return rng_for(box, 1).random() < 0.35
