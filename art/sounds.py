"""Cuts the weapon samples out of their source recordings and encodes them as small mono .ogg
files in public/assets/sounds. Run by art/build.ts through Blender, whose bundled Audaspace does
the decoding and Vorbis encoding.

Sources (CC0): Kenney's Impact Sounds (footsteps); The Free Firearm Sound Library (Ben Jaszczak,
Brian Nelson, Kevin Heras, Matthew Nanney; opengameart.org/content/the-free-firearm-sound-library),
whose "Prepared" recordings hold one or more real shots with their outdoor tails; rubberduck's
"25 CC0 bang / firework SFX" (opengameart.org/content/25-cc0-bang-firework-sfx), recorded
fireworks that stand in for explosions; and for reloads, SpringySpringo's airsoft "Gun reload
sounds" (opengameart.org/content/gun-reload-sounds) and Brian MacIntosh's "Gun Reload Sound
Effects" (opengameart.org/content/gun-reload-sound-effects)."""

import os
import sys

import aud
import numpy as np

ART_DIR = os.path.dirname(os.path.abspath(__file__))
FIREARMS_DIR = os.path.join(ART_DIR, "source", "firearms", "Prepared SFX Library")
BANGS_DIR = os.path.join(ART_DIR, "out", "bangs")
IMPACTS_DIR = os.path.join(ART_DIR, "out", "impacts")
RELOADS_DIR = os.path.join(ART_DIR, "source")
SOUNDS_DIR = os.path.join(ART_DIR, "..", "public", "assets", "sounds")

RATE = 44100
BITRATE = 80000
# Peak level every clip is normalised to.
PEAK = 0.9
# The cut starts this long before the shot so its attack isn't clipped.
LEAD_IN = 0.01

# Game name → (source file, seconds into it where the shot starts, clip length, fade-out length).
# Shots are taken where the analysis found a single onset with nothing else for a while after.
CLIPS = {
    "shot-rifle-0": (os.path.join(FIREARMS_DIR, "AR-15", "D_24P.wav"), 0.58, 1.0, 0.3),
    "shot-rifle-1": (os.path.join(FIREARMS_DIR, "AR-15", "D_24P.wav"), 3.93, 1.0, 0.3),
    "shot-rifle-2": (os.path.join(FIREARMS_DIR, "AR-15", "D_32P.wav"), 0.70, 1.0, 0.3),
    "shot-rifle-3": (os.path.join(FIREARMS_DIR, "AR-15", "D_32P.wav"), 5.65, 1.0, 0.3),
    "shot-smg-0": (os.path.join(FIREARMS_DIR, "Carl Gustav M45", "G_20P.wav"), 0.34, 0.7, 0.25),
    "shot-smg-1": (os.path.join(FIREARMS_DIR, "Carl Gustav M45", "G_20P.wav"), 2.26, 0.7, 0.25),
    "shot-smg-2": (os.path.join(FIREARMS_DIR, "Carl Gustav M45", "G_31P.wav"), 0.31, 0.7, 0.25),
    "shot-smg-3": (os.path.join(FIREARMS_DIR, "Carl Gustav M45", "G_31P.wav"), 3.50, 0.7, 0.25),
    "launch-0": (os.path.join(FIREARMS_DIR, "Mossberg", "N_26P.wav"), 0.78, 1.5, 0.5),
    "launch-1": (os.path.join(FIREARMS_DIR, "Mossberg", "N_26P.wav"), 4.57, 1.5, 0.5),
    "launch-2": (os.path.join(FIREARMS_DIR, "Mossberg", "N_30P.wav"), 1.69, 1.5, 0.5),
    # Kenney's grass steps are long rustles; a boot on packed dirt is over in a third of a second.
    "step-dirt-0": (os.path.join(IMPACTS_DIR, "footstep_grass_000.ogg"), 0.0, 0.32, 0.14),
    "step-dirt-1": (os.path.join(IMPACTS_DIR, "footstep_grass_001.ogg"), 0.0, 0.32, 0.14),
    "step-dirt-2": (os.path.join(IMPACTS_DIR, "footstep_grass_002.ogg"), 0.0, 0.32, 0.14),
    "step-dirt-3": (os.path.join(IMPACTS_DIR, "footstep_grass_003.ogg"), 0.0, 0.32, 0.14),
    "step-dirt-4": (os.path.join(IMPACTS_DIR, "footstep_grass_004.ogg"), 0.0, 0.32, 0.14),
    "explosion-0": (os.path.join(BANGS_DIR, "bang_03.ogg"), 0.0, 1.1, 0.2),
    "explosion-1": (os.path.join(BANGS_DIR, "bang_01.ogg"), 0.0, 1.0, 0.2),
    "explosion-2": (os.path.join(BANGS_DIR, "bang_09.ogg"), 0.0, 1.1, 0.2),
    "explosion-3": (os.path.join(BANGS_DIR, "cannon_02.ogg"), 0.0, 1.8, 0.3),
    # Reloading, cut from recordings of real gun handling so it plays as recorded: the airsoft
    # reloads hold a magazine-catch click, a pause, then the fresh magazine clacking home and the
    # bolt racked (two clicks); the clip loads and single round stand in for a rocket seated.
    "reload-out-0": (os.path.join(RELOADS_DIR, "gunreload1.wav"), 0.18, 0.16, 0.08),
    "reload-out-1": (os.path.join(RELOADS_DIR, "clipload2.wav"), 0.07, 0.14, 0.06),
    "reload-in-0": (os.path.join(RELOADS_DIR, "gunreload1.wav"), 1.287, 0.29, 0.1),
    "reload-in-1": (os.path.join(RELOADS_DIR, "assaultriflereload1_0.wav"), 1.042, 0.15, 0.05),
    "reload-bolt-0": (os.path.join(RELOADS_DIR, "assaultriflereload1_0.wav"), 1.199, 0.24, 0.06),
    "reload-bolt-1": (os.path.join(RELOADS_DIR, "shotguncock_0.wav"), 0.05, 0.4, 0.1),
    "reload-rocket-0": (os.path.join(RELOADS_DIR, "singlebullet1.wav"), 0.129, 0.17, 0.06),
    "reload-rocket-1": (os.path.join(RELOADS_DIR, "clipload1.wav"), 0.085, 0.17, 0.06),
}


def peak_of(sound):
    return float(np.abs(sound.data()).max())


def build(name, source, start, length, fade):
    if not os.path.exists(source):
        raise FileNotFoundError(f"{source} (see art/build.ts for where the sources come from)")
    start = max(0.0, start - LEAD_IN)
    quality = getattr(aud, "RESAMPLE_QUALITY_HIGH", True)
    clip = aud.Sound.file(source).limit(start, start + length).rechannel(1).resample(RATE, quality)
    clip = clip.fadein(0, 0.002).fadeout(length - fade, fade)
    clip = clip.volume(PEAK / peak_of(clip))
    clip.write(
        os.path.join(SOUNDS_DIR, name + ".ogg"),
        RATE,
        aud.CHANNELS_MONO,
        aud.FORMAT_S16,
        aud.CONTAINER_OGG,
        aud.CODEC_VORBIS,
        BITRATE,
        4096,
    )


def main():
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    for name, (source, start, length, fade) in CLIPS.items():
        build(name, source, start, length, fade)
        print(f"wrote {name}.ogg")


main()
