import { MAX_PITCH, MOUSE_SENSITIVITY } from "../shared/constants.ts";
import { clamp, wrapAngle } from "../shared/math.ts";
import { BUTTON } from "../shared/protocol.ts";

const KEY_BUTTONS: Readonly<Record<string, number>> = {
  KeyW: BUTTON.FORWARD,
  ArrowUp: BUTTON.FORWARD,
  KeyS: BUTTON.BACK,
  ArrowDown: BUTTON.BACK,
  KeyA: BUTTON.LEFT,
  ArrowLeft: BUTTON.LEFT,
  KeyD: BUTTON.RIGHT,
  ArrowRight: BUTTON.RIGHT,
  Space: BUTTON.JUMP,
  KeyG: BUTTON.GRENADE,
  KeyR: BUTTON.RELOAD,
  ShiftLeft: BUTTON.SPRINT,
  ShiftRight: BUTTON.SPRINT,
};

/** Where the player is looking. Mouse movement updates it immediately, every frame. */
export const look = { yaw: 0, pitch: 0 };

let heldButtons = 0;
// Buttons pressed since the last tick, so a tap shorter than one tick still registers.
let tappedButtons = 0;
let scoreboardHeld = false;
let selectedWeapon = 0;

export function isPointerLocked(): boolean {
  return document.pointerLockElement !== null;
}

export function requestPointerLock(canvas: HTMLCanvasElement): void {
  // Browsers refuse the lock for a moment after the player presses Esc. That is expected: the
  // "Click to play" prompt stays up and the next click tries again.
  canvas.requestPointerLock().catch(() => undefined);
}

function press(button: number): void {
  heldButtons |= button;
  tappedButtons |= button;
}

function releaseAll(): void {
  heldButtons = 0;
  tappedButtons = 0;
}

export function initInput(canvas: HTMLCanvasElement, canPlay: () => boolean): void {
  canvas.addEventListener("click", () => {
    if (canPlay() && !isPointerLocked()) requestPointerLock(canvas);
  });
  document.addEventListener("pointerlockchange", () => {
    if (!isPointerLocked()) releaseAll();
  });
  window.addEventListener("blur", () => {
    releaseAll();
    scoreboardHeld = false;
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Tab") {
      event.preventDefault();
      scoreboardHeld = true;
      return;
    }
    if (isPointerLocked() && event.code >= "Digit1" && event.code <= "Digit3") {
      selectedWeapon = Number(event.code.slice(-1)) - 1;
      event.preventDefault();
      return;
    }
    const button = KEY_BUTTONS[event.code];
    if (button === undefined || !isPointerLocked()) return;
    event.preventDefault();
    press(button);
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Tab") scoreboardHeld = false;
    const button = KEY_BUTTONS[event.code];
    if (button !== undefined) heldButtons &= ~button;
  });

  window.addEventListener("mousedown", (event) => {
    if (event.button === 0 && isPointerLocked()) press(BUTTON.FIRE);
    if (event.button === 2 && isPointerLocked()) press(BUTTON.ADS);
  });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) heldButtons &= ~BUTTON.FIRE;
    if (event.button === 2) heldButtons &= ~BUTTON.ADS;
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!isPointerLocked()) return;
      event.preventDefault();
      selectedWeapon = (selectedWeapon + (event.deltaY > 0 ? 1 : 2)) % 3;
    },
    { passive: false },
  );

  document.addEventListener("mousemove", (event) => {
    if (!isPointerLocked()) return;
    look.yaw = wrapAngle(look.yaw - event.movementX * MOUSE_SENSITIVITY);
    look.pitch = clamp(look.pitch - event.movementY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
  });
}

/** The buttons for this tick: everything held, plus anything tapped since the last call. */
export function consumeButtons(): number {
  const buttons = heldButtons | tappedButtons;
  tappedButtons = 0;
  return buttons;
}

/** The selected loadout slot persists between ticks and is replicated with every input. */
export function currentWeapon(): number {
  return selectedWeapon;
}

export function isScoreboardHeld(): boolean {
  return scoreboardHeld;
}
