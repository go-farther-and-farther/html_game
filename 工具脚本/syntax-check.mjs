
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ---------- 基础场景 ---------- */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe8f5, 30, 90);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 300);
camera.position.set(3.6, 2.4, 5.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.1, 1.3, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 2;
controls.maxDistance = 25;
controls.maxPolarAngle = Math.PI * 0.495;

/* ---------- 光照 ---------- */
scene.add(new THREE.HemisphereLight(0xcfefff, 0x6b8e4e, 0.9));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.5);
sun.position.set(6, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -6; sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -6;
sun.shadow.camera.far = 40;
scene.add(sun);
scene.add(sun.target);

/* ---------- 材质 ---------- */
const M = {
  white:  new THREE.MeshStandardMaterial({ color: 0xfdfdfd, roughness: .85 }),
  grey:   new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: .85 }),
  dark:   new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: .7 }),
  black:  new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: .6 }),
  beak:   new THREE.MeshStandardMaterial({ color: 0xf6a623, roughness: .55 }),
  pouch:  new THREE.MeshStandardMaterial({ color: 0xf28c1c, roughness: .5 }),
  leg:    new THREE.MeshStandardMaterial({ color: 0xf39c12, roughness: .6 }),
  frame:  new THREE.MeshStandardMaterial({ color: 0xd63b3b, roughness: .4, metalness: .3 }),
  metal:  new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: .3, metalness: .7 }),
  tire:   new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: .9 }),
  seat:   new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: .8 }),
  scarf:  new THREE.MeshStandardMaterial({ color: 0xe03e3e, roughness: .9 }),
  grass:  new THREE.MeshStandardMaterial({ color: 0x74b04e, roughness: 1 }),
  trunk:  new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 1 }),
  leaf:   new THREE.MeshStandardMaterial({ color: 0x3f8f43, roughness: 1, flatShading: true }),
  leaf2:  new THREE.MeshStandardMaterial({ color: 0x57a84f, roughness: 1, flatShading: true }),
  cloud:  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  gold:   new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: .3, metalness: .8 }),
  fish:   new THREE.MeshStandardMaterial({ color: 0x7ec8e3, roughness: .4, metalness: .3 }),
  goldfish: new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: .3, metalness: .4, emissive: 0xf1c40f, emissiveIntensity: .25 }),
  hill:   new THREE.MeshStandardMaterial({ color: 0x7fb069, roughness: 1 }),
  water:  new THREE.MeshStandardMaterial({ color: 0x4a90d9, roughness: .25, metalness: .1, transparent: true, opacity: .85 }),
  lily:   new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: .9 }),
};

/* ---------- 工具 ---------- */
const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function setSeg(mesh, a, b) {
  _dir.subVectors(b, a);
  const len = _dir.length() || 1e-6;
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.scale.y = len;
  mesh.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
}
function makeSeg(r, mat, radial = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, radial), mat);
  m.castShadow = true;
  return m;
}
function solveIK(from, to, l1, l2, bend) {
  const u = new THREE.Vector3().subVectors(to, from);
  const d = Math.min(u.length(), l1 + l2 - 1e-4);
  u.normalize();
  const a = (d * d + l1 * l1 - l2 * l2) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const px = -u.y, py = u.x;
  return new THREE.Vector3(
    from.x + u.x * a + px * h * bend,
    from.y + u.y * a + py * h * bend,
    (from.z + to.z) * 0.5
  );
}

/* ---------- 世界参数 ---------- */
const WORLD = 360;
const HALF = WORLD / 2;
const POND = { x: 40, z: 30, r: 11 }; // 圆形水域判定保持不变，岸带装饰沿用

/* ---------- 固定种子随机（新增布局可复现，便于前后对比） ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260926);
const rand = (a = 1, b) => (b === undefined ? rng() * a : a + rng() * (b - a));

/* ---------- 地面（草地，保持平坦） ---------- */
const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD + 40, WORLD + 40), M.grass);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
ground.receiveShadow = true;
scene.add(ground);

/* ---------- 小路：经过出生点，弯曲通向池塘 ---------- */
const PATH_HALF_W = 2.2;
const pathCurve = new THREE.CatmullRomCurve3([
  V(-26, 0, 6), V(-13, 0, 0.5), V(0, 0, 0), V(9, 0, 2.5),
  V(17, 0, 6.5), V(25, 0, 13), V(31.5, 0, 20.5), // 终点距池塘圆心约12.8，接岸不进水
]);
const PATH_SAMPLES = pathCurve.getSpacedPoints(240).map(p => ({ x: p.x, z: p.z }));
function distToPath(x, z) {
  let best = Infinity;
  for (let i = 0; i < PATH_SAMPLES.length; i++) {
    const dx = x - PATH_SAMPLES[i].x, dz = z - PATH_SAMPLES[i].z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
{
  const pts = pathCurve.getSpacedPoints(110);
  const n = pts.length;
  const pos = [], idx = [];
  const tanAt = i => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    return [tx / l, tz / l];
  };
  const halfW = i => PATH_HALF_W + Math.sin(i * 0.21) * 0.28 + Math.sin(i * 0.065 + 2.1) * 0.22;
  for (let i = 0; i < n; i++) {
    const [tx, tz] = tanAt(i);
    const nx = -tz, nz = tx;
    const w = halfW(i);
    pos.push(pts[i].x + nx * w, 0, pts[i].z + nz * w);
    pos.push(pts[i].x - nx * w, 0, pts[i].z - nz * w);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  for (const end of [0, n - 1]) { // 两端圆头
    const [tx, tz] = tanAt(end);
    const thL = Math.atan2(-tz, tx); // 左法线方位角，扫半圈经过路径反方向
    const base = pos.length / 3;
    pos.push(pts[end].x, 0, pts[end].z);
    const w = halfW(end), segs = 6;
    for (let s = 0; s <= segs; s++) {
      const th = thL + (s / segs) * Math.PI;
      pos.push(pts[end].x + Math.cos(th) * w, 0, pts[end].z + Math.sin(th) * w);
    }
    for (let s = 0; s < segs; s++) idx.push(base, base + 1 + s, base + 2 + s);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const pathMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xd6c096, roughness: 1, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  pathMesh.position.y = 0.02; // 高于草斑，避免深度闪烁
  pathMesh.receiveShadow = true;
  scene.add(pathMesh);
}

/* ---------- 草斑：大小不一、边缘不规则的地块 ---------- */
const blobGeos = [];
for (let g = 0; g < 4; g++) {
  const N = 9 + g * 2;
  const outline = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    const r = 0.62 + rng() * 0.5; // 半径抖动 → 不规则边缘
    outline.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < N; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  blobGeos.push(geo);
}
const patchMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
{
  const patchMat2 = new THREE.Color();
  const blobLists = [[], [], [], []];
  for (let i = 0; i < 30; i++) {
    const s = rng() < 0.35 ? rand(4.5, 9) : rand(1.6, 4.5);
    let x = 0, z = 0, ok = false;
    for (let t = 0; t < 60 && !ok; t++) {
      x = rand(-HALF, HALF); z = rand(-HALF, HALF);
      ok = Math.hypot(x - POND.x, z - POND.z) > POND.r + s * 1.3 + 0.8   // 不压水面与岸带
        && distToPath(x, z) > PATH_HALF_W + 0.9 + s * 1.3;               // 不与小路重叠
    }
    if (!ok) continue;
    blobLists[Math.floor(rng() * 4)].push({
      x, z, s, k: 0.75 + rng() * 0.35, rotY: rand(0, Math.PI * 2),
      col: patchMat2.setHSL(0.255 + rng() * 0.045, 0.4 + rng() * 0.08, 0.5 + rng() * 0.05).clone(),
      y: 0.001 + (i % 8) * 0.0004, // 微错层，重叠处深度稳定不闪
    });
  }
  // 出生视野保底几块草斑，常见视角不空
  [[-9, 9, 4, 0.9], [8, -8, 3.2, 0.85], [16, -4, 2.6, 1.0], [-18, -10, 5, 0.8]].forEach(([x, z, s, k], gi) => {
    blobLists[gi % 4].push({
      x, z, s, k, rotY: gi * 1.3,
      col: patchMat2.setHSL(0.26 + gi * 0.008, 0.42, 0.51 + gi * 0.008).clone(),
      y: 0.001 + (gi % 8) * 0.0004,
    });
  });
  blobLists.forEach((list, g) => {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(blobGeos[g], patchMat, list.length);
    list.forEach((b, i) => {
      _q.setFromAxisAngle(UP, b.rotY);
      _p.set(b.x, b.y, b.z);
      _s.set(b.s, 1, b.s * b.k);
      _m.compose(_p, _q, _s);
      inst.setMatrixAt(i, _m);
      inst.setColorAt(i, b.col);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.receiveShadow = true;
    scene.add(inst);
  });
}

/* ---------- 池塘 ---------- */
const pond = new THREE.Mesh(new THREE.CircleGeometry(POND.r, 40), M.water);
pond.rotation.x = -Math.PI / 2;
pond.position.set(POND.x, 0.01, POND.z);
pond.receiveShadow = true;
scene.add(pond);
const pondEdge = new THREE.Mesh(new THREE.RingGeometry(POND.r - 0.3, POND.r + 0.5, 40), M.grass);
pondEdge.rotation.x = -Math.PI / 2;
pondEdge.position.set(POND.x, 0.005, POND.z);
scene.add(pondEdge);
for (let i = 0; i < 6; i++) {
  const lily = new THREE.Mesh(new THREE.CircleGeometry(0.5 + Math.random() * 0.4, 8), M.lily);
  lily.rotation.x = -Math.PI / 2;
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * (POND.r - 2);
  lily.position.set(POND.x + Math.cos(ang) * r, 0.03, POND.z + Math.sin(ang) * r);
  scene.add(lily);
}

/* ---------- 植被（树丛分布 · 固定种子 · InstancedMesh） ---------- */
const treeData = [];   // 参与碰撞的树（松树 + 阔叶树），带碰撞半径 r
const pineData = [];
const broadData = [];
const shrubData = [];
const flowerData = [];
const rockData = [];
const treeClusterCenters = [];
const _qId = new THREE.Quaternion();
const _vegCol = new THREE.Color();

function placeXZ(minPath, minPond, minSpawn, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const x = rand(-HALF + 4, HALF - 4), z = rand(-HALF + 4, HALF - 4);
    if (Math.hypot(x, z) < minSpawn) continue;
    if (Math.hypot(x - POND.x, z - POND.z) < minPond) continue;
    if (distToPath(x, z) < minPath) continue;
    return { x, z };
  }
  return null;
}
function tooCloseToTrees(x, z, minD) {
  for (const tr of treeData) {
    const dx = tr.x - x, dz = tr.z - z;
    if (dx * dx + dz * dz < minD * minD) return true;
  }
  return false;
}
function addPine(x, z) {
  const h = 1.1 + rng() * 1.3;
  const s = 0.85 + rng() * 0.7;
  const cones = [];
  for (let j = 0; j < 3; j++) cones.push((1.0 - j * 0.24) * (0.8 + rng() * 0.3));
  pineData.push({ x, z, h, s, cones });
  treeData.push({ x, z, r: 0.5 });
}
function addBroadleaf(x, z) {
  const s = 0.9 + rng() * 0.8;
  const trunkH = 1.5 + rng() * 1.0;
  const col = new THREE.Color().setHSL(0.24 + rng() * 0.09, 0.42 + rng() * 0.16, 0.32 + rng() * 0.1);
  const crowns = [{ x: 0, y: trunkH + 0.7 * s, z: 0, r: 1.15 * s, rotY: rand(0, Math.PI * 2), col }];
  if (rng() < 0.5) {
    crowns.push({
      x: (rng() - 0.5) * 1.3, y: trunkH + (0.3 + rng() * 0.5) * s, z: (rng() - 0.5) * 1.3,
      r: 0.72 * s, rotY: rand(0, Math.PI * 2),
      col: col.clone().offsetHSL((rng() - 0.5) * 0.02, 0, 0.05),
    });
  }
  broadData.push({ x, z, trunkH, s, crowns });
  treeData.push({ x, z, r: 0.55 });
}
function clusterSpread(spot, n, dMin, dMax, minD, addFn) {
  for (let j = 0; j < n; j++) {
    const a = rand(0, Math.PI * 2), d = Math.sqrt(rng()) * rand(dMin, dMax);
    const x = spot.x + Math.cos(a) * d, z = spot.z + Math.sin(a) * d;
    if (Math.abs(x) > HALF - 3 || Math.abs(z) > HALF - 3) continue;
    if (Math.hypot(x, z) < 10) continue;                                  // 出生点留空（含默认机位）
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 4) continue;        // 岸带留空
    if (distToPath(x, z) < 3.2) continue;                                 // 树干离路，骑行道畅通
    if (tooCloseToTrees(x, z, minD)) continue;
    addFn(x, z);
  }
}

/* 松树：20 丛（每丛 4–8 棵）+ 独棵 */
for (let c = 0; c < 20; c++) {
  const spot = placeXZ(5.5, POND.r + 5, 10);
  if (!spot) continue;
  treeClusterCenters.push(spot);
  clusterSpread(spot, 4 + Math.floor(rng() * 5), 3, 7.5, 2.0, addPine);
}
for (let i = 0; i < 26; i++) {
  const p = placeXZ(3.2, POND.r + 4, 10);
  if (p && !tooCloseToTrees(p.x, p.z, 2.0)) addPine(p.x, p.z);
}
/* 出生视野（西北侧）保底树丛，保证常见视角有内容 */
treeClusterCenters.push({ x: -22, z: -14 });
[[-20, -12], [-24, -17], [-17, -17], [-26, -9], [-19, -20]].forEach(([x, z]) => addPine(x, z));
addBroadleaf(-14, -20);
addBroadleaf(-17, -23);

/* 阔叶树（圆冠）：12 丛（每丛 2–5 棵）+ 独棵 */
for (let c = 0; c < 12; c++) {
  const spot = placeXZ(5.5, POND.r + 5, 10);
  if (!spot) continue;
  treeClusterCenters.push(spot);
  clusterSpread(spot, 2 + Math.floor(rng() * 4), 3, 7, 1.8, addBroadleaf);
}
for (let i = 0; i < 12; i++) {
  const p = placeXZ(3.2, POND.r + 4, 10);
  if (p && !tooCloseToTrees(p.x, p.z, 1.8)) addBroadleaf(p.x, p.z);
}

/* 矮灌木：依附树丛（林下层）+ 散生 */
function addShrub(x, z) {
  shrubData.push({
    x, z, r: 0.35 + rng() * 0.75, rotY: rand(0, Math.PI * 2),
    col: new THREE.Color().setHSL(0.23 + rng() * 0.11, 0.4 + rng() * 0.15, 0.26 + rng() * 0.1),
  });
}
for (let c = 0; c < 24; c++) {
  const base = treeClusterCenters.length
    ? treeClusterCenters[Math.floor(rng() * treeClusterCenters.length)]
    : { x: rand(-60, 60), z: rand(-60, 60) };
  const n = 2 + Math.floor(rng() * 4);
  for (let j = 0; j < n; j++) {
    const a = rand(0, Math.PI * 2), d = rand(2, 8);
    const x = base.x + Math.cos(a) * d, z = base.z + Math.sin(a) * d;
    if (Math.abs(x) > HALF - 3 || Math.abs(z) > HALF - 3) continue;
    if (Math.hypot(x, z) < 4) continue;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 2.5) continue;
    if (distToPath(x, z) < 3.4) continue;
    addShrub(x, z);
  }
}
for (let i = 0; i < 14; i++) {
  const p = placeXZ(3.4, POND.r + 2.5, 4);
  if (p) addShrub(p.x, p.z);
}
[[-15, -9], [-25, -8], [-12, -24], [-8, -14]].forEach(([x, z]) => addShrub(x, z)); // 出生视野保底

/* 花簇：路边 / 池塘外围 / 草地，穿插分布 */
const flowerPalette = [0xf28cab, 0xffd93d, 0xff8c42, 0xffffff, 0xb39ddb, 0xff6b6b];
function addFlower(x, z) {
  flowerData.push({
    x, z, h: 0.16 + rng() * 0.16, r: 0.07 + rng() * 0.06,
    col: new THREE.Color(flowerPalette[Math.floor(rng() * flowerPalette.length)]),
    rotY: rand(0, Math.PI * 2),
  });
}
function flowerCluster(cx, cz, n, spread) {
  for (let j = 0; j < n; j++) {
    const a = rand(0, Math.PI * 2), d = Math.sqrt(rng()) * spread;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 2.2) continue;
    if (distToPath(x, z) < PATH_HALF_W + 0.5) continue;
    addFlower(x, z);
  }
}
for (let i = 0; i < 26; i++) { // 路边：沿小路法线外推
  const k = Math.floor(rng() * PATH_SAMPLES.length);
  const a = PATH_SAMPLES[k], b = PATH_SAMPLES[Math.min(PATH_SAMPLES.length - 1, k + 2)];
  let tx = b.x - a.x, tz = b.z - a.z;
  const l = Math.hypot(tx, tz) || 1;
  const off = rand(3.4, 8.5) * (rng() < 0.5 ? 1 : -1);
  flowerCluster(a.x + (-tz / l) * off, a.z + (tx / l) * off, 3 + Math.floor(rng() * 5), rand(0.9, 2));
}
for (let i = 0; i < 8; i++) { // 池塘外围
  const a = rand(0, Math.PI * 2), d = POND.r + rand(2.6, 6);
  flowerCluster(POND.x + Math.cos(a) * d, POND.z + Math.sin(a) * d, 3 + Math.floor(rng() * 4), rand(0.8, 1.6));
}
for (let i = 0; i < 12; i++) { // 草地
  const p = placeXZ(2.7, POND.r + 2.2, 4);
  if (p) flowerCluster(p.x, p.z, 3 + Math.floor(rng() * 4), rand(1, 2.2));
}
flowerCluster(-10, -8, 6, 2);   // 出生视野保底
flowerCluster(-18, -4, 5, 1.6);

/* 石块：多靠树丛，少量散生 */
for (let i = 0; i < 34; i++) {
  let p = null;
  if (rng() < 0.6 && treeClusterCenters.length) {
    const base = treeClusterCenters[Math.floor(rng() * treeClusterCenters.length)];
    const x = base.x + rand(-8, 8), z = base.z + rand(-8, 8);
    if (Math.abs(x) < HALF - 3 && Math.abs(z) < HALF - 3
      && Math.hypot(x, z) > 4
      && Math.hypot(x - POND.x, z - POND.z) > POND.r + 2.6
      && distToPath(x, z) > 3.2) p = { x, z };
  } else {
    p = placeXZ(3.2, POND.r + 2.6, 4);
  }
  if (!p) continue;
  rockData.push({
    x: p.x, z: p.z,
    sx: 0.25 + rng() * 0.55, sy: 0.16 + rng() * 0.3, sz: 0.25 + rng() * 0.55,
    rotY: rand(0, Math.PI * 2),
    col: new THREE.Color().setHSL(0.09 + rng() * 0.05, 0.04 + rng() * 0.08, 0.55 + rng() * 0.18),
  });
}

/* ---------- 植被实例化 ---------- */
const trunkCount = pineData.length + broadData.length;
const trunkInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.14, 1, 8), M.trunk, trunkCount);
{
  let i = 0;
  pineData.forEach(t => {
    _p.set(t.x, t.h * t.s / 2, t.z);
    _s.set(t.s, t.h * t.s, t.s);
    _m.compose(_p, _qId, _s);
    trunkInst.setMatrixAt(i++, _m);
  });
  broadData.forEach(t => {
    _p.set(t.x, t.trunkH / 2, t.z);
    _s.set(t.s * 0.9, t.trunkH, t.s * 0.9);
    _m.compose(_p, _qId, _s);
    trunkInst.setMatrixAt(i++, _m);
  });
}
const coneInsts = [
  new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1.5, 7), M.leaf, pineData.length),
  new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1.5, 7), M.leaf2, pineData.length),
  new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1.5, 7), M.leaf, pineData.length),
];
pineData.forEach((t, i) => {
  let y = t.h * t.s;
  for (let j = 0; j < 3; j++) {
    const r = t.cones[j] * t.s;
    _p.set(t.x, y + r * 0.75, t.z);
    _s.set(r, r, r);
    _m.compose(_p, _qId, _s);
    coneInsts[j].setMatrixAt(i, _m);
    y += r * 1.05;
  }
});
/* 圆冠阔叶树冠 / 矮灌木 / 花头共用低多边形二十面体几何体 */
const blobGeo = new THREE.IcosahedronGeometry(1, 0);
const leafTintMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
const crownCount = broadData.reduce((n, t) => n + t.crowns.length, 0);
const crownInst = new THREE.InstancedMesh(blobGeo, leafTintMat, crownCount);
{
  let i = 0;
  broadData.forEach(t => {
    t.crowns.forEach(c => {
      _q.setFromAxisAngle(UP, c.rotY);
      _p.set(t.x + c.x, c.y, t.z + c.z);
      _s.set(c.r, c.r * 0.9, c.r);
      _m.compose(_p, _q, _s);
      crownInst.setMatrixAt(i, _m);
      crownInst.setColorAt(i, c.col);
      i++;
    });
  });
}
const shrubInst = new THREE.InstancedMesh(blobGeo, leafTintMat, shrubData.length);
shrubData.forEach((sh, i) => {
  _q.setFromAxisAngle(UP, sh.rotY);
  _p.set(sh.x, sh.r * 0.5, sh.z);
  _s.set(sh.r, sh.r * 0.62, sh.r);
  _m.compose(_p, _q, _s);
  shrubInst.setMatrixAt(i, _m);
  shrubInst.setColorAt(i, sh.col);
});
const stemInst = new THREE.InstancedMesh(
  new THREE.CylinderGeometry(0.016, 0.024, 1, 5),
  new THREE.MeshStandardMaterial({ color: 0x4f8f3f, roughness: 1 }),
  flowerData.length
);
const headInst = new THREE.InstancedMesh(
  blobGeo,
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .8, flatShading: true }),
  flowerData.length
);
flowerData.forEach((f, i) => {
  _q.setFromAxisAngle(UP, f.rotY);
  _p.set(f.x, f.h / 2, f.z);
  _s.set(1, f.h, 1);
  _m.compose(_p, _q, _s);
  stemInst.setMatrixAt(i, _m);
  _p.set(f.x, f.h + f.r * 0.55, f.z);
  _s.set(f.r, f.r * 0.8, f.r);
  _m.compose(_p, _q, _s);
  headInst.setMatrixAt(i, _m);
  headInst.setColorAt(i, f.col);
});
const rockInst = new THREE.InstancedMesh(
  new THREE.DodecahedronGeometry(1, 0),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95, flatShading: true }),
  rockData.length
);
rockData.forEach((rk, i) => {
  _q.setFromAxisAngle(UP, rk.rotY);
  _p.set(rk.x, rk.sy * 0.45, rk.z);
  _s.set(rk.sx, rk.sy, rk.sz);
  _m.compose(_p, _q, _s);
  rockInst.setMatrixAt(i, _m);
  rockInst.setColorAt(i, rk.col);
});
trunkInst.instanceMatrix.needsUpdate = true;
trunkInst.castShadow = true;
coneInsts.forEach(c => { c.instanceMatrix.needsUpdate = true; c.castShadow = true; });
crownInst.instanceMatrix.needsUpdate = true;
crownInst.castShadow = true;
shrubInst.instanceMatrix.needsUpdate = true;
shrubInst.castShadow = true;
stemInst.instanceMatrix.needsUpdate = true;
headInst.instanceMatrix.needsUpdate = true;
rockInst.instanceMatrix.needsUpdate = true;
rockInst.castShadow = true;
rockInst.receiveShadow = true;
scene.add(trunkInst, ...coneInsts, crownInst, shrubInst, stemInst, headInst, rockInst);

/* ---------- 云（InstancedMesh） ---------- */
const cloudData = [];
for (let i = 0; i < 12; i++) {
  const n = 3 + Math.floor(Math.random() * 3);
  const cx = (Math.random() - 0.5) * WORLD;
  const cy = 9 + Math.random() * 6;
  const cz = (Math.random() - 0.5) * WORLD;
  for (let j = 0; j < n; j++) {
    const r = 0.9 + Math.random() * 1.1;
    cloudData.push({ x: cx + j * 1.2 - n * 0.5, y: cy + Math.random() * 0.5, z: cz + Math.random() * 0.8, r });
  }
}
const cloudInst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 10), M.cloud, cloudData.length);
cloudData.forEach((c, i) => {
  _p.set(c.x, c.y, c.z);
  _s.set(c.r, c.r, c.r);
  _m.compose(_p, _qId, _s);
  cloudInst.setMatrixAt(i, _m);
});
cloudInst.instanceMatrix.needsUpdate = true;
scene.add(cloudInst);

/* ---------- 太阳与远山（跟随鹈鹕） ---------- */
const skyGroup = new THREE.Group();
scene.add(skyGroup);

const skyGeo = new THREE.SphereGeometry(250, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor: { value: new THREE.Color(0x4a90d9) },
    bottomColor: { value: new THREE.Color(0xcfe8f5) },
    exponent: { value: 0.6 },
  },
  vertexShader: `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform float exponent;
    varying vec3 vPos;
    void main() {
      float h = normalize(vPos).y;
      gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
});
const skyDome = new THREE.Mesh(skyGeo, skyMat);
skyGroup.add(skyDome);

const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1.8, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffe066, fog: false })
);
sunMesh.position.set(28, 15, -45);
skyGroup.add(sunMesh);

const glowCanvas = document.createElement('canvas');
glowCanvas.width = 128; glowCanvas.height = 128;
const gctx = glowCanvas.getContext('2d');
const gradient = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
gradient.addColorStop(0, 'rgba(255, 224, 102, 0.8)');
gradient.addColorStop(1, 'rgba(255, 224, 102, 0)');
gctx.fillStyle = gradient;
gctx.fillRect(0, 0, 128, 128);
const glowTexture = new THREE.CanvasTexture(glowCanvas);
const glowMat = new THREE.SpriteMaterial({
  map: glowTexture,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
const glow = new THREE.Sprite(glowMat);
glow.scale.set(12, 12, 1);
glow.position.set(28, 15, -45);
skyGroup.add(glow);

const hill = new THREE.Mesh(new THREE.SphereGeometry(20, 24, 16), M.hill);
hill.scale.set(1, 0.32, 1);
hill.position.set(-32, -6, -28);
skyGroup.add(hill);
const hill2 = new THREE.Mesh(new THREE.SphereGeometry(14, 20, 14), M.hill);
hill2.scale.set(1, 0.3, 1);
hill2.position.set(20, -5, -30);
skyGroup.add(hill2);

/* ---------- 自行车 + 鹈鹕 ---------- */
const bike = new THREE.Group();
scene.add(bike);

const HUB_Y = 0.47;
const REAR = V(-0.60, HUB_Y, 0);
const FRONT = V(0.55, HUB_Y, 0);
const CRANK = V(0.0, 0.45, 0);
const CRANK_R = 0.17;

function makeWheel() {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 10, 40), M.tire);
  tire.castShadow = true;
  g.add(tire);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.018, 8, 36), M.metal);
  g.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.13, 12), M.metal);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < 3; i++) {
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.74, 6), M.metal);
    sp.rotation.z = (i / 3) * Math.PI;
    g.add(sp);
  }
  return g;
}
const wheelR = makeWheel(); wheelR.position.copy(REAR);  bike.add(wheelR);
const wheelF = makeWheel(); wheelF.position.copy(FRONT); bike.add(wheelF);

function tube(a, b, r = 0.035, mat = M.frame, parent = bike) {
  const m = makeSeg(r, mat);
  setSeg(m, a, b);
  parent.add(m);
  return m;
}
tube(V(0, 0.45, 0), V(-0.32, 1.02, 0), 0.04);
tube(V(0, 0.45, 0), V(0.5, 1.0, 0), 0.042);
tube(V(-0.32, 1.02, 0), V(0.53, 1.08, 0), 0.038);
tube(V(0.5, 1.0, 0), V(0.58, 1.2, 0), 0.045);
for (const z of [-0.06, 0.06]) {
  tube(V(0, 0.45, z * 0.6), V(REAR.x, REAR.y, z), 0.025);
  tube(V(-0.32, 1.0, z * 0.4), V(REAR.x, REAR.y, z), 0.025);
}
for (const z of [-0.06, 0.06]) tube(V(0.56, 1.1, z * 0.5), V(FRONT.x, FRONT.y, z), 0.026, M.metal);

const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 12), M.metal);
bar.rotation.x = Math.PI / 2;
bar.position.set(0.58, 1.26, 0);
bike.add(bar);
for (const z of [-0.26, 0.26]) {
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.13, 10), M.dark);
  grip.rotation.x = Math.PI / 2;
  grip.position.set(0.58, 1.26, z);
  bike.add(grip);
}
const bell = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.gold);
bell.position.set(0.58, 1.3, 0.14);
bike.add(bell);
const seat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.2), M.seat);
seat.position.set(-0.33, 1.05, 0);
seat.rotation.z = 0.06;
seat.castShadow = true;
bike.add(seat);
const fender = new THREE.Mesh(new THREE.TorusGeometry(0.51, 0.02, 8, 24, Math.PI * 0.9), M.frame);
fender.position.copy(REAR);
fender.rotation.z = Math.PI * 0.05;
bike.add(fender);

const CHAIN_Z = 0.1;
tube(V(CRANK.x, CRANK.y + 0.14, CHAIN_Z), V(REAR.x, REAR.y + 0.055, CHAIN_Z), 0.012, M.dark);
tube(V(CRANK.x, CRANK.y - 0.14, CHAIN_Z), V(REAR.x, REAR.y - 0.055, CHAIN_Z), 0.012, M.dark);
const cogG = new THREE.Group();
cogG.position.set(REAR.x, REAR.y, CHAIN_Z);
const cog = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 16), M.metal);
cog.rotation.x = Math.PI / 2;
cogG.add(cog);
bike.add(cogG);

const crankR = new THREE.Group(); crankR.position.copy(CRANK); bike.add(crankR);
const crankL = new THREE.Group(); crankL.position.copy(CRANK); bike.add(crankL);
const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 20), M.metal);
ring.rotation.x = Math.PI / 2;
ring.position.z = CHAIN_Z;
crankR.add(ring);
for (let i = 0; i < 3; i++) {
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.3, 0.02), M.metal);
  spoke.rotation.z = (i / 3) * Math.PI;
  spoke.position.z = CHAIN_Z;
  crankR.add(spoke);
}
function crankArm(parent, z) {
  const arm = new THREE.Mesh(new THREE.BoxGeometry(CRANK_R, 0.05, 0.03), M.metal);
  arm.position.set(CRANK_R / 2, 0, z);
  parent.add(arm);
}
crankArm(crankR, 0.12);
crankArm(crankL, -0.12);

const pedalGeo = new THREE.BoxGeometry(0.16, 0.035, 0.1);
const pedalR = new THREE.Mesh(pedalGeo, M.dark);
const pedalL = new THREE.Mesh(pedalGeo, M.dark);
pedalR.castShadow = true; pedalL.castShadow = true;
bike.add(pedalR, pedalL);

/* ---------- 鹈鹕 ---------- */
const pelican = new THREE.Group();
bike.add(pelican);

const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 18), M.white);
body.scale.set(1.15, 1.0, 0.95);
body.position.set(-0.1, 1.35, 0);
body.castShadow = true;
pelican.add(body);

const tail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.42, 8), M.white);
tail.rotation.z = Math.PI / 2 + 0.25;
tail.position.set(-0.62, 1.38, 0);
tail.castShadow = true;
pelican.add(tail);

const wings = [];
for (const z of [-1, 1]) {
  const w = new THREE.Group();
  const main = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), M.grey);
  main.scale.set(1.4, 0.45, 0.22);
  main.castShadow = true;
  w.add(main);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), M.dark);
  tip.scale.set(1.5, 0.4, 0.5);
  tip.position.set(-0.38, -0.02, 0);
  w.add(tip);
  w.position.set(-0.18, 1.5, z * 0.34);
  w.rotation.z = -0.18;
  pelican.add(w);
  wings.push({ g: w, side: z });
}

const neckCurve = new THREE.CatmullRomCurve3([
  V(0.08, 1.55, 0), V(0.2, 1.74, 0), V(0.3, 1.86, 0), V(0.4, 1.93, 0)
]);
const neck = new THREE.Mesh(new THREE.TubeGeometry(neckCurve, 20, 0.13, 12, false), M.white);
neck.castShadow = true;
pelican.add(neck);

const headG = new THREE.Group();
headG.position.set(0.4, 1.95, 0);
pelican.add(headG);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 16), M.white);
head.castShadow = true;
headG.add(head);

const bill = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.1, 0.78, 12), M.beak);
bill.rotation.z = -Math.PI / 2 - 0.08;
bill.position.set(0.44, -0.04, 0);
bill.castShadow = true;
headG.add(bill);
const tipNose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 10), M.beak);
tipNose.rotation.z = -Math.PI / 2 - 0.08;
tipNose.position.set(0.86, -0.075, 0);
headG.add(tipNose);
const pouch = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 14), M.pouch);
pouch.scale.set(0.62, 0.2, 0.16);
pouch.position.set(0.42, -0.16, 0);
pouch.rotation.z = -0.1;
headG.add(pouch);

for (const z of [-1, 1]) {
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), M.black);
  eye.position.set(0.13, 0.07, z * 0.14);
  headG.add(eye);
}

const fish = new THREE.Group();
fish.position.set(0.74, -0.1, 0);
headG.add(fish);
const fishBody = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), M.fish);
fishBody.scale.set(1.6, 0.7, 0.5);
fishBody.castShadow = true;
fish.add(fishBody);
const fishTail = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 8), M.fish);
fishTail.rotation.z = Math.PI / 2;
fishTail.position.x = -0.2;
fish.add(fishTail);
const fishEye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), M.black);
fishEye.position.set(0.15, 0.03, 0.05);
fish.add(fishEye);

const ringScarf = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.05, 10, 24), M.scarf);
ringScarf.position.set(0.13, 1.6, 0);
ringScarf.quaternion.setFromUnitVectors(V(0, 0, 1), V(0.55, 0.83, 0).normalize());
pelican.add(ringScarf);
const scarfSegs = [];
for (let i = 0; i < 6; i++) {
  const s = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.15), M.scarf);
  s.castShadow = true;
  pelican.add(s);
  scarfSegs.push(s);
}

const SHOULDER = [V(0.12, 1.52, -0.28), V(0.12, 1.52, 0.28)];
const GRIP = [V(0.58, 1.26, -0.24), V(0.58, 1.26, 0.24)];
const arms = [];
for (let i = 0; i < 2; i++) {
  const upper = makeSeg(0.07, M.white);
  const fore = makeSeg(0.06, M.white);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), M.dark);
  bike.add(upper, fore, hand);
  arms.push({ upper, fore, hand, shoulder: SHOULDER[i], grip: GRIP[i] });
}

const HIP = [V(-0.06, 1.02, -0.16), V(-0.06, 1.02, 0.16)];
const legs = [];
for (let i = 0; i < 2; i++) {
  const thigh = makeSeg(0.075, M.leg);
  const shin = makeSeg(0.06, M.leg);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.12), M.leg);
  foot.castShadow = true;
  bike.add(thigh, shin, foot);
  legs.push({ thigh, shin, foot, hip: HIP[i] });
}

/* ---------- 收集的小鱼（InstancedMesh，双鱼种） ---------- */
const FISH_COUNT = 18;
const fishData = [];
for (let i = 0; i < FISH_COUNT; i++) {
  let x, z;
  do { x = (Math.random() - 0.5) * WORLD; z = (Math.random() - 0.5) * WORLD; }
  while (Math.abs(x) < 5 && Math.abs(z) < 5);
  fishData.push({
    x, z,
    active: true,
    type: Math.random() < 0.7 ? 0 : 1,
    rotY: Math.random() * Math.PI * 2,
  });
}
const fishBodyInst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 14, 10), M.fish, FISH_COUNT);
const fishTailGeo = new THREE.ConeGeometry(0.08, 0.16, 8);
fishTailGeo.rotateZ(Math.PI / 2);
const fishTailInst = new THREE.InstancedMesh(fishTailGeo, M.fish, FISH_COUNT);
const fishEyeInst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.02, 8, 6), M.black, FISH_COUNT);
scene.add(fishBodyInst, fishTailInst, fishEyeInst);
const _fColor = new THREE.Color();
fishData.forEach((f, i) => {
  if (f.type === 1) {
    _fColor.set(0xf1c40f);
    fishBodyInst.setColorAt(i, _fColor);
    fishTailInst.setColorAt(i, _fColor);
  } else {
    _fColor.set(0xffffff);
    fishBodyInst.setColorAt(i, _fColor);
    fishTailInst.setColorAt(i, _fColor);
  }
});
if (fishBodyInst.instanceColor) fishBodyInst.instanceColor.needsUpdate = true;
if (fishTailInst.instanceColor) fishTailInst.instanceColor.needsUpdate = true;

let fishCount = 0;
const fishCountEl = document.querySelector('#stats .fish');
const jumpCountEl = document.querySelector('#stats .jump');
const muteEl = document.getElementById('mute');
const toastEl = document.getElementById('toast');
const distEl = document.getElementById('distance');
const bestEl = document.getElementById('best');

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  toastEl.style.transform = 'translateX(-50%) translateY(-10px)';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateX(-50%) translateY(0)';
  }, 900);
}

/* ---------- 蝴蝶 ---------- */
const butterflies = [];
const butterflyColors = [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff];
for (let i = 0; i < 4; i++) {
  const g = new THREE.Group();
  const wingMat = new THREE.MeshStandardMaterial({ color: butterflyColors[i], side: THREE.DoubleSide, roughness: .8 });
  const wingL = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.2), wingMat);
  wingL.position.x = -0.075;
  wingL.rotation.x = -Math.PI / 2;
  const wingR = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.2), wingMat);
  wingR.position.x = 0.075;
  wingR.rotation.x = -Math.PI / 2;
  const bodyB = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 6), M.black);
  bodyB.rotation.x = Math.PI / 2;
  g.add(wingL, wingR, bodyB);
  const bx = (Math.random() - 0.5) * WORLD;
  const by = 1 + Math.random() * 2;
  const bz = (Math.random() - 0.5) * WORLD;
  g.position.set(bx, by, bz);
  scene.add(g);
  butterflies.push({
    mesh: g, wingL, wingR,
    center: new THREE.Vector3(bx, by, bz),
    radius: 2 + Math.random() * 3,
    speed: 0.5 + Math.random() * 0.5,
    phase: Math.random() * Math.PI * 2,
    flapSpeed: 8 + Math.random() * 4,
  });
}

/* ---------- 风粒子（高速时） ---------- */
const windCount = 50;
const windGeo = new THREE.BufferGeometry();
const windPositions = new Float32Array(windCount * 3);
for (let i = 0; i < windCount; i++) {
  windPositions[i*3] = (Math.random() - 0.5) * 4 - 2;
  windPositions[i*3+1] = Math.random() * 2;
  windPositions[i*3+2] = (Math.random() - 0.5) * 4;
}
windGeo.setAttribute('position', new THREE.BufferAttribute(windPositions, 3));
const windMat = new THREE.PointsMaterial({
  color: 0xffffff,
  size: 0.05,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
});
const wind = new THREE.Points(windGeo, windMat);
wind.visible = false;
bike.add(wind);

/* ---------- 速度 / 转向 / 跳跃 ---------- */
let SPEED = 6;
let heading = 0;
let steerVel = 0;
let bikeLean = 0;
const SPEED_MIN = 2, SPEED_MAX = 14;
const CRUISE_SPEED = 6;
const ACCEL_RATE = 4;
const DECEL_RATE = 3;
const RETURN_RATE = 1.5;
const speedEl = document.getElementById('speed');
const speedBar = document.getElementById('speedbar');
const compassEl = document.getElementById('compass');

function updateSpeed(dt) {
  if (keys['ArrowUp'] || keys['w'] || keys['W']) {
    SPEED += ACCEL_RATE * dt;
  } else if (keys['ArrowDown'] || keys['s'] || keys['S']) {
    SPEED -= DECEL_RATE * dt;
  } else {
    if (SPEED > CRUISE_SPEED) SPEED = Math.max(CRUISE_SPEED, SPEED - RETURN_RATE * dt);
    else if (SPEED < CRUISE_SPEED) SPEED = Math.min(CRUISE_SPEED, SPEED + RETURN_RATE * dt);
  }
  SPEED = Math.max(SPEED_MIN, Math.min(SPEED_MAX, SPEED));
  speedEl.textContent = '速度 ' + Math.round(SPEED);
  speedBar.style.width = ((SPEED - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100) + '%';
}

function updateSteering(dt) {
  let targetSteer = 0;
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) targetSteer += 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) targetSteer -= 1;
  steerVel += (targetSteer - steerVel) * Math.min(1, dt * 8);
  heading += steerVel * 1.4 * (SPEED / 6) * dt;
}

let jumpY = 0, vy = 0, onGround = true, wasOnGround = true, jumpCount = 0;
let jumpCharge = 0;
const GRAVITY = 26, JUMP_V = 9.5;
let tilt = 0;

const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (e.key === 'm' || e.key === 'M') toggleMute();
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  startMusic();
});
window.addEventListener('keyup', e => {
  keys[e.key] = false;
  if (e.key === ' ' && onGround) {
    const jumpV = JUMP_V * (1 + 0.2 * jumpCharge);
    vy = jumpV;
    onGround = false;
    jumpCount++;
    jumpCountEl.textContent = '🦘 ' + jumpCount;
    jumpCharge = 0;
    playJumpSound();
  }
});
window.addEventListener('pointerdown', () => startMusic());

const DIRS = [
  { name: '东', deg: 0 }, { name: '东南', deg: 45 }, { name: '南', deg: 90 },
  { name: '西南', deg: 135 }, { name: '西', deg: 180 }, { name: '西北', deg: 225 },
  { name: '北', deg: 270 }, { name: '东北', deg: 315 },
];
function updateCompass() {
  let deg = (heading * 180 / Math.PI) % 360;
  if (deg < 0) deg += 360;
  const idx = Math.round(((360 - deg) % 360) / 45) % 8;
  compassEl.textContent = '→ ' + DIRS[idx].name;
}

function wrappedDist(x1, z1, x2, z2) {
  let dx = x1 - x2, dz = z1 - z2;
  if (dx > HALF) dx -= WORLD; if (dx < -HALF) dx += WORLD;
  if (dz > HALF) dz -= WORLD; if (dz < -HALF) dz += WORLD;
  return Math.sqrt(dx * dx + dz * dz);
}

/* ---------- 里程记录 ---------- */
let distance = 0;
let bestDistance = parseFloat(localStorage.getItem('pelicanBestDistance') || '0');
bestEl.textContent = '最佳 ' + (bestDistance / 1000).toFixed(2) + ' km';

/* ---------- 音频 ---------- */
let audioCtx = null, musicPlaying = false, muted = false;
let nextNoteTime = 0, noteIndex = 0, musicTimer = null;

const melody = [
  [329.63, .3], [329.63, .3], [349.23, .3], [392.0, .3],
  [392.0, .3], [349.23, .3], [329.63, .3], [293.66, .3],
  [261.63, .3], [261.63, .3], [293.66, .3], [329.63, .3],
  [329.63, .6], [293.66, .3], [293.66, .6],
  [329.63, .3], [329.63, .3], [349.23, .3], [392.0, .3],
  [392.0, .3], [349.23, .3], [329.63, .3], [293.66, .3],
  [261.63, .3], [261.63, .3], [293.66, .3], [329.63, .3],
  [329.63, .6], [293.66, .3], [293.66, .6],
];
const bass = [
  [130.81, 1.2], [130.81, .6], [196.0, .6], [196.0, .6],
  [164.81, 1.2], [130.81, 1.2], [196.0, .6], [164.81, .6],
];

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function playNote(freq, time, dur, type = 'triangle', vol = 0.08) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + dur);
}
function scheduler() {
  if (!audioCtx || !musicPlaying) return;
  while (nextNoteTime < audioCtx.currentTime + 0.5) {
    const [freq, dur] = melody[noteIndex % melody.length];
    if (freq > 0) playNote(freq, nextNoteTime, dur, 'triangle', 0.07);
    nextNoteTime += dur;
    noteIndex++;
    if (noteIndex % melody.length === 0) {
      let bt = audioCtx.currentTime;
      for (const [bf, bd] of bass) {
        playNote(bf, bt, bd, 'sine', 0.05);
        bt += bd;
      }
    }
  }
  musicTimer = setTimeout(scheduler, 100);
}
function startMusic() {
  if (muted) return;
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (musicPlaying) return;
  musicPlaying = true;
  nextNoteTime = audioCtx.currentTime + 0.1;
  noteIndex = 0;
  scheduler();
}
function toggleMute() { // FIXED
  muted = !muted;
  muteEl.textContent = muted ? '🔇' : '🔊';
  if (muted) {
    if (musicTimer) clearTimeout(musicTimer);
    musicPlaying = false;
  } else {
    startMusic();
  }
}
function playJumpSound() {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(900, now + 0.2);
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + 0.2);
}
function playLandSound() {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 150;
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + 0.15);
}
function playCollectSound() {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;
  playNote(880, now, 0.1, 'square', 0.06);
  playNote(1320, now + 0.08, 0.15, 'square', 0.06);
}
function playGoldFishSound() {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;
  playNote(1046, now, 0.1, 'square', 0.07);
  playNote(1568, now + 0.08, 0.12, 'square', 0.07);
  playNote(2093, now + 0.16, 0.15, 'square', 0.07);
}
function playBumpSound() {
  if (!audioCtx || muted) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 80;
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + 0.2);
}

/* ---------- 水花（升级） ---------- */
const splashes = [];
function spawnSplash(x, z) {
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3 + i * 0.15, 0.5 + i * 0.15, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 - i * 0.15, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03 + i * 0.005, z);
    scene.add(ring);
    splashes.push({ mesh: ring, life: -i * 0.15, isDrop: false });
  }
  for (let i = 0; i < 6; i++) {
    const drop = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xbde0fe, transparent: true, opacity: 0.8 })
    );
    drop.position.set(x, 0.1, z);
    scene.add(drop);
    splashes.push({
      mesh: drop,
      life: 0,
      isDrop: true,
      vx: (Math.random() - 0.5) * 2,
      vy: 2 + Math.random() * 2,
      vz: (Math.random() - 0.5) * 2,
    });
  }
}
let lastSplash = 0;

/* ---------- 碰撞 ---------- */
let lastBump = 0;
let bikeBounce = 0;
function checkCollision(t) {
  for (const tr of treeData) {
    const rad = tr.r || 0.5;
    const d = wrappedDist(bike.position.x, bike.position.z, tr.x, tr.z);
    if (d < rad) {
      if (t - lastBump > 0.5) {
        SPEED = Math.max(SPEED_MIN, SPEED * 0.6);
        playBumpSound();
        bikeBounce = 0.3;
        lastBump = t;
        let dx = bike.position.x - tr.x;
        let dz = bike.position.z - tr.z;
        if (dx > HALF) dx -= WORLD;
        if (dx < -HALF) dx += WORLD;
        if (dz > HALF) dz -= WORLD;
        if (dz < -HALF) dz += WORLD;
        const dist = Math.sqrt(dx * dx + dz * dz) || 1e-6;
        const push = rad - d;
        bike.position.x += (dx / dist) * push;
        bike.position.z += (dz / dist) * push;
      }
    }
  }
}

/* ---------- 动画 ---------- */
const clock = new THREE.Clock();
let crankAngle = 0;
const prevBikePos = new THREE.Vector3();
const wrapDelta = new THREE.Vector3();
const camDelta = new THREE.Vector3();
const camTarget = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updateSpeed(dt);
  updateSteering(dt);

  const dir = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
  bike.position.addScaledVector(dir, SPEED * dt);
  bike.rotation.y = -heading;

  wrapDelta.set(0, 0, 0);
  if (bike.position.x > HALF) { bike.position.x -= WORLD; wrapDelta.x = -WORLD; }
  if (bike.position.x < -HALF) { bike.position.x += WORLD; wrapDelta.x = WORLD; }
  if (bike.position.z > HALF) { bike.position.z -= WORLD; wrapDelta.z = -WORLD; }
  if (bike.position.z < -HALF) { bike.position.z += WORLD; wrapDelta.z = WORLD; }

  if (keys[' '] && onGround) {
    jumpCharge = Math.min(1, jumpCharge + dt * 2);
  }
  vy -= GRAVITY * dt;
  jumpY += vy * dt;
  if (jumpY <= 0) { jumpY = 0; vy = 0; onGround = true; }
  if (!wasOnGround && onGround) { playLandSound(); }
  wasOnGround = onGround;

  const targetTilt = onGround ? 0 : 0.12;
  tilt += (targetTilt - tilt) * Math.min(1, dt * 8);
  const leanTarget = steerVel * 0.15;
  bikeLean += (leanTarget - bikeLean) * Math.min(1, dt * 8);
  bike.rotation.z = tilt + bikeLean;
  bike.position.y = jumpY + Math.sin(t * 8) * 0.012 + Math.sin(t * 2.1) * 0.01 + Math.sin(t * 20) * bikeBounce * 0.1;
  bikeBounce = Math.max(0, bikeBounce - dt * 2);

  camDelta.copy(bike.position).sub(prevBikePos).add(wrapDelta);
  camera.position.add(camDelta);
  camTarget.set(bike.position.x + 0.1, 1.3 + bike.position.y, bike.position.z);
  controls.target.lerp(camTarget, 1 - Math.exp(-8 * dt));
  prevBikePos.copy(bike.position);

  sun.position.set(bike.position.x + 6, 10, bike.position.z + 5);
  sun.target.position.copy(bike.position);
  sun.target.updateMatrixWorld();
  skyGroup.position.copy(bike.position);

  const WHEEL_W = -SPEED / 0.47;
  const CRANK_W = -SPEED * 0.95;
  crankAngle += CRANK_W * dt;
  wheelR.rotation.z += WHEEL_W * dt;
  wheelF.rotation.z += WHEEL_W * dt;
  crankR.rotation.z = crankAngle;
  crankL.rotation.z = crankAngle + Math.PI;
  cogG.rotation.z = crankAngle * 2.2;

  const pr = V(CRANK.x + Math.cos(crankAngle) * CRANK_R, CRANK.y + Math.sin(crankAngle) * CRANK_R, 0.19);
  const pl = V(CRANK.x + Math.cos(crankAngle + Math.PI) * CRANK_R, CRANK.y + Math.sin(crankAngle + Math.PI) * CRANK_R, -0.19);
  pedalR.position.copy(pr);
  pedalL.position.copy(pl);

  const pedals = [pl, pr];
  legs.forEach((L, i) => {
    const foot = pedals[i];
    const ankle = V(foot.x, foot.y + 0.05, foot.z);
    const knee = solveIK(L.hip, ankle, 0.42, 0.44, 1);
    setSeg(L.thigh, L.hip, knee);
    setSeg(L.shin, knee, ankle);
    L.foot.position.set(foot.x, foot.y + 0.015, foot.z);
  });

  arms.forEach(A => {
    const elbow = solveIK(A.shoulder, A.grip, 0.3, 0.32, -1);
    setSeg(A.upper, A.shoulder, elbow);
    setSeg(A.fore, elbow, A.grip);
    A.hand.position.copy(A.grip);
  });

  bike.rotation.x = Math.sin(t * 2.1) * 0.03;

  body.position.y = 1.35 + Math.sin(crankAngle * 2) * 0.018;
  headG.rotation.z = Math.sin(t * 4) * 0.06 - 0.03;
  pouch.scale.y = 0.2 + Math.sin(t * 5) * 0.015;
  for (const w of wings) {
    w.g.rotation.x = w.side * (0.12 + Math.sin(t * 4 + w.side) * 0.08);
    w.g.position.y = 1.5 + Math.sin(crankAngle * 2) * 0.018;
  }

  scarfSegs.forEach((s, i) => {
    const k = i / scarfSegs.length;
    s.position.set(
      0.02 - i * 0.17,
      1.62 - i * 0.035 + Math.sin(t * 7 - i * 0.9) * 0.07 * (k + 0.3),
      Math.sin(t * 5 - i * 0.7) * 0.06 * k
    );
    s.rotation.z = Math.sin(t * 7 - i * 0.9) * 0.25;
    s.rotation.y = Math.sin(t * 5 - i * 0.7) * 0.3 * k;
  });

  fish.rotation.z = Math.sin(t * 6) * 0.15;
  fish.rotation.x = Math.sin(t * 4) * 0.1;

  for (let i = 0; i < fishData.length; i++) {
    const f = fishData[i];
    if (!f.active) {
      _m.makeScale(0, 0, 0);
      fishBodyInst.setMatrixAt(i, _m);
      fishTailInst.setMatrixAt(i, _m);
      fishEyeInst.setMatrixAt(i, _m);
      continue;
    }
    f.rotY += dt * 0.5;
    const y = 0.15 + Math.sin(t * 3 + f.x) * 0.05;
    _q.setFromAxisAngle(UP, f.rotY);
    const cos = Math.cos(f.rotY), sin = Math.sin(f.rotY);
    _p.set(f.x, y, f.z);
    _s.set(0.192, 0.084, 0.06);
    _m.compose(_p, _q, _s);
    fishBodyInst.setMatrixAt(i, _m);
    _p.set(f.x - 0.2 * cos, y, f.z + 0.2 * sin);
    _s.set(0.08, 0.16, 0.08);
    _m.compose(_p, _q, _s);
    fishTailInst.setMatrixAt(i, _m);
    _p.set(f.x + 0.15 * cos + 0.05 * sin, y + 0.03, f.z - 0.15 * sin + 0.05 * cos);
    _s.set(0.02, 0.02, 0.02);
    _m.compose(_p, _q, _s);
    fishEyeInst.setMatrixAt(i, _m);
    if (wrappedDist(bike.position.x, bike.position.z, f.x, f.z) < 1.5) {
      f.active = false;
      const pts = f.type === 1 ? 3 : 1;
      fishCount += pts;
      fishCountEl.textContent = '🐟 ' + fishCount;
      if (f.type === 1) { playGoldFishSound(); showToast('🐟 +3'); }
      else { playCollectSound(); showToast('🐟 +1'); }
      setTimeout(() => {
        f.x = (Math.random() - 0.5) * WORLD;
        f.z = (Math.random() - 0.5) * WORLD;
        f.active = true;
      }, 6000);
    }
  }
  fishBodyInst.instanceMatrix.needsUpdate = true;
  fishTailInst.instanceMatrix.needsUpdate = true;
  fishEyeInst.instanceMatrix.needsUpdate = true;

  for (const b of butterflies) {
    b.phase += dt * b.speed;
    b.mesh.position.set(
      b.center.x + Math.cos(b.phase) * b.radius,
      b.center.y + Math.sin(b.phase * 2) * 0.5,
      b.center.z + Math.sin(b.phase) * b.radius
    );
    const angle = Math.atan2(-Math.sin(b.phase) * b.radius, -Math.cos(b.phase) * b.radius);
    b.mesh.rotation.y = angle;
    const flap = Math.sin(t * b.flapSpeed) * 0.6;
    b.wingL.rotation.z = flap;
    b.wingR.rotation.z = -flap;
  }

  if (SPEED > 10) {
    wind.visible = true;
    const pos = windGeo.attributes.position.array;
    for (let i = 0; i < windCount; i++) {
      pos[i*3] -= (SPEED + 2) * dt;
      if (pos[i*3] < -3) {
        pos[i*3] = 3;
        pos[i*3+1] = Math.random() * 2;
        pos[i*3+2] = (Math.random() - 0.5) * 4;
      }
    }
    windGeo.attributes.position.needsUpdate = true;
  } else {
    wind.visible = false;
  }

  const overPond = Math.sqrt((bike.position.x - POND.x) ** 2 + (bike.position.z - POND.z) ** 2) < POND.r;
  if (overPond && onGround && t - lastSplash > 0.3) {
    spawnSplash(bike.position.x, bike.position.z);
    lastSplash = t;
  }
  for (let i = splashes.length - 1; i >= 0; i--) {
    const s = splashes[i];
    s.life += dt;
    if (s.life < 0) continue;
    if (s.isDrop) {
      s.vy -= 10 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.material.opacity = 0.8 * (1 - s.life / 0.5);
      if (s.life > 0.5) {
        scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        splashes.splice(i, 1);
      }
    } else {
      const scale = 1 + s.life * 4;
      s.mesh.scale.set(scale, 1, scale);
      s.mesh.material.opacity = Math.max(0, 0.6 * (1 - s.life / 0.8));
      if (s.life > 0.8) {
        scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        splashes.splice(i, 1);
      }
    }
  }

  M.water.opacity = 0.8 + Math.sin(t * 2) * 0.05;

  checkCollision(t);

  distance += SPEED * dt;
  distEl.textContent = '里程 ' + (distance / 1000).toFixed(2) + ' km';
  if (distance > bestDistance) {
    bestDistance = distance;
    localStorage.setItem('pelicanBestDistance', bestDistance.toString());
    bestEl.textContent = '最佳 ' + (bestDistance / 1000).toFixed(2) + ' km';
  }

  updateCompass();
  controls.update();
  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------- 调试钩子（自动化验证用，不影响玩法） ---------- */
window.__ride = { bike, treeData, fishData, keys, POND, camera, controls };
