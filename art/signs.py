"""Nepali lettering for the map: shop names on signboards and slogans painted on walls, set in
Noto Sans Devanagari (OFL) and turned into flat vertex-coloured faces like everything else.
Blender shapes Devanagari properly, so any text works."""

import os
import random

import bpy

from common import SOURCE_DIR
from mesh import polygon

FONT_FILE = "NotoSansDevanagari.ttf"
# One straight segment per glyph curve: lettering is read from metres away, and every filled
# glyph costs hundreds of triangles against the map's download budget.
GLYPH_RESOLUTION = 1

# What the shops along a Kathmandu street sell.
SHOP_NAMES = (
    "मोमो पसल",
    "थकाली भोजनालय",
    "चिया पसल",
    "औषधी पसल",
    "कपडा पसल",
    "गोरखा बाजा",
    "साडी घर",
    "न्युरोड इलेक्ट्रोनिक्स",
    "पशुपति मिठाई भण्डार",
    "सगरमाथा होटल",
    "तामा भाँडा पसल",
    "किराना पसल",
    "फलफूल तथा तरकारी",
    "मासु पसल",
    "नेपाल टेलिकम",
    "हिमालय ट्रेकिङ",
    "लामा गेस्ट हाउस",
    "अन्नपूर्ण खाजा घर",
    "टोपी तथा ढाका पसल",
    "जनता फार्मेसी",
    "बागमती साइबर",
    "गणेश पान पसल",
    "सुनचाँदी पसल",
    "दाल भात तरकारी",
    "श्री कृष्ण मेडिकल",
    "काठमाडौं सिलाई केन्द्र",
    "एभरेस्ट मोबाइल",
    "कान्तिपुर पुस्तक पसल",
)
# Slogans and notices painted straight onto walls.
WALL_WORDS = (
    "भाडामा छ",
    "यहाँ फोहोर नफाल्नुहोस्",
    "नो पार्किङ",
    "ताजा दही",
    "शान्ति",
    "नेपाल",
    "सडक बन्द",
    "जय नेपाल",
)

_font = None
_glyph_cache = {}


def font():
    global _font
    if _font is None:
        _font = bpy.data.fonts.load(os.path.join(SOURCE_DIR, FONT_FILE))
    return _font


def text_shape(text):
    """The faces of `text` set at size 1 as lists of (x, y) corners, with its width and height.
    Blender lays the glyphs out and fills them; the temporary object is removed straight after."""
    cached = _glyph_cache.get(text)
    if cached is not None:
        return cached
    curve = bpy.data.curves.new("Sign", "FONT")
    curve.body = text
    curve.font = font()
    curve.size = 1.0
    curve.resolution_u = GLYPH_RESOLUTION
    curve.fill_mode = "FRONT"
    obj = bpy.data.objects.new("Sign", curve)
    bpy.context.scene.collection.objects.link(obj)
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    faces = [[(mesh.vertices[i].co.x, mesh.vertices[i].co.y) for i in p.vertices] for p in mesh.polygons]
    xs = [x for face in faces for x, _ in face]
    ys = [y for face in faces for _, y in face]
    shape = (faces, min(xs), max(xs), min(ys), max(ys))
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)
    _glyph_cache[text] = shape
    return shape


def lettering(frame, text, x, y, height, color, lift, max_width):
    """`text` on a `facing` frame, centred on `x`, its baseline band from `y` up `height` metres
    (shrunk to keep within `max_width`), standing `lift` out from the wall."""
    faces, x0, x1, y0, y1 = text_shape(text)
    scale = height / (y1 - y0)
    if (x1 - x0) * scale > max_width:
        scale = max_width / (x1 - x0)
    mid = (x0 + x1) / 2
    for face in faces:
        polygon(frame, [(x + (fx - mid) * scale, y + (fy - y0) * scale, lift) for fx, fy in face], color)


def shop_name(rng=random):
    return rng.choice(SHOP_NAMES)


def wall_word(rng=random):
    return rng.choice(WALL_WORDS)
