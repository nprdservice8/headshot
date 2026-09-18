import {
  AmbientLight,
  AnimationMixer,
  Clock,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

type Account = { name: string; email: string; password: string };

const ACCOUNT_STORAGE_KEY = "headshot.accounts";
const SESSION_STORAGE_KEY = "headshot.current-account";
const GUEST_STORAGE_KEY = "headshot.guest-name";
const playerName = document.getElementById("player-name");
const preview = document.getElementById("character-preview");
const startButton = document.getElementById("start-game");
const logoutButton = document.getElementById("logout-btn");

if (
  !(playerName instanceof HTMLSpanElement) ||
  !(preview instanceof HTMLCanvasElement) ||
  !(startButton instanceof HTMLButtonElement) ||
  !(logoutButton instanceof HTMLButtonElement)
) {
  throw new Error("lobby.html is missing a required element");
}

function currentPlayer(): { name: string; guest: boolean } | null {
  try {
    const email = localStorage.getItem(SESSION_STORAGE_KEY);
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) ?? "[]");
    if (Array.isArray(value)) {
      const account = value.find(
        (entry): entry is Account =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          typeof entry.email === "string" &&
          typeof entry.password === "string" &&
          entry.email === email,
      );
      if (account) return { name: account.name, guest: false };
    }
    const guestName = sessionStorage.getItem(GUEST_STORAGE_KEY)?.trim() ?? "";
    return guestName ? { name: guestName, guest: true } : null;
  } catch {
    return null;
  }
}

const player = currentPlayer();
if (!player) {
  location.replace("/");
} else {
  playerName.textContent = player.guest ? `${player.name} (Guest)` : player.name;
  startButton.addEventListener("click", () => location.assign("/?play=true"));
  logoutButton.addEventListener("click", () => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.removeItem(GUEST_STORAGE_KEY);
    } finally {
      location.assign("/");
    }
  });
  startCharacterPreview(preview);
}

async function startCharacterPreview(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  scene.background = new Color(0x080d16);
  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 1.45, 4.1);
  camera.lookAt(0, 1.2, 0);
  scene.add(new AmbientLight(0xa9d7ff, 1.8));
  const key = new DirectionalLight(0x00f0ff, 3.5);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new DirectionalLight(0xffcf4a, 2.5);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const model = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/assets/character.glb");
  scene.add(model.scene);
  const mixer = new AnimationMixer(model.scene);
  const idle = model.animations.find((clip) => clip.name === "Idle");
  if (idle) mixer.clipAction(idle).play();
  const clock = new Clock();

  function draw(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const renderWidth = Math.round(width * renderer.getPixelRatio());
    const renderHeight = Math.round(height * renderer.getPixelRatio());
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    const delta = clock.getDelta();
    mixer.update(delta);
    model.scene.rotation.y += delta * 0.25;
    renderer.render(scene, camera);
    requestAnimationFrame(draw);
  }
  draw();
}
