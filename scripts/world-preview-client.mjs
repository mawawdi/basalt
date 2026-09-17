/* global document, window */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const data = await (await fetch("/scene.json")).json();
const scene = new THREE.Scene();
scene.background = new THREE.Color("#bfd3d5");
scene.fog = new THREE.Fog("#bfd3d5", 230, 530);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.2, 1500);
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI * 0.49;
const center = new THREE.Vector3(
  (data.bounds.min.x + data.bounds.max.x) / 2,
  0,
  (data.bounds.min.z + data.bounds.max.z) / 2,
);
const focusTerrain = data.terrains
  .flatMap((terrain) => terrain.points)
  .reduce((nearest, point) => {
    const distance = Math.hypot(point[0] - center.x, point[2] - center.z);
    return nearest === null || distance < nearest.distance
      ? { distance, height: point[1] }
      : nearest;
  }, null);
center.y = focusTerrain?.height ?? 0;
const extent = Math.max(
  data.bounds.max.x - data.bounds.min.x,
  data.bounds.max.z - data.bounds.min.z,
);
scene.add(new THREE.HemisphereLight(0xc6e1ee, 0x7d704c, 2.2));
const sun = new THREE.DirectionalLight(0xffebcc, 3.3);
sun.position.copy(center).add(new THREE.Vector3(-100, 150, -65));
sun.target.position.copy(center);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -extent * 0.8;
sun.shadow.camera.right = extent * 0.8;
sun.shadow.camera.top = extent * 0.8;
sun.shadow.camera.bottom = -extent * 0.8;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;
sun.shadow.normalBias = 0.12;
sun.shadow.bias = -0.0001;
scene.add(sun, sun.target);

for (const terrain of data.terrains) {
  const positions = [],
    colors = [],
    indices = [];
  for (const [x, y, z, material] of terrain.points) {
    positions.push(x, y, z);
    const variation =
      0.92 + 0.06 * Math.sin(x * 0.13) * Math.sin(z * 0.11) + 0.05 * Math.cos((x + z) * 0.27);
    const color = new THREE.Color(material === "Ground" ? "#806a44" : "#66754a").multiplyScalar(
      variation,
    );
    colors.push(color.r, color.g, color.b);
  }
  for (let z = 0; z < terrain.rows - 1; z += 1)
    for (let x = 0; x < terrain.columns - 1; x += 1) {
      const i = z * terrain.columns + x;
      indices.push(
        i,
        i + terrain.columns,
        i + 1,
        i + 1,
        i + terrain.columns,
        i + terrain.columns + 1,
      );
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  mesh.receiveShadow = true;
  scene.add(mesh);
}
for (const route of data.routes) {
  const positions = [],
    indices = [];
  for (const segment of route.travelSegments) {
    const i = positions.length / 3;
    for (const { positionMeters: p } of segment.vertices) positions.push(p.x, p.y, p.z);
    indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const c = route.appearance.baseColorSrgb;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(`rgb(${c.red},${c.green},${c.blue})`),
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  scene.add(mesh);
}
for (const junction of data.junctions) {
  const c = junction.appearance.baseColorSrgb;
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(junction.radiusMeters, 32),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(`rgb(${c.red},${c.green},${c.blue})`),
      roughness: 1,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(
    junction.centerTopMeters.x,
    junction.centerTopMeters.y + 0.001,
    junction.centerTopMeters.z,
  );
  mesh.receiveShadow = true;
  scene.add(mesh);
}
const loader = new GLTFLoader();
const pending = [...data.assets];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const asset = pending.shift();
      const gltf = await loader.loadAsync(asset.url);
      gltf.scene.updateMatrixWorld(true);
      const instances = data.instances.filter((item) => item.assetHash === asset.hash);
      gltf.scene.traverse((node) => {
        if (!node.isMesh) return;
        const mesh = new THREE.InstancedMesh(node.geometry, node.material, instances.length);
        for (let i = 0; i < instances.length; i += 1) {
          const t = instances[i].transformMeters;
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(t.position.x, t.position.y, t.position.z),
            new THREE.Quaternion(...t.rotation),
            new THREE.Vector3(t.scale, t.scale, t.scale),
          );
          matrix.multiply(node.matrixWorld);
          mesh.setMatrixAt(i, matrix);
        }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        scene.add(mesh);
      });
    }
  }),
);
globalThis.basaltPreviewView = async (name) => {
  const positions = {
    overview: [0.74, 0.95, -0.74],
    arrival: [0.1, 0.08, -0.29],
    ridge: [0.44, 0.28, 0.47],
  };
  const targets = {
    overview: [0, 0, 0],
    arrival: [-0.06, 0.03, -0.04],
    ridge: [0.03, 0.04, 0.01],
  };
  camera.position.copy(center).add(new THREE.Vector3(...positions[name]).multiplyScalar(extent));
  controls.target.copy(center).add(new THREE.Vector3(...targets[name]).multiplyScalar(extent));
  controls.update();
  renderer.render(scene, camera);
};
document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => globalThis.basaltPreviewView(button.dataset.view)),
  );
document.querySelector("#status").textContent =
  `${data.instances.length.toLocaleString()} instances · ${data.assets.length} catalog models · mesh preview, Studio verification pending`;
await globalThis.basaltPreviewView("overview");
globalThis.basaltPreviewReady = true;
controls.addEventListener("change", () => renderer.render(scene, camera));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.render(scene, camera);
});
