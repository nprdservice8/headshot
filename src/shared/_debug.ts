import RAPIER from "@dimforge/rapier3d-compat";
import { createMover, createMoveState, stepMovement } from "./movement.ts";
import { BUTTON } from "./protocol.ts";
import { addSolidBox, ramp } from "./world.ts";

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number) =>
  addSolidBox(world, { x, y, z, hx, hy, hz, yaw: 0, tilt: 0, color: 0 });
box(0, -0.5, 0, 100, 0.5, 100);
box(0, 2, -20, 5, 2, 0.5);
box(20, 0.15, -12, 2, 0.15, 4);
addSolidBox(world, ramp(40, 0, Math.PI, 6, 2, 3));
world.step();
const mover = createMover(world);
const s = createMoveState(0, 0, 0);
for (let i = 0; i < 10; i++) stepMovement(mover, s, 0, 0);
const out: string[] = [];
for (let i = 0; i < 120; i++) {
  const z0 = s.z;
  stepMovement(mover, s, BUTTON.FORWARD, 0);
  if (i % 6 === 0) out.push(`${(z0 - s.z).toFixed(3)}:${s.y.toFixed(3)}${s.grounded ? "G" : "A"}`);
}
console.log(out.join(" "));
