// 관절 좌표 → VRM 아바타 (리타게팅)
// Skeleton(마네킹)과 같은 인터페이스: group, mirror, update(frame), setColors(), dispose()
//
// 원리
//  - 아바타를 "양 어깨 중점 = 원점", 팔 길이가 좌표 속 사람과 같아지는 크기로 놓는다 → 좌표 데이터와 같은 공간.
//  - VRM의 정규화 본(normalized bone)을 쓴다. 각 본의 "기본 자세 대비 월드 회전(D)"을 구해
//    local = R0p⁻¹ · Dparent⁻¹ · D · R0 로 넣는다.
//  - 몸통: 어깨선 방향(+ 손을 뻗는 쪽으로 살짝 따라감, 숨쉬기). 머리: 얼굴 윤곽.
//  - 손: 손바닥 기준틀(손목→중지, 검지→새끼)로 방향을 정하고, 손가락은 그 기준틀 안에서
//    "굽힘·벌림 각도"를 뽑아 해부학적 범위(경첩 관절, 뒤로 안 젖혀짐)로 제한해 넣는다.
//  - 충돌: 아바타 메시에서 잰 몸통 단면·머리 타원체·목·반대쪽 팔에 손이 파묻히면 표면까지 밀어낸다.
//    (좌표의 깊이 z는 부정확해서 손이 몸 안에 들어가 있는 일이 흔하다. 닿는 수어는 표면에 얹힌다.)
//  - 팔: 2관절 IK. 팔꿈치 각도는 좌표의 팔꿈치를 참고만 하고, 손목이 편하고 몸을 뚫지 않는 각도를 고른다.
//  - 얼굴 좌표 → 표정(입 벌림·미소·눈썹·눈 깜빡임).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { FACE_GROUP_RANGES, FACE_COUNT } from './landmarks.js';

// 먼저 있는 파일을 쓴다. (_local-test 는 로컬 확인용, 배포되지 않음)
export const AVATAR_URLS = ['assets/avatar.vrm', '_local-test/sample.vrm'];
const POOL_MAX = 6;

// ---------- 파일 받기 (한 번만) ----------
let filePromise = null;
function fetchAvatarFile() {
  if (!filePromise) {
    filePromise = (async () => {
      for (const rel of AVATAR_URLS) {
        try {
          const url = new URL(rel, document.baseURI).href;
          const res = await fetch(url);
          if (!res.ok) continue;
          const buffer = await res.arrayBuffer();
          // glb 매직 넘버 'glTF' 확인 (404 대신 HTML을 주는 서버 대비)
          if (buffer.byteLength < 20 || new DataView(buffer).getUint32(0, true) !== 0x46546c67) continue;
          return { url, buffer };
        } catch { /* 다음 후보 */ }
      }
      return null;
    })();
  }
  return filePromise;
}

// ---------- 인스턴스 풀 ----------
// 뷰어가 사라져도 아바타는 버리지 않고 다음 뷰어가 다시 쓴다 (페이지 이동마다 다시 읽지 않게).
const pool = [];
const sharedSources = new Map(); // 텍스처 번호 → Source (인스턴스끼리 GPU 텍스처 공유)
let unavailable = false;

export function avatarUnavailable() { return unavailable; }

// 풀에 남은 아바타가 있으면 바로 꺼낸다 (없으면 null)
export function takePooledAvatar() {
  const a = pool.pop() || null;
  if (a) a._reset();
  return a;
}

// 아바타 하나를 준비한다. 파일이 없거나 읽기에 실패하면 null.
export async function loadAvatar() {
  const pooled = takePooledAvatar();
  if (pooled) return pooled;
  if (unavailable) return null;
  try {
    const file = await fetchAvatarFile();
    if (!file) { unavailable = true; return null; }
    const again = takePooledAvatar();
    if (again) return again;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(file.buffer, THREE.LoaderUtils.extractUrlBase(file.url));
    const vrm = gltf.userData.vrm;
    if (!vrm || !vrm.humanoid) throw new Error('VRM 데이터가 없습니다');
    shareTextures(gltf);
    try { VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch { /* 선택 사항 */ }
    try { (VRMUtils.combineSkeletons || VRMUtils.removeUnnecessaryJoints)?.(gltf.scene); } catch { /* 선택 사항 */ }
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    return new Avatar(vrm);
  } catch (err) {
    console.warn('[avatar] 아바타를 불러오지 못해 마네킹으로 표시합니다:', err);
    unavailable = true;
    return null;
  }
}

// 같은 파일을 여러 번 파싱해도 텍스처는 GPU에 한 번만 올라가게 한다
function shareTextures(gltf) {
  const assoc = gltf.parser?.associations;
  if (!assoc) return;
  const visit = (tex) => {
    if (!tex || !tex.isTexture) return;
    const idx = assoc.get(tex)?.textures;
    if (idx === undefined) return;
    const shared = sharedSources.get(idx);
    if (shared) tex.source = shared; else sharedSources.set(idx, tex.source);
  };
  gltf.scene.traverse((o) => {
    if (!o.material) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (mat.uniforms) for (const u of Object.values(mat.uniforms)) visit(u && u.value);
      for (const k of Object.keys(mat)) visit(mat[k]);
    }
  });
}

// ---------- 수학 도우미 ----------
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const IDENT = new THREE.Quaternion();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _qi = new THREE.Quaternion();

// a를 x축, (a, b) 평면의 b 쪽을 y축으로 하는 직교 기준틀
function basisQuat(out, a, b) {
  _bx.copy(a).normalize();
  _bz.crossVectors(_bx, b);
  if (_bz.lengthSq() < 1e-10) {
    _bz.crossVectors(_bx, Math.abs(_bx.y) < 0.9 ? Y : Z);
  }
  _bz.normalize();
  _by.crossVectors(_bz, _bx);
  return out.setFromRotationMatrix(_bm.makeBasis(_bx, _by, _bz));
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const vecs = (n) => Array.from({ length: n }, () => new THREE.Vector3());
const DEG = Math.PI / 180;

// 축(axis)을 기준으로 u에서 v까지 돌아간 각도 (부호 있음)
const _sa = new THREE.Vector3();
const signedAngle = (u, v, axis) => Math.atan2(_sa.crossVectors(u, v).dot(axis), u.dot(v));
// v에서 n 방향 성분을 뺀다 (n은 단위 벡터)
const perp = (v, n) => v.addScaledVector(n, -v.dot(n));

// 계산용 임시 값 (update는 동기 실행이라 인스턴스끼리 같이 써도 된다)
const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tD = new THREE.Vector3();
const tE = new THREE.Vector3(), tF = new THREE.Vector3(), tG = new THREE.Vector3(), tH = new THREE.Vector3();
const tP = new THREE.Vector3(), tPush = new THREE.Vector3(), tPush2 = new THREE.Vector3();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion(), qT = new THREE.Quaternion();
const _eul = new THREE.Euler();
const pC = new THREE.Vector3(), pT = new THREE.Vector3(), pTip = new THREE.Vector3(), pGoal = new THREE.Vector3();
const _pp = [0, 0, 0, 0], _po = [0, 0, 0, 0], _plo = [0, 0, 0, 0], _phi = [0, 0, 0, 0];

// 좌표 하강: 값을 하나씩 조금 바꿔 보며 f를 줄인다 (n개 값, lo~hi 범위 안에서)
function descend(p, lo, hi, n, f, step, rounds) {
  let best = f(p);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      const v = p[i];
      p[i] = clamp(v + step, lo[i], hi[i]);
      let c = f(p);
      if (c < best - 1e-10) { best = c; continue; }
      p[i] = clamp(v - step, lo[i], hi[i]);
      c = f(p);
      if (c < best - 1e-10) { best = c; continue; }
      p[i] = v;
    }
    step *= 0.6;
  }
  return best;
}
// 팔 자세 계산 결과 (_armPose)
const aE = new THREE.Vector3(), aU = new THREE.Vector3(), aUd = new THREE.Vector3(), aLo = new THREE.Vector3();
const aPole = new THREE.Vector3(), aBend = new THREE.Vector3();
const aDu = new THREE.Quaternion(), aDl = new THREE.Quaternion();
const aW = { flex: 0, dev: 0, sup: 0, rel: 0 };

// ---------- 본 목록 ----------
const TORSO = ['spine', 'chest', 'upperChest'];
const FINGERS = [
  { lm: [1, 2, 3, 4], bones: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], thumb: true },
  { lm: [5, 6, 7, 8], bones: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'] },
  { lm: [9, 10, 11, 12], bones: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'] },
  { lm: [13, 14, 15, 16], bones: ['RingProximal', 'RingIntermediate', 'RingDistal'] },
  { lm: [17, 18, 19, 20], bones: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] },
];
const BONE_NAMES = (() => {
  const list = ['hips', ...TORSO, 'neck', 'head', 'leftEye', 'rightEye'];
  for (const s of ['left', 'right']) {
    list.push(`${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`);
    for (const f of FINGERS) for (const b of f.bones) list.push(s + b);
    list.push(`${s}Foot`, `${s}Toes`);
  }
  return list;
})();

const FACE = Object.fromEntries(FACE_GROUP_RANGES.map((g) => [g.name, g]));
// 입 벌림·미소 판단에 쓰는 점 위치 (그룹 안에서의 순서)
const OUTER_CORNER_R = 0, OUTER_CORNER_L = 6; // 61, 291
const INNER_CORNER_R = 0, INNER_UP = 2, INNER_CORNER_L = 4, INNER_DOWN = 6; // 78, 13, 308, 14
const OVAL_TOP = 0, OVAL_L = 4, OVAL_CHIN = 8, OVAL_R = 12; // 10, 454, 152, 234
const NO_FACE_PITCH = 0.19; // 코-귀 선은 정면을 볼 때도 약간 아래를 향한다
const ARM_REACH = 1.52;      // 좌표 속 사람의 팔 길이(위팔+아래팔) / 어깨 너비
const FOREARM_TWIST = 0.6;  // 아래팔 비틀림 중 팔꿈치 쪽 본이 맡는 비율 (나머지는 손목)

// ---------- 손가락 모델 (각도는 라디안) ----------
// 검지~새끼: 첫 마디(MCP) = 굽힘 + 약간의 벌림, 둘째·셋째 마디(PIP·DIP) = 경첩(굽힘만)
const FAN = [0.10, 0, -0.09, -0.19];          // 편 손에서 각 손가락이 중지 방향과 이루는 각 (엄지 쪽 +)
const MCP_MIN = -12 * DEG, MCP_MAX = 92 * DEG;
const PIP_MAX = 105 * DEG, DIP_MAX = 75 * DEG;
const SPREAD_MAX = 20 * DEG;
const DIP_COUPLE = 0.67;                       // 끝 마디는 가운데 마디를 따라 굽는다
// 힘을 뺀 손: 새끼 쪽으로 갈수록 조금 더 굽는다
const RELAX_MCP = [0.26, 0.34, 0.42, 0.50];
const RELAX_PIP = [0.40, 0.48, 0.56, 0.64];
// 엄지: 첫 뼈(중수골)의 방향 범위 — 손바닥 평면 안에서의 각(alpha), 손바닥 쪽으로 드는 각(eps)
const TH_ALPHA = [-10 * DEG, 80 * DEG], TH_EPS = [-12 * DEG, 62 * DEG];
const TH_MCP = [-8 * DEG, 65 * DEG], TH_IP = [-12 * DEG, 85 * DEG];
const TH_RELAX = { alpha: 40 * DEG, eps: 20 * DEG, mcp: 0.15, ip: 0.2 };
// 손목 가동 범위 (굽힘·젖힘 / 좌우 꺾임): 편한 범위와 한계
const WRIST_FLEX_SOFT = 62 * DEG, WRIST_FLEX_HARD = 76 * DEG;
const WRIST_DEV_SOFT = 22 * DEG, WRIST_DEV_HARD = 30 * DEG;
// 아래팔 회전(손바닥 아래 = 0, 손바닥 위 = 180°)의 편한 범위
const SUP_SOFT = [-20 * DEG, 180 * DEG], SUP_HARD = [-45 * DEG, 205 * DEG];

// 팔꿈치 각도(어깨-손목 축을 도는 각, 0 = 아래, + = 바깥) 후보
const PHI_MIN = -0.35, PHI_MAX = 2.1, PHI_N = 15;
const _cost = new Float32Array(PHI_N);

const SKIN = 0.004;          // 살갗 사이에 두는 틈
const PROFILE_POW = 2.6;     // 몸통 단면의 둥근 정도 (2 = 타원, 클수록 네모)

// ---------- 몸 모양 재기 ----------
// 아바타 메시의 꼭짓점을 본별로 나눠 몸통 단면·머리·팔 굵기를 잰다 (같은 파일은 한 번만).
let shapeCache = null;

const sortedPct = (arr, p) => arr[clamp(Math.round((arr.length - 1) * p), 0, arr.length - 1)];

function measureShape(avatar) {
  const { vrm, bones, arms } = avatar;
  const h = vrm.humanoid;
  // 원본(raw) 본 → 분류. strict: 그 본에 직접 붙은 꼭짓점만 (머리카락·치마 같은 딸린 본 제외)
  const cat = new Map();
  const names = Object.keys(h.humanBones || {});
  for (const n of names) {
    const node = h.getRawBoneNode(n);
    if (!node) continue;
    let c = { id: 'none', strict: true };
    if (n === 'hips' || /UpperLeg$/.test(n)) c = { id: 'torso', strict: true };
    else if (n === 'spine' || n === 'chest' || n === 'upperChest' || /Shoulder$/.test(n)) c = { id: 'torso', strict: false };
    else if (n === 'neck') c = { id: 'neck', strict: true };
    else if (n === 'head' || n === 'jaw' || /Eye$/.test(n)) c = { id: 'head', strict: true };
    else if (/UpperArm$/.test(n)) c = { id: 'ua', strict: true, side: n.startsWith('left') ? 'left' : 'right' };
    else if (/LowerArm$/.test(n)) c = { id: 'la', strict: true, side: n.startsWith('left') ? 'left' : 'right' };
    else if (/Hand$/.test(n)) c = { id: 'palm', strict: true, side: n.startsWith('left') ? 'left' : 'right' };
    cat.set(node, c);
  }
  const classify = (bone) => {
    let n = bone, direct = true;
    while (n) {
      const c = cat.get(n);
      if (c) return (direct || !c.strict) ? c : null;
      n = n.parent;
      direct = false;
    }
    return null;
  };

  const torso = [];                 // x, y, z ...
  const headAll = [], headFace = [];
  const neckD = [], uaD = [], laD = [], palmD = [];
  const v = new THREE.Vector3(), w = new THREE.Vector3(), ax = new THREE.Vector3();
  const axisDist = (p, a, b) => {
    ax.subVectors(b, a);
    const t = clamp(w.subVectors(p, a).dot(ax) / Math.max(1e-9, ax.lengthSq()), 0, 1);
    return w.addScaledVector(ax, -t).length();
  };
  const faceMeshes = avatar._faceMeshes || new Set();
  const sleeveX = Math.abs(arms.left.upper.rest.x) + 0.1;
  const armpitY = arms.left.upper.rest.y - 0.5 * arms.left.L1;

  vrm.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) return;
    mesh.skeleton.update();
    const cls = mesh.skeleton.bones.map(classify);
    const step = Math.max(1, Math.floor(pos.count / 30000));
    const isFace = faceMeshes.has(mesh);
    for (let i = 0; i < pos.count; i += step) {
      let bi = si.getX(i), bw = sw.getX(i);
      if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
      if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
      if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
      const c = cls[bi];
      if (!c || c.id === 'none') continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      if (c.id === 'torso') {
        // 겨드랑이 위쪽에서 어깨 관절보다 바깥에 있는 것은 소매이므로 뺀다 (T자세에서 옆으로 펼쳐져 있다)
        if (v.y > armpitY && Math.abs(v.x) > sleeveX) continue;
        torso.push(v.x, v.y, v.z);
      }
      else if (c.id === 'head') { headAll.push(v.x, v.y, v.z); if (isFace) headFace.push(v.x, v.y, v.z); }
      else if (c.id === 'neck' && bones.neck) neckD.push(axisDist(v, bones.neck.rest, bones.head.rest));
      else if (c.id === 'ua') uaD.push(axisDist(v, arms[c.side].upper.rest, arms[c.side].lower.rest));
      else if (c.id === 'la') laD.push(axisDist(v, arms[c.side].lower.rest, arms[c.side].hand.rest));
      else if (c.id === 'palm') palmD.push(Math.abs(w.subVectors(v, arms[c.side].hand.rest).dot(arms[c.side].pn0)));
    }
  });

  const shape = {};
  const rad = (arr, p, def, lo, hi) => {
    if (arr.length < 20) return def;
    arr.sort((a, b) => a - b);
    return clamp(sortedPct(arr, p), lo, hi);
  };
  shape.neckR = rad(neckD, 0.6, 0.11, 0.06, 0.16);
  shape.uaR = rad(uaD, 0.6, 0.1, 0.05, 0.14);
  shape.laR = rad(laD, 0.6, 0.08, 0.04, 0.12);
  shape.palmT = rad(palmD, 0.55, 0.03, 0.018, 0.045);
  shape.fingerR = clamp(shape.palmT * 0.62, 0.014, 0.028);

  // ----- 몸통: 높이별 단면 (가로 중심·반너비, 앞뒤 중심·반두께) -----
  const dy = 0.07;
  let yTop = 0.12, yBot = -2.3;
  if (torso.length >= 300) {
    const ys = [];
    for (let i = 1; i < torso.length; i += 3) ys.push(torso[i]);
    ys.sort((a, b) => a - b);
    yTop = Math.min(0.5, sortedPct(ys, 0.995));
    yBot = Math.max(-2.6, sortedPct(ys, 0.005));
  }
  const n = Math.max(4, Math.ceil((yTop - yBot) / dy) + 1);
  const pr = {
    yTop, dy, n, cap: 0.14,
    cx: new Float32Array(n), hx: new Float32Array(n), cz: new Float32Array(n), hz: new Float32Array(n),
  };
  const bx = Array.from({ length: n }, () => []);
  const bz = Array.from({ length: n }, () => []);
  for (let i = 0; i < torso.length; i += 3) {
    const fi = (yTop - torso[i + 1]) / dy;
    const lo = Math.floor(fi), hi = lo + 1; // 위아래 두 칸에 모두 넣어 빈칸을 줄인다
    for (const k of [lo, hi]) if (k >= 0 && k < n) { bx[k].push(torso[i]); bz[k].push(torso[i + 2]); }
  }
  const ok = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (bx[k].length < 12) continue;
    bx[k].sort((a, b) => a - b); bz[k].sort((a, b) => a - b);
    // 헐렁한 옷자락 끝까지 다 잡지 않도록 양 끝을 조금 버린다
    const x0 = sortedPct(bx[k], 0.02), x1 = sortedPct(bx[k], 0.98);
    const z0 = sortedPct(bz[k], 0.03), z1 = sortedPct(bz[k], 0.97);
    pr.cx[k] = (x0 + x1) / 2; pr.hx[k] = (x1 - x0) / 2;
    pr.cz[k] = (z0 + z1) / 2; pr.hz[k] = (z1 - z0) / 2;
    ok[k] = 1;
  }
  // 꼭짓점이 없는 칸은 가까운 칸(없으면 기본 체형)으로 채운다
  for (let k = 0; k < n; k++) {
    if (ok[k]) continue;
    let near = -1;
    for (let d = 1; d < n && near < 0; d++) {
      if (k - d >= 0 && ok[k - d]) near = k - d;
      else if (k + d < n && ok[k + d]) near = k + d;
    }
    if (near >= 0) { pr.cx[k] = pr.cx[near]; pr.hx[k] = pr.hx[near]; pr.cz[k] = pr.cz[near]; pr.hz[k] = pr.hz[near]; }
    else { pr.cx[k] = 0; pr.hx[k] = 0.42; pr.cz[k] = 0; pr.hz[k] = 0.22; }
  }
  // 위아래로 한 번 다듬는다
  for (const key of ['cx', 'hx', 'cz', 'hz']) {
    const a = pr[key], b = Float32Array.from(a);
    for (let k = 1; k < n - 1; k++) a[k] = 0.25 * b[k - 1] + 0.5 * b[k] + 0.25 * b[k + 1];
  }
  shape.profile = pr;

  // ----- 머리: 타원체 (머리 본 기준) -----
  const head = bones.head;
  const src = headFace.length >= 300 ? headFace : headAll;
  const c = new THREE.Vector3(), r = new THREE.Vector3();
  const eye = avatar.eyeOff.clone().add(head.rest), mouth = avatar.mouthOff.clone().add(head.rest);
  if (src.length >= 300) {
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < src.length; i += 3) { xs.push(src[i]); ys.push(src[i + 1]); zs.push(src[i + 2]); }
    for (const a of [xs, ys, zs]) a.sort((p, q) => p - q);
    const x0 = sortedPct(xs, 0.03), x1 = sortedPct(xs, 0.97);
    const y0 = sortedPct(ys, 0.01), y1 = sortedPct(ys, 0.99);
    const z0 = sortedPct(zs, 0.02), z1 = sortedPct(zs, 0.99);
    r.x = (x1 - x0) / 2;
    r.y = (y1 - y0) / 2 * 1.04;
    r.z = Math.max(r.x * 1.08, (z1 - z0) / 2);
    c.set((x0 + x1) / 2, (y0 + y1) / 2, z1 - r.z);
  } else {
    const fh = Math.max(0.05, eye.y - mouth.y);
    r.x = avatar.faceWidth ? avatar.faceWidth / 2 : avatar.eyeSep * 1.3;
    r.y = fh * 2.3; r.z = r.x * 1.1;
    c.set(eye.x, eye.y + fh * 0.3, mouth.z - r.z * 0.92);
  }
  // 입이 타원체 표면에 오도록 앞뒤 위치를 맞춘다 (입·턱에 닿는 수어가 많다)
  const surfZ = (p) => {
    const k = 1 - ((p.x - c.x) / r.x) ** 2 - ((p.y - c.y) / r.y) ** 2;
    return k > 0.04 ? c.z + r.z * Math.sqrt(k) : null;
  };
  let sz = surfZ(mouth);
  if (sz !== null) c.z += clamp(mouth.z - 0.006 - sz, -0.3, 0.3);
  sz = surfZ(eye);
  if (sz !== null && sz - eye.z > 0.03) c.z -= (sz - eye.z - 0.03) * 0.6;
  shape.head = { c: c.sub(head.rest), r };
  return shape;
}

// 몸통 단면에서 점 p(기본 자세 공간, 반지름 r)가 들어가 있으면 밀어낼 벡터를 out에 담고 깊이를 돌려준다.
// 뒤쪽으로 치우친 축에서 바깥으로 민다 → 몸 앞쪽에 파묻힌 손은 앞으로, 옆구리의 손은 옆으로 나온다.
function profilePush(pr, p, r, out) {
  const fi = (pr.yTop - p.y) / pr.dy;
  if (fi <= 0 || fi >= pr.n) return 0;
  let i = Math.floor(fi), t = fi - i, s = 1;
  if (i >= pr.n - 1) { i = pr.n - 2; s = 1 - (t); t = 1; } // 맨 아래는 서서히 사라지게
  const yc = pr.yTop - pr.cap;
  if (p.y > yc) { const u = (p.y - yc) / pr.cap; s = Math.sqrt(Math.max(0, 1 - u * u)); } // 어깨 위는 둥글게
  if (s < 0.05) return 0;
  const cx = lerp(pr.cx[i], pr.cx[i + 1], t), cz = lerp(pr.cz[i], pr.cz[i + 1], t);
  const hx = lerp(pr.hx[i], pr.hx[i + 1], t) * s + r, hz = lerp(pr.hz[i], pr.hz[i + 1], t) * s + r;
  const u = p.x - cx, w = p.z - cz;
  const F = (x, z) => Math.pow(Math.abs(x) / hx, PROFILE_POW) + Math.pow(Math.abs(z) / hz, PROFILE_POW);
  if (F(u, w) >= 1) return 0;
  // 가운데 쪽 점은 거의 똑바로 앞으로, 옆구리 쪽 점은 옆으로 나가게 축을 잡는다
  const oz = -0.45 * hz;
  const ox = u * 0.85 * (1 - smooth(0.55, 1.0, Math.abs(u) / hx));
  let dx = u - ox, dz = w - oz;
  let len = Math.hypot(dx, dz);
  if (len < 1e-5) { dx = 0; dz = 1; len = 1; }
  let lo = 1, hi = 1 + 2 * (hx + hz) / len;
  for (let k = 0; k < 12; k++) {
    const m = (lo + hi) / 2;
    if (F(ox + dx * m, oz + dz * m) < 1) lo = m; else hi = m;
  }
  out.set(dx * (hi - 1), 0, dz * (hi - 1));
  return len * (hi - 1);
}

// 선분 a-b(반지름 R) 캡슐에서 점 p(반지름 r)를 밀어낸다
function capsulePush(p, r, a, b, R, out) {
  out.subVectors(b, a);
  const t = clamp(tP.subVectors(p, a).dot(out) / Math.max(1e-9, out.lengthSq()), 0, 1);
  out.multiplyScalar(t).add(a).sub(p).negate(); // 축 → p
  const d = out.length();
  const depth = R + r - d;
  if (depth <= 0) return 0;
  if (d < 1e-5) out.set(0, 0, 1); else out.multiplyScalar(1 / d);
  out.multiplyScalar(depth);
  return depth;
}

export class Avatar {
  constructor(vrm) {
    this.vrm = vrm;
    this.group = new THREE.Group();
    this.mirror = false;
    this.isAvatar = true;
    this.container = new THREE.Group();
    this.group.add(this.container);
    this.container.add(vrm.scene);
    this.floorY = -5;
    this._last = 0;
    this._base = null;      // 표정 기준값 (중립 얼굴)
    this._expr = {};        // 부드럽게 따라가는 표정 값
    this._blinkAt = 2 + Math.random() * 3;
    this._blinkT = -1;
    this._springReset = true; // 다음 update에서 스프링 본(머리카락·옷자락)을 현재 자세 기준으로 다시 시작
    this._snapNext = true;    // 다음 update에서 모든 필터를 목표값으로 바로 맞춘다
    this._mirrorPrev = false;
    this._snap = true;
    this._dt = 0;
    this._prevL = new THREE.Vector3();
    this._prevR = new THREE.Vector3();
    this._dataL = new THREE.Vector3();
    this._dataR = new THREE.Vector3();
    this.qTorso = new THREE.Quaternion();
    this.qHead = new THREE.Quaternion();
    this._setup();
  }

  _setup() {
    const vrm = this.vrm;
    const h = vrm.humanoid;
    h.resetNormalizedPose?.();
    vrm.scene.updateMatrixWorld(true);
    const node = (n) => h.getNormalizedBoneNode(n);
    const wp = (n, out) => node(n).getWorldPosition(out);

    // 크기: 팔 길이를 좌표 속 사람의 팔 길이(어깨 너비의 약 1.5배)에 맞춘다.
    // 어깨 너비로 맞추면 어깨가 좁은 아바타는 팔이 너무 길어져 팔꿈치가 옆으로 튀어나온다.
    // 위치: 양 어깨 중점 = 원점
    const l = wp('leftUpperArm', new THREE.Vector3());
    const r = wp('rightUpperArm', new THREE.Vector3());
    const le = wp('leftLowerArm', new THREE.Vector3());
    const lh = wp('leftHand', new THREE.Vector3());
    const s = ARM_REACH / Math.max(1e-4, l.distanceTo(le) + le.distanceTo(lh));
    this.scale = s;
    this.container.scale.setScalar(s);
    this.basePos = l.add(r).multiplyScalar(-0.5 * s);
    this.container.position.copy(this.basePos);
    try { h.update(); } catch { /* 원본 본 맞추기 (선택) */ }
    this.group.updateMatrixWorld(true);

    // 본 정보 (기본 자세의 위치·회전, 부모)
    const bones = {};
    const byNode = new Map();
    for (const name of BONE_NAMES) {
      const n = node(name);
      if (!n) continue;
      const b = {
        name, node: n, parent: null,
        rest: n.getWorldPosition(new THREE.Vector3()),
        R0: n.getWorldQuaternion(new THREE.Quaternion()),
        R0pInv: n.parent.getWorldQuaternion(new THREE.Quaternion()).invert(),
        off: new THREE.Vector3(),
        D: new THREE.Quaternion(),
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(1, 0, 0),
        len: 0,
      };
      bones[name] = b;
      byNode.set(n, b);
    }
    for (const b of Object.values(bones)) {
      let p = b.node.parent;
      while (p && !byNode.has(p)) p = p.parent;
      b.parent = p ? byNode.get(p) : null;
      if (b.parent) b.off.subVectors(b.rest, b.parent.rest);
      b.pos.copy(b.rest);
    }
    this.bones = bones;

    this.torso = TORSO.filter((n) => bones[n]).map((n) => bones[n]);
    const tw = { 1: [1], 2: [0.4, 1], 3: [0.25, 0.6, 1] }[this.torso.length] || [];
    this.torso.forEach((b, i) => { b.weight = tw[i]; });
    this.core = [bones.hips, ...this.torso, bones.neck, bones.head].filter(Boolean);
    // 몸통 충돌에서 높이별로 기준이 되는 본 (위에서 아래로)
    this.torsoOwners = [...this.torso].reverse().concat(bones.hips);

    // 팔·손
    this.arms = {};
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? 1 : -1;
      const upper = bones[`${side}UpperArm`];
      const lower = bones[`${side}LowerArm`];
      const hand = bones[`${side}Hand`];
      const arm = {
        side, sign, upper, lower, hand,
        shoulder: bones[`${side}Shoulder`] || null,
        L1: lower.rest.distanceTo(upper.rest),
        L2: hand.rest.distanceTo(lower.rest),
        upperQ0inv: new THREE.Quaternion(),
        lowerDir0: new THREE.Vector3().subVectors(hand.rest, lower.rest).normalize(),
        across0: new THREE.Vector3(),
        handQ0inv: new THREE.Quaternion(),
        knuckleOff: new THREE.Vector3(),
        // 손 기준틀 (기본 자세의 월드 축): 손가락 방향 f0, 엄지 쪽 a0, 손바닥이 향하는 쪽 pn0
        f0: new THREE.Vector3(), a0: new THREE.Vector3(), pn0: new THREE.Vector3(),
        hinge0: new THREE.Vector3(),
        fingers: [],
        // 매 프레임 상태
        have: false, valid: false, clamped: false,
        DhRaw: new THREE.Quaternion(),   // 좌표에서 구한 손 회전
        qHand: new THREE.Quaternion(),   // 실제로 쓰는(부드럽게 따라가는) 손 회전
        Wf: new THREE.Vector3(),         // 손목 목표 (부드럽게)
        Wc: new THREE.Vector3(),         // 손목 목표 (충돌 보정 뒤)
        phi: 0.3, raise: 0, prot: 0, sup: 0,
        pts: vecs(4 + FINGERS.length * 4), // 손목 기준 손의 점들 (충돌용)
        prad: new Float32Array(4 + FINGERS.length * 4),
        npts: 4,
        palmC0: new THREE.Vector3(),     // 손바닥 가운데
        edgeL0: new THREE.Vector3(),     // 손날(새끼 쪽) 가운데
        edgeT0: new THREE.Vector3(),     // 엄지 쪽 손바닥 가장자리 가운데
      };
      const upperDir0 = new THREE.Vector3().subVectors(lower.rest, upper.rest).normalize();
      basisQuat(arm.upperQ0inv, upperDir0, Z).invert(); // T자세에서 팔꿈치는 앞으로 굽는다

      const mid = bones[`${side}MiddleProximal`];
      const idx = bones[`${side}IndexProximal`];
      const lit = bones[`${side}LittleProximal`] || bones[`${side}RingProximal`];
      const fwd0 = mid ? new THREE.Vector3().subVectors(mid.rest, hand.rest) : arm.lowerDir0.clone().multiplyScalar(0.25);
      const across = idx && lit ? new THREE.Vector3().subVectors(idx.rest, lit.rest) : Z.clone();
      arm.knuckleOff.copy(fwd0);
      basisQuat(arm.handQ0inv, fwd0, across).invert();
      // 아래팔 축에 수직인 손바닥 가로 방향
      arm.across0.copy(across).addScaledVector(arm.lowerDir0, -across.dot(arm.lowerDir0)).normalize();
      arm.f0.copy(fwd0).normalize();
      perp(arm.a0.copy(across), arm.f0).normalize();
      arm.pn0.crossVectors(arm.f0, arm.a0).multiplyScalar(sign);
      arm.hinge0.crossVectors(arm.f0, arm.pn0).normalize(); // 이 축으로 돌리면 손가락이 손바닥 쪽으로 굽는다
      const width = Math.max(1e-4, across.length());
      arm.width = width;
      arm.palmC0.copy(fwd0).multiplyScalar(0.55);
      if (lit) arm.edgeL0.subVectors(lit.rest, hand.rest).multiplyScalar(0.5);
      else arm.edgeL0.copy(arm.palmC0).addScaledVector(arm.a0, -0.4 * width);
      if (idx) arm.edgeT0.subVectors(idx.rest, hand.rest).multiplyScalar(0.55);
      else arm.edgeT0.copy(arm.palmC0).addScaledVector(arm.a0, 0.4 * width);

      // 손가락 끝점: 원본 본에 끝 노드가 있으면 그 위치를 쓴다
      const tipOf = (b, prev) => {
        const raw = h.getRawBoneNode(b.name);
        const child = raw && raw.children.find((c) => c.isBone || c.isObject3D);
        if (child) {
          const p = child.getWorldPosition(new THREE.Vector3()).sub(raw.getWorldPosition(new THREE.Vector3()));
          if (p.length() > 0.2 * prev.len && p.length() < 2 * prev.len) return p;
        }
        return prev.dir.clone().multiplyScalar(prev.len * 0.8);
      };
      const ring = bones[`${side}RingProximal`], little = bones[`${side}LittleProximal`];
      for (const def of FINGERS) {
        const chain = def.bones.map((n) => bones[side + n]).filter(Boolean);
        if (chain.length !== def.bones.length) continue; // 손가락 본이 없는 모델
        for (let i = 0; i < 2; i++) {
          chain[i].dir.subVectors(chain[i + 1].rest, chain[i].rest);
          chain[i].len = chain[i].dir.length();
          chain[i].dir.normalize();
        }
        const tip = tipOf(chain[2], chain[1]);
        chain[2].len = tip.length();
        chain[2].dir.copy(tip).normalize();
        const fg = {
          lm: def.lm, chain, thumb: !!def.thumb, k: FINGERS.indexOf(def) - 1,
          off0: new THREE.Vector3().subVectors(chain[0].rest, hand.rest),
          off1: new THREE.Vector3().subVectors(chain[1].rest, chain[0].rest),
          off2: new THREE.Vector3().subVectors(chain[2].rest, chain[1].rest),
          tip,
          H: new THREE.Vector3(),
          rest: [0, 0, 0],            // 기본 자세에서 이미 굽어 있는 각
          tgt: [0, 0, 0, 0],          // 목표: [벌림, 첫 마디, 둘째 마디, 끝 마디] / 엄지: [-, -, MCP, IP]
          ang: [0, 0, 0, 0],          // 부드럽게 따라가는 값
          L: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()], // 손 기준 각 마디 회전
          // 엄지 전용
          Q0inv: new THREE.Quaternion(), qcT: new THREE.Quaternion(), qc: new THREE.Quaternion(),
          cpt: new THREE.Vector3(), flexD: new THREE.Vector3(), al: 0, ep: 0,
          pw: 0, pd: 0,                // 엄지 끝과 닿는 정도·거리 (좌표 기준)
        };
        const d0 = chain[0].dir;
        if (fg.thumb) {
          // 엄지가 굽는 쪽: 약지·새끼 뿌리(손바닥 조금 앞)를 향한다
          if (ring && little) fg.cpt.addVectors(ring.rest, little.rest).multiplyScalar(0.5);
          else fg.cpt.copy(hand.rest).addScaledVector(arm.f0, fwd0.length() * 0.7).addScaledVector(arm.a0, -0.3 * width);
          fg.cpt.addScaledVector(arm.pn0, 0.3 * width).sub(hand.rest); // 손목 기준
          const flex0 = perp(new THREE.Vector3().copy(fg.cpt).add(hand.rest).sub(chain[1].rest), d0).normalize();
          basisQuat(fg.Q0inv, d0, flex0).invert();
          fg.H.crossVectors(d0, flex0).normalize();
        } else {
          fg.H.crossVectors(d0, arm.pn0).normalize();
          fg.rest[0] = Math.asin(clamp(d0.dot(arm.pn0), -1, 1));
        }
        fg.rest[1] = signedAngle(chain[0].dir, chain[1].dir, fg.H);
        fg.rest[2] = signedAngle(chain[1].dir, chain[2].dir, fg.H);
        arm.fingers.push(fg);
      }
      arm.thumb = arm.fingers.find((f) => f.thumb) || null;
      arm.nonThumb = arm.fingers.filter((f) => !f.thumb);
      this.arms[side] = arm;
    }

    // 얼굴 기준점 (머리 본 기준): 눈 사이, 입
    const head = bones.head;
    const eyeMid = new THREE.Vector3();
    let eyeSep;
    if (bones.leftEye && bones.rightEye) {
      eyeMid.addVectors(bones.leftEye.rest, bones.rightEye.rest).multiplyScalar(0.5);
      eyeSep = bones.leftEye.rest.distanceTo(bones.rightEye.rest);
      eyeMid.z += eyeSep * 0.35; // 눈알 중심 → 얼굴 표면
    } else {
      eyeMid.copy(head.rest).add(new THREE.Vector3(0, 0.07 * s, 0.09 * s));
      eyeSep = 0.065 * s;
    }
    this.faceWidth = 0;
    this._faceMeshes = new Set();
    let mouth = this._findMouth();
    const guess = eyeMid.clone().add(new THREE.Vector3(0, -1.0 * eyeSep, 0.1 * eyeSep));
    const found = !!mouth;
    if (!mouth || Math.abs(mouth.x - eyeMid.x) > eyeSep || mouth.y > eyeMid.y - 0.3 * eyeSep
      || mouth.y < eyeMid.y - 3 * eyeSep || Math.abs(mouth.z - eyeMid.z) > 2 * eyeSep) mouth = guess;
    else if (found) eyeMid.z = Math.max(eyeMid.z, mouth.z - 0.2 * eyeSep); // 눈은 입보다 조금 뒤
    this.eyeSep = eyeSep;
    this.eyeOff = eyeMid.sub(head.rest);
    this.mouthOff = mouth.sub(head.rest);

    const foot = bones.leftToes || bones.leftFoot;
    this.floorY = foot ? foot.rest.y - 0.09 * s : bones.hips.rest.y - 3.4;

    // 몸 모양 (충돌용): 메시에서 재고, 실패하면 기본 체형
    if (!shapeCache) {
      try { shapeCache = measureShape(this); } catch (err) {
        console.warn('[avatar] 몸 모양을 재지 못해 기본 체형을 씁니다:', err);
      }
      if (!shapeCache) shapeCache = this._defaultShape();
    }
    this.shape = shapeCache;
    for (const arm of Object.values(this.arms)) {
      const sh = this.shape;
      arm.prad[0] = sh.laR * 0.5;
      arm.prad[1] = sh.palmT; arm.prad[2] = sh.palmT * 0.9; arm.prad[3] = sh.palmT * 0.9;
      let n = 4;
      for (const fg of arm.fingers) {
        arm.prad[n++] = fg.thumb ? sh.fingerR : sh.palmT * 0.85;
        arm.prad[n++] = sh.fingerR; arm.prad[n++] = sh.fingerR; arm.prad[n++] = sh.fingerR * 0.9;
      }
      arm.npts = n;
    }

    // 쓸 수 있는 표정
    const em = vrm.expressionManager;
    this.has = {};
    for (const n of ['aa', 'ou', 'happy', 'sad', 'angry', 'surprised', 'blink', 'blinkLeft', 'blinkRight']) {
      this.has[n] = !!(em && em.getExpression(n));
    }

    this._t = {
      Ls: new THREE.Vector3(), Rs: new THREE.Vector3(), Le: new THREE.Vector3(), Re: new THREE.Vector3(),
      Lw: new THREE.Vector3(), Rw: new THREE.Vector3(),
      hl: vecs(21), hr: vecs(21), hq: vecs(21),
      v: vecs(12), q: Array.from({ length: 8 }, () => new THREE.Quaternion()),
      Dtop: new THREE.Quaternion(), Dhead: new THREE.Quaternion(),
      Md: new THREE.Vector3(), Ed: new THREE.Vector3(), Ma: new THREE.Vector3(), Ea: new THREE.Vector3(),
      hx: new THREE.Vector3(1, 0, 0), eyeSepD: 0.17, faceWD: 0.45,
      corr: new THREE.Vector3(),
    };
  }

  // 메시를 잴 수 없을 때 쓰는 기본 체형
  _defaultShape() {
    const n = 36, dy = 0.07;
    const pr = {
      yTop: 0.12, dy, n, cap: 0.14,
      cx: new Float32Array(n), hx: new Float32Array(n).fill(0.42), cz: new Float32Array(n).fill(0.02), hz: new Float32Array(n).fill(0.22),
    };
    const eye = this.eyeOff, mouth = this.mouthOff;
    const fh = Math.max(0.05, eye.y - mouth.y);
    const rx = this.faceWidth ? this.faceWidth / 2 : this.eyeSep * 1.3;
    return {
      profile: pr, neckR: 0.11, uaR: 0.1, laR: 0.08, palmT: 0.03, fingerR: 0.022,
      head: { c: new THREE.Vector3(eye.x, eye.y + fh * 0.3, mouth.z - rx * 1.05), r: new THREE.Vector3(rx, fh * 2.3, rx * 1.1) },
    };
  }

  // 'aa'(입 벌림) 모프가 움직이는 꼭짓점들의 중심 = 입 위치
  _findMouth() {
    try {
      const ex = this.vrm.expressionManager?.getExpression('aa');
      const binds = ex?.binds || ex?._binds || [];
      const sum = new THREE.Vector3();
      const v = new THREE.Vector3();
      let total = 0;
      let minX = Infinity, maxX = -Infinity;
      for (const bind of binds) {
        if (bind.index === undefined || !bind.primitives) continue;
        for (const mesh of bind.primitives) {
          const pos = mesh.geometry.getAttribute('position');
          const morph = mesh.geometry.morphAttributes.position?.[bind.index];
          if (!pos || !morph) continue;
          this._faceMeshes.add(mesh);
          const rel = mesh.geometry.morphTargetsRelative;
          for (let i = 0; i < pos.count; i++) {
            let dx = morph.getX(i), dy = morph.getY(i), dz = morph.getZ(i);
            if (!rel) { dx -= pos.getX(i); dy -= pos.getY(i); dz -= pos.getZ(i); }
            const w = dx * dx + dy * dy + dz * dz;
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (w < 1e-10) continue;
            sum.addScaledVector(v, w);
            total += w;
          }
        }
      }
      if (total <= 0) return null;
      if (maxX > minX) this.faceWidth = maxX - minX; // 얼굴 메시의 너비
      sum.divideScalar(total);
      sum.z += 0.012 * this.scale; // 입 안쪽 꼭짓점 쪽으로 치우치므로 표면 쪽으로 조금
      return sum;
    } catch { return null; }
  }

  // 풀에서 다시 꺼낼 때
  _reset() {
    this.mirror = false;
    this._base = null;
    this._last = 0;
    for (const k of Object.keys(this._expr)) this._expr[k] = 0;
    this._springReset = true;
    this._snapNext = true;
  }

  // 새 클립: 첫 프레임의 얼굴을 중립 표정으로 삼는다
  setClip(clip) {
    this._base = null;
    this._springReset = true;
    this._snapNext = true;
    const f = clip?.frames?.[0];
    if (f && f.face && f.face.length >= FACE_COUNT) this._base = this._faceMetrics(f.face);
  }

  setColors() { /* 아바타는 자기 색을 쓴다 */ }

  // 마지막 update()에서 아바타 손바닥이 놓인 자리 (side: 아바타 기준 'left' | 'right')
  handCenter(side, out) {
    const arm = this.arms[side];
    const k = this.bones[`${side}MiddleProximal`];
    out.copy(arm.hand.pos);
    if (k) out.lerp(k.pos, 0.6);
    return out;
  }

  // 본 하나의 월드 회전(기본 자세 대비)을 정하고 위치를 갱신한다
  _set(b, D) {
    b.D.copy(D);
    const p = b.parent;
    const q = b.node.quaternion.copy(b.R0pInv);
    if (p) {
      q.multiply(_qi.copy(p.D).invert());
      b.pos.copy(b.off).applyQuaternion(p.D).add(p.pos);
    } else {
      b.pos.copy(b.rest);
    }
    q.multiply(D).multiply(b.R0);
  }

  // 목표를 부드럽게 따라갈 때의 비율 (tau: 따라붙는 데 걸리는 시간, 초)
  _k(tau) { return this._snap ? 1 : 1 - Math.exp(-this._dt / tau); }
  // 값 하나를 따라가게 한다 (rate: 초당 최대 변화량)
  _follow(cur, target, tau, rate) {
    if (this._snap) return target;
    const lim = rate * this._dt;
    return cur + clamp((target - cur) * this._k(tau), -lim, lim);
  }

  update(frame) {
    if (!frame || !frame.pose) return;
    const now = performance.now();
    const gap = this._last ? (now - this._last) / 1000 : -1;
    const dt = Math.min(0.1, Math.max(0, gap));
    this._last = now;

    const T = this._t;
    const m = this.mirror;
    const sx = m ? -1 : 1;
    const pose = frame.pose;
    const P = (i, out) => out.set(sx * pose[i][0], pose[i][1], pose[i][2]);
    // 거울 모드: x를 뒤집고 좌우를 맞바꾼다
    P(m ? 12 : 11, T.Ls); P(m ? 11 : 12, T.Rs);
    P(m ? 14 : 13, T.Le); P(m ? 13 : 14, T.Re);
    P(m ? 16 : 15, T.Lw); P(m ? 15 : 16, T.Rw);
    const rawL = m ? frame.right : frame.left;
    const rawR = m ? frame.left : frame.right;
    const fill = (raw, out) => {
      if (!raw || raw.length < 21) return null;
      for (let i = 0; i < 21; i++) out[i].set(sx * raw[i][0], raw[i][1], raw[i][2]);
      return out;
    };
    const handL = fill(rawL, T.hl);
    const handR = fill(rawR, T.hr);
    const face = frame.face && frame.face.length >= FACE_COUNT ? frame.face : null;

    // 처음·클립 교체·거울 전환·위치 건너뛰기 때는 필터를 거치지 않고 바로 맞춘다
    const jump = T.Lw.distanceToSquared(this._dataL) > 0.36 || T.Rw.distanceToSquared(this._dataR) > 0.36;
    this._snap = this._snapNext || gap < 0 || gap > 0.3 || this._mirrorPrev !== m || jump;
    this._snapNext = false;
    this._mirrorPrev = m;
    this._dt = dt;
    this._dataL.copy(T.Lw); this._dataR.copy(T.Rw);

    const B = this.bones;
    const [v0, , v2] = T.v;
    const [q0, q1] = T.q;
    const L = this.arms.left, R = this.arms.right;

    // 숨쉬기·작은 흔들림: 모든 뷰어가 같은 시계를 쓰므로 서로 어긋나지 않는다
    const time = now / 1000;
    const breath = Math.sin(time * 1.45);
    const sway1 = Math.sin(time * 0.71 + 1.0), sway2 = Math.sin(time * 0.43 + 2.2);

    // ----- 몸통: 어깨선 방향 + 손을 뻗는 쪽으로 살짝 따라가기 -----
    v0.subVectors(T.Ls, T.Rs);
    if (v0.lengthSq() < 1e-8) v0.copy(X);
    basisQuat(q0, v0, Y);
    const reachF = (w, sign) => smooth(0.6, 1.3, w.z) + 0.5 * smooth(0, 0.7, -sign * w.x) * smooth(0.2, 0.6, w.z);
    const fL = reachF(T.Lw, 1), fR = reachF(T.Rw, -1);
    _eul.set(
      0.05 * Math.min(fL, fR) - 0.006 * breath,
      0.09 * (fR - fL) + 0.006 * sway2,
      0.005 * sway1,
      'YXZ',
    );
    q0.premultiply(q1.setFromEuler(_eul));
    this.qTorso.slerp(q0, this._k(0.09));
    this._set(B.hips, IDENT);
    T.Dtop.identity();
    for (const b of this.torso) {
      q1.copy(IDENT).slerp(this.qTorso, b.weight);
      this._set(b, q1);
      T.Dtop.copy(q1);
    }

    // ----- 머리 -----
    this._headRotation(face, pose, sx, m, T.Dhead);
    _eul.set(0.008 * Math.sin(time * 0.9 + 0.5) + 0.004 * breath, 0.012 * sway2, 0.006 * sway1, 'YXZ');
    T.Dhead.multiply(q1.setFromEuler(_eul));
    this.qHead.slerp(T.Dhead, this._k(0.06));
    T.Dhead.copy(this.qHead);
    if (B.neck) { q1.copy(T.Dtop).slerp(T.Dhead, 0.45); this._set(B.neck, q1); }
    this._set(B.head, T.Dhead);
    if (B.leftEye) this._set(B.leftEye, T.Dhead);
    if (B.rightEye) this._set(B.rightEye, T.Dhead);

    // ----- 어깨 위치 (쇄골은 아직 돌리지 않은 상태) -----
    for (const arm of [L, R]) {
      if (arm.shoulder) this._set(arm.shoulder, T.Dtop);
      const p = arm.upper.parent;
      arm.upper.pos.copy(arm.upper.off).applyQuaternion(p.D).add(p.pos);
    }

    // 어깨 중점이 좌표의 어깨 중점에 오도록 전체를 옮긴다 (숨 쉴 때 아주 조금 오르내린다)
    const shift = v2.addVectors(T.Ls, T.Rs).multiplyScalar(0.5)
      .addScaledVector(L.upper.pos, -0.5).addScaledVector(R.upper.pos, -0.5);
    shift.y += 0.004 * breath;
    for (const b of this.core) b.pos.add(shift);
    for (const arm of [L, R]) {
      arm.shoulder?.pos.add(shift);
      arm.upper.pos.add(shift);
    }
    this.container.position.copy(this.basePos).add(shift);

    // 얼굴 기준점: 좌표(Md, Ed)와 아바타(Ma, Ea)
    T.Ma.copy(this.mouthOff).applyQuaternion(T.Dhead).add(B.head.pos);
    T.Ea.copy(this.eyeOff).applyQuaternion(T.Dhead).add(B.head.pos);
    T.hx.copy(X).applyQuaternion(T.Dhead);

    // ----- 손: 방향·손가락·손목 목표 -----
    if (this._snap) { L.valid = false; R.valid = false; }
    this._hand(L, T.Lw, handL);
    this._hand(R, T.Rw, handR);

    // ----- 충돌: 두 손끼리, 손과 몸(몸통·목·머리·반대쪽 팔) -----
    for (let it = 0; it < 2; it++) {
      this._separateHands(L, R);
      this._resolveHand(L, R);
      this._resolveHand(R, L);
    }

    // ----- 팔 (쇄골 → 2관절 IK → 손목) -----
    this._arm(L, T.Ls, T.Le, handL ? handL[0] : T.Lw, breath);
    this._arm(R, T.Rs, T.Re, handR ? handR[0] : T.Rw, breath);
    L.valid = true; R.valid = true;
    // 손목 한계에 걸려 손 방향이 바뀐 팔은, 바뀐 방향으로 손을 다시 놓고(손바닥 중심은 제자리) 충돌·IK를 한 번 더 한다
    if (L.clamped || R.clamped) {
      const snap0 = this._snap, dt0 = this._dt;
      this._snap = false; this._dt = 0; // 필터는 그대로 둔다
      for (const arm of [L, R]) {
        if (!arm.clamped) continue;
        const left = arm === L;
        tA.copy(arm.knuckleOff).applyQuaternion(arm.qHand);
        tB.copy(arm.knuckleOff).applyQuaternion(arm.hand.D);
        arm.Wc.copy(arm.Wf).add(tA).sub(tB);
        this._handFK(arm, arm.hand.D);
        this._resolveHand(arm, left ? R : L);
        if (left) this._arm(L, T.Ls, T.Le, handL ? handL[0] : T.Lw, breath);
        else this._arm(R, T.Rs, T.Re, handR ? handR[0] : T.Rw, breath);
      }
      this._snap = snap0; this._dt = dt0;
    }

    // ----- 표정 -----
    this._expressions(face, m, dt);

    // 자세가 한 번에 크게 바뀌면(처음·클립 교체·위치 이동) 스프링 본이 몸에 걸려 늘어지므로 다시 시작한다
    const hl = L.hand.pos, hr = R.hand.pos;
    if (hl.distanceToSquared(this._prevL) > 0.16 || hr.distanceToSquared(this._prevR) > 0.16) this._springReset = true;
    this._prevL.copy(hl); this._prevR.copy(hr);
    const sm = this.vrm.springBoneManager;
    if (this._springReset && sm) {
      this._springReset = false;
      this.vrm.humanoid.update();
      this.group.updateMatrixWorld(true);
      sm.reset();
    }

    this.vrm.update(dt);
  }

  // 머리 회전 + 얼굴 기준점(좌표 쪽)
  _headRotation(face, pose, sx, m, out) {
    const T = this._t;
    const [a, b, c, d] = [T.v[3], T.v[4], T.v[5], T.v[6]];
    if (face) {
      const o = FACE.oval.start;
      const fp = (i, o2) => o2.set(sx * face[i][0], face[i][1], face[i][2]);
      fp(o + (m ? OVAL_R : OVAL_L), a).sub(fp(o + (m ? OVAL_L : OVAL_R), b)); // 옆
      fp(o + OVAL_TOP, c).sub(fp(o + OVAL_CHIN, d));                           // 위
      T.faceWD = a.length();
      if (a.lengthSq() > 1e-8 && c.lengthSq() > 1e-8) basisQuat(out, a, c); else out.copy(T.Dtop);
      const le = this._mean(face, FACE.leftEye, sx, a);
      const re = this._mean(face, FACE.rightEye, sx, b);
      T.eyeSepD = le.distanceTo(re);
      T.Ed.addVectors(le, re).multiplyScalar(0.5);
      this._mean(face, FACE.outerLips, sx, T.Md);
    } else {
      const Pp = (i, o2) => o2.set(sx * pose[i][0], pose[i][1], pose[i][2]);
      Pp(m ? 8 : 7, a); Pp(m ? 7 : 8, b);
      c.addVectors(a, b).multiplyScalar(0.5);
      Pp(0, d).sub(c);         // 귀 중점 → 코
      a.sub(b);                // 옆
      T.faceWD = a.length();
      if (a.lengthSq() > 1e-8 && d.lengthSq() > 1e-8) {
        c.crossVectors(d, a);  // 위
        basisQuat(out, a, c);
        out.multiply(T.q[2].setFromAxisAngle(X, -NO_FACE_PITCH));
      } else out.copy(T.Dtop);
      Pp(2, a); Pp(5, b);
      T.eyeSepD = Math.max(0.05, a.distanceTo(b) * 1.1);
      T.Ed.addVectors(a, b).multiplyScalar(0.5);
      Pp(9, a); Pp(10, b);
      T.Md.addVectors(a, b).multiplyScalar(0.5);
    }
  }

  _mean(face, g, sx, out) {
    out.set(0, 0, 0);
    for (let i = g.start; i < g.end; i++) { out.x += face[i][0]; out.y += face[i][1]; out.z += face[i][2]; }
    out.multiplyScalar(1 / (g.end - g.start));
    out.x *= sx;
    return out;
  }

  // 얼굴 근처의 점 p를 아바타 얼굴 비율에 맞게 옮기는 보정량 (얼굴에서 멀면 0)
  _faceCorrection(p, out) {
    const T = this._t;
    const u = T.v[7].subVectors(T.Ed, T.Md);
    const len2 = Math.max(1e-6, u.lengthSq());
    const rel = T.v[8].subVectors(p, T.Md);
    const t = Math.min(1.8, Math.max(-0.8, rel.dot(u) / len2));
    // 좌표 쪽 기준점 → 아바타 쪽 기준점
    const da = T.v[9].copy(T.Md).addScaledVector(u, t);
    out.copy(T.Ma).lerp(T.Ea, t).sub(da);
    // 좌우: 얼굴 너비 비율
    const lat = T.v[8].subVectors(p, da).dot(T.hx);
    const k = this.faceWidth ? Math.min(2, Math.max(0.8, this.faceWidth / Math.max(0.1, T.faceWD))) : 1;
    out.addScaledVector(T.hx, lat * (k - 1));
    const center = T.v[9].addVectors(T.Md, T.Ed).multiplyScalar(0.5);
    return 1 - smooth(0.45, 1.15, p.distanceTo(center));
  }


  // ---------- 손 ----------
  // 손의 방향(손바닥 기준틀)·손가락 각도·손목 목표 위치를 구한다
  _hand(arm, W_pose, hand) {
    const T = this._t;
    const [v0, v1, v2, , , , , , , , , v11] = T.v;
    let have = false;
    if (hand) {
      v0.subVectors(hand[9], hand[0]);
      v1.subVectors(hand[5], hand[17]);
      if (v0.lengthSq() > 1e-8 && v2.crossVectors(v0, v1).lengthSq() > 1e-12) {
        basisQuat(arm.DhRaw, v0, v1).multiply(arm.handQ0inv);
        have = true;
      }
    }
    arm.have = have;

    const Wt = tA;
    if (have) {
      // 얼굴 보정: 손의 여러 점에서 구해 얼굴에 가까운 점일수록 크게 반영
      const corr = T.corr.set(0, 0, 0);
      let wsum = 0;
      const center = v0.addVectors(T.Md, T.Ed).multiplyScalar(0.5);
      for (const i of [0, 4, 8, 9, 12, 16, 20]) {
        const d2 = hand[i].distanceToSquared(center);
        const w = 1 / (d2 * d2 + 0.002);
        const f = this._faceCorrection(hand[i], v11);
        corr.addScaledVector(v11, w * f);
        wsum += w;
      }
      corr.multiplyScalar(1 / wsum);
      // 중지 뿌리가 좌표의 그 자리에 오도록 손목 목표를 정한다
      Wt.copy(arm.knuckleOff).applyQuaternion(arm.DhRaw).negate().add(hand[9]).add(corr);
      arm.qHand.slerp(arm.DhRaw, this._k(0.03));
      this._fingerTargets(arm, hand);
    } else {
      const f = this._faceCorrection(W_pose, v11);
      Wt.copy(W_pose).addScaledVector(v11, f);
      this._relaxTargets(arm);
    }
    arm.Wf.lerp(Wt, this._k(0.025));
    arm.Wc.copy(arm.Wf);

    // 손가락 각도: 부드럽게 따라가되 각속도를 제한한다 (떨림 제거)
    const tau = have ? 0.035 : 0.16;
    for (const fg of arm.fingers) {
      for (let i = fg.thumb ? 2 : 0; i < 4; i++) fg.ang[i] = this._follow(fg.ang[i], fg.tgt[i], tau, 32);
      if (fg.thumb) fg.qc.slerp(fg.qcT, this._k(tau));
    }
    this._handFK(arm, arm.qHand);
  }

  // 손 좌표 → 손가락 관절 각도 (손 기준틀 안에서 해부학적 범위로)
  _fingerTargets(arm, hand) {
    const hq = this._t.hq;
    const { f0, a0, pn0, hinge0 } = arm;
    // 모든 점을 아바타 손의 기본 자세 축으로 옮긴다 (손목 = 원점)
    qA.copy(arm.DhRaw).invert();
    for (let i = 0; i < 21; i++) hq[i].subVectors(hand[i], hand[0]).applyQuaternion(qA);
    const s1 = tB, s2 = tC, s3 = tD, H = tE;

    for (const fg of arm.fingers) {
      const [i0, i1, i2, i3] = fg.lm;
      s1.subVectors(hq[i1], hq[i0]);
      s2.subVectors(hq[i2], hq[i1]);
      s3.subVectors(hq[i3], hq[i2]);
      if (s1.lengthSq() < 1e-10 || s2.lengthSq() < 1e-10 || s3.lengthSq() < 1e-10) continue; // 못 믿을 값: 이전 목표 유지
      s1.normalize(); s2.normalize(); s3.normalize();

      if (!fg.thumb) {
        const k = fg.k;
        const sf = s1.dot(f0), sa = s1.dot(a0), sp = s1.dot(pn0);
        const inPlane = Math.hypot(sf, sa);
        // 첫 마디: 손바닥 쪽으로 굽힘
        const mcp = clamp(Math.atan2(sp, sf >= 0 ? inPlane : -inPlane), MCP_MIN, MCP_MAX);
        // 벌림: 손가락을 펼수록 믿을 수 있고, 굽힐수록 줄어든다
        const lat = Math.atan2(sa, Math.abs(sf) + 1e-6);
        const wl = smooth(0.25, 0.6, inPlane) * (1 - smooth(50 * DEG, 85 * DEG, mcp));
        fg.tgt[0] = clamp(lat - FAN[k], -SPREAD_MAX, SPREAD_MAX) * wl;
        fg.tgt[1] = mcp;
        // 둘째·셋째 마디: 경첩. 옆으로 꺾이거나 뒤로 젖혀지지 않는다
        perp(H.copy(hinge0), s1).normalize();
        const pip = clamp(signedAngle(s1, s2, H), 0, PIP_MAX);
        perp(H.copy(hinge0), s2).normalize();
        const dip = clamp(signedAngle(s2, s3, H), 0, DIP_MAX);
        fg.tgt[2] = pip;
        fg.tgt[3] = clamp(0.5 * dip + 0.5 * DIP_COUPLE * pip, 0, DIP_MAX);
      } else {
        // 엄지 첫 뼈의 방향 (범위 안으로)
        let alpha = clamp(Math.atan2(s1.dot(a0), s1.dot(f0)), TH_ALPHA[0], TH_ALPHA[1]);
        let eps = clamp(Math.asin(clamp(s1.dot(pn0), -1, 1)), TH_EPS[0], TH_EPS[1]);
        // 굽는 쪽: 기본은 약지·새끼 뿌리 쪽, 충분히 굽었으면 좌표가 가리키는 쪽을 따른다
        const def = tF.addVectors(hq[13], hq[17]).multiplyScalar(0.5)
          .addScaledVector(pn0, 0.3 * hq[5].distanceTo(hq[17])).sub(hq[i1]);
        perp(def, s1).normalize();
        const mv = tG.subVectors(hq[i3], hq[i1]);
        const ml = mv.length();
        perp(mv, s1);
        const bend = mv.length() / Math.max(1e-6, ml);
        if (bend > 1e-3) mv.normalize();
        const w = 0.85 * smooth(0.2, 0.5, bend) * smooth(-0.3, 0.2, mv.dot(def));
        const flexD = def.multiplyScalar(1 - w).addScaledVector(mv, w).normalize();
        H.crossVectors(s1, flexD).normalize();
        const mcp = clamp(signedAngle(s1, s2, H), TH_MCP[0], TH_MCP[1]);
        perp(H, s2).normalize();
        const ip = clamp(signedAngle(s2, s3, H), TH_IP[0], TH_IP[1]);
        // 손바닥을 가로질러 굽을 때는 엄지가 손바닥 앞으로 나와 있어야 한다 (손바닥을 뚫지 않게)
        const crossing = smooth(20 * DEG, 70 * DEG, mcp + ip) * smooth(0.1, -0.4, flexD.dot(a0));
        eps = Math.max(eps, lerp(TH_EPS[0], 24 * DEG, crossing));
        if (flexD.dot(pn0) < -0.1) { flexD.addScaledVector(pn0, -0.1 - flexD.dot(pn0)).normalize(); }
        fg.flexD.copy(flexD);
        fg.al = alpha; fg.ep = eps;
        this._thumbBase(arm, fg, alpha, eps, fg.flexD);
        fg.tgt[2] = mcp;
        fg.tgt[3] = ip;
      }
    }
    this._pinch(arm, hq);
    // 손가락끼리 엇갈려 겹치지 않게 (중지를 기준으로 순서 유지)
    const fs = arm.nonThumb;
    if (fs.length === 4) {
      const gap = 0.03;
      fs[0].tgt[0] = Math.max(fs[0].tgt[0], fs[1].tgt[0] - gap);
      fs[2].tgt[0] = Math.min(fs[2].tgt[0], fs[1].tgt[0] + gap);
      fs[3].tgt[0] = Math.min(fs[3].tgt[0], fs[2].tgt[0] + gap);
    }
  }

  // 손가락 끝 위치 (손 기본 축, 손목 기준). p: [벌림, 첫 마디, 둘째, 끝] / 엄지: [alpha, eps, MCP, IP]
  _tipLocal(arm, fg, p, out) {
    if (fg.thumb) { this._thumbBase(arm, fg, p[0], p[1], fg.flexD); qA.copy(fg.qcT); }
    else qA.setFromAxisAngle(arm.pn0, arm.sign * p[0]).multiply(qB.setFromAxisAngle(fg.H, p[1] - fg.rest[0]));
    out.copy(fg.off1).applyQuaternion(qA).add(fg.off0);
    qA.multiply(qB.setFromAxisAngle(fg.H, p[2] - fg.rest[1]));
    out.add(tP.copy(fg.off2).applyQuaternion(qA));
    qA.multiply(qB.setFromAxisAngle(fg.H, p[3] - fg.rest[2]));
    return out.add(tP.copy(fg.tip).applyQuaternion(qA));
  }

  // 엄지 끝과 손가락 끝이 맞닿는 손모양(ㅇ, 집게, 모은 손 등).
  // 아바타는 손가락 비율이 사람과 달라 각도만 옮기면 끝이 어긋나므로, 좌표에서 닿아 있는 만큼
  // 아바타의 손끝도 닿도록 각도를 (가동 범위 안에서) 조금 고친다.
  _pinch(arm, hq) {
    const th = arm.thumb;
    const size = hq[9].length();
    if (!th || size < 1e-4) return;
    const scale = arm.knuckleOff.length() / size;
    let wMax = 0, wSum = 0;
    pC.set(0, 0, 0);
    for (const fg of arm.nonThumb) {
      const d = hq[fg.lm[3]].distanceTo(hq[4]);
      fg.pw = 1 - smooth(0.14, 0.36, d / size);
      fg.pd = d * scale;
      if (fg.pw <= 0) continue;
      pC.addScaledVector(this._tipLocal(arm, fg, fg.tgt, pTip), fg.pw);
      wSum += fg.pw;
      wMax = Math.max(wMax, fg.pw);
    }
    if (wSum <= 0) return;
    pC.multiplyScalar(1 / wSum);
    const R = this.shape.fingerR;

    // 엄지: 닿는 손가락 끝들의 중심 쪽으로 절반쯤 마중 나간다
    const p = _pp, o = _po, lo = _plo, hi = _phi;
    o[0] = th.al; o[1] = th.ep; o[2] = th.tgt[2]; o[3] = th.tgt[3];
    const lim = [TH_ALPHA, TH_EPS, TH_MCP, TH_IP];
    for (let i = 0; i < 4; i++) { p[i] = o[i]; lo[i] = Math.max(lim[i][0], o[i] - 0.5); hi[i] = Math.min(lim[i][1], o[i] + 0.5); }
    lo[1] = Math.max(lo[1], Math.min(o[1], 0)); // 손바닥 뒤로는 넘어가지 않게
    this._tipLocal(arm, th, p, pT);
    pGoal.copy(pT).lerp(pC, 0.5);
    const reg = (q) => 0.004 * ((q[0] - o[0]) ** 2 + (q[1] - o[1]) ** 2 + (q[2] - o[2]) ** 2 + (q[3] - o[3]) ** 2);
    descend(p, lo, hi, 4, (q) => this._tipLocal(arm, th, q, pTip).distanceToSquared(pGoal) + reg(q), 0.2, 7);
    for (let i = 0; i < 4; i++) p[i] = lerp(o[i], p[i], wMax);
    th.al = p[0]; th.ep = p[1]; th.tgt[2] = p[2]; th.tgt[3] = p[3];
    this._tipLocal(arm, th, p, pT); // qcT도 이 값으로 정해진다

    // 손가락: 끝이 엄지 끝에 닿도록 (끝 마디는 둘째 마디를 따라간다)
    for (const fg of arm.nonThumb) {
      if (fg.pw <= 0) continue;
      const goal = Math.max(R, fg.pd * 0.8);
      for (let i = 0; i < 4; i++) { o[i] = fg.tgt[i]; p[i] = o[i]; }
      lo[0] = Math.max(-SPREAD_MAX, o[0] - 0.25); hi[0] = Math.min(SPREAD_MAX, o[0] + 0.25);
      lo[1] = Math.max(MCP_MIN, o[1] - 0.6); hi[1] = Math.min(MCP_MAX, o[1] + 0.6);
      lo[2] = Math.max(0, o[2] - 0.6); hi[2] = Math.min(PIP_MAX, o[2] + 0.6);
      const dip0 = o[3], pip0 = o[2];
      const f = (q) => {
        q[3] = clamp(dip0 + DIP_COUPLE * (q[2] - pip0), 0, DIP_MAX);
        const e = this._tipLocal(arm, fg, q, pTip).distanceTo(pT) - goal;
        return e * e + 0.004 * ((q[0] - o[0]) ** 2 + (q[1] - o[1]) ** 2 + (q[2] - o[2]) ** 2);
      };
      descend(p, lo, hi, 3, f, 0.2, 7);
      p[3] = clamp(dip0 + DIP_COUPLE * (p[2] - pip0), 0, DIP_MAX);
      for (let i = 0; i < 4; i++) fg.tgt[i] = lerp(o[i], p[i], fg.pw);
    }
  }

  // 엄지 첫 뼈(중수골)의 목표 회전: 뼈 방향(alpha, eps) + 굽는 쪽(flexD, 손 기본 축 기준)
  _thumbBase(arm, fg, alpha, eps, flexD) {
    const { f0, a0, pn0 } = arm;
    const ce = Math.cos(eps);
    const dir = tH.set(0, 0, 0).addScaledVector(f0, ce * Math.cos(alpha)).addScaledVector(a0, ce * Math.sin(alpha))
      .addScaledVector(pn0, Math.sin(eps));
    // 굽는 쪽이 없으면 기본: 아바타 손의 약지·새끼 뿌리 쪽
    if (flexD) flexD = tF.copy(flexD);
    else flexD = tF.copy(fg.cpt).sub(fg.off0).addScaledVector(dir, -fg.chain[0].len);
    perp(flexD, dir);
    if (flexD.lengthSq() < 1e-8) flexD.copy(a0).negate();
    basisQuat(fg.qcT, dir, flexD).multiply(fg.Q0inv);
  }

  // 손 좌표가 없을 때: 힘을 뺀 자연스러운 손 모양
  _relaxTargets(arm) {
    for (const fg of arm.fingers) {
      if (fg.thumb) {
        this._thumbBase(arm, fg, TH_RELAX.alpha, TH_RELAX.eps, null);
        fg.tgt[2] = TH_RELAX.mcp; fg.tgt[3] = TH_RELAX.ip;
      } else {
        fg.tgt[0] = 0;
        fg.tgt[1] = RELAX_MCP[fg.k];
        fg.tgt[2] = RELAX_PIP[fg.k];
        fg.tgt[3] = RELAX_PIP[fg.k] * DIP_COUPLE;
      }
    }
  }

  // 손가락 각도 → 손 기준 회전(L)과 손목 기준 점들(pts). Dh: 손의 회전
  _handFK(arm, Dh) {
    const pts = arm.pts;
    pts[0].set(0, 0, 0);
    pts[1].copy(arm.palmC0).applyQuaternion(Dh);
    pts[2].copy(arm.edgeL0).applyQuaternion(Dh);
    pts[3].copy(arm.edgeT0).applyQuaternion(Dh);
    let n = 4;
    for (const fg of arm.fingers) {
      const [L0, L1, L2] = fg.L;
      if (fg.thumb) {
        L0.copy(fg.qc);
      } else {
        // 벌림(손바닥 수직축) 다음 굽힘(경첩축)
        L0.setFromAxisAngle(arm.pn0, arm.sign * fg.ang[0])
          .multiply(qA.setFromAxisAngle(fg.H, fg.ang[1] - fg.rest[0]));
      }
      L1.copy(L0).multiply(qA.setFromAxisAngle(fg.H, fg.ang[2] - fg.rest[1]));
      L2.copy(L1).multiply(qA.setFromAxisAngle(fg.H, fg.ang[3] - fg.rest[2]));
      const p0 = pts[n].copy(fg.off0).applyQuaternion(Dh);
      const p1 = pts[n + 1].copy(fg.off1).applyQuaternion(qA.copy(Dh).multiply(L0)).add(p0);
      const p2 = pts[n + 2].copy(fg.off2).applyQuaternion(qA.copy(Dh).multiply(L1)).add(p1);
      pts[n + 3].copy(fg.tip).applyQuaternion(qA.copy(Dh).multiply(L2)).add(p2);
      n += 4;
    }
  }

  // ---------- 충돌 ----------
  // 점 p(반지름 r)가 몸통에 들어가 있으면 밀어낼 벡터(out)와 깊이
  _torsoPush(p, r, out) {
    const owners = this.torsoOwners;
    // 먼저 맨 위 본 기준으로 높이를 가늠하고, 그 높이를 맡은 본 기준으로 다시 옮긴다
    let b = owners[0];
    tP.copy(p).sub(b.pos).applyQuaternion(_qi.copy(b.D).invert()).add(b.rest);
    let owner = owners[owners.length - 1];
    for (const o of owners) if (o.rest.y <= tP.y) { owner = o; break; }
    if (owner !== b) {
      b = owner;
      tP.copy(p).sub(b.pos).applyQuaternion(_qi.copy(b.D).invert()).add(b.rest);
    }
    const depth = profilePush(this.shape.profile, tP, r, out);
    if (depth > 0) out.applyQuaternion(b.D);
    return depth;
  }

  // 머리(타원체). 뒤로 치우친 중심에서 바깥으로 민다 → 얼굴 쪽 손은 얼굴 표면에 얹힌다
  _headPush(p, r, out) {
    const hd = this.bones.head, sh = this.shape.head;
    tP.copy(p).sub(hd.pos).applyQuaternion(_qi.copy(hd.D).invert()).sub(sh.c);
    const rx = sh.r.x + r, ry = sh.r.y + r, rz = sh.r.z + r;
    const F = (x, y, z) => (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
    if (F(tP.x, tP.y, tP.z) >= 1) return 0;
    const oz = -0.35 * rz;
    let dx = tP.x, dy = tP.y, dz = tP.z - oz;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) { dx = 0; dy = 0; dz = 1; len = 1; }
    let lo = 1, hi = 1 + 2 * (rx + ry + rz) / len;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (F(dx * mid, dy * mid, oz + dz * mid) < 1) lo = mid; else hi = mid;
    }
    out.set(dx, dy, dz).multiplyScalar(hi - 1).applyQuaternion(hd.D);
    return len * (hi - 1);
  }

  // 몸(몸통·목·머리) 가운데 가장 깊이 들어간 곳에서 밀어낸다
  _bodyPush(p, r, out) {
    let best = this._torsoPush(p, r, out);
    let d = this._headPush(p, r, tPush2);
    if (d > best) { best = d; out.copy(tPush2); }
    const B = this.bones;
    if (B.neck) {
      d = capsulePush(p, r, B.neck.pos, B.head.pos, this.shape.neckR, tPush2);
      if (d > best) { best = d; out.copy(tPush2); }
    }
    return best;
  }

  // 몸에 들어간 깊이만 (팔꿈치 방향 고르기용)
  _bodyDepth(p, r) { return this._bodyPush(p, r, tPush); }

  // 손(손목·손바닥·손가락 마디)이 몸이나 반대쪽 팔에 파묻히면 손 전체를 표면까지 밀어낸다
  _resolveHand(arm, other) {
    const sh = this.shape;
    for (let it = 0; it < 3; it++) {
      let best = 0;
      for (let i = 0; i < arm.npts; i++) {
        const p = tC.copy(arm.pts[i]).add(arm.Wc);
        const r = arm.prad[i] + SKIN;
        let d = this._bodyPush(p, r, tPush);
        if (d > best) { best = d; tD.copy(tPush); }
        if (other.valid) {
          // 지난 프레임의 반대쪽 팔 (위팔, 아래팔의 팔꿈치 쪽 85%)
          d = capsulePush(p, r, other.upper.pos, other.lower.pos, sh.uaR * 0.8, tPush);
          if (d > best) { best = d; tD.copy(tPush); }
          tE.copy(other.lower.pos).lerp(other.hand.pos, 0.85);
          d = capsulePush(p, r, other.lower.pos, tE, sh.laR * 0.8, tPush);
          if (d > best) { best = d; tD.copy(tPush); }
        }
      }
      if (best < 1e-4) break;
      arm.Wc.add(tD);
    }
  }

  // 두 손이 서로 파묻히지 않게 반씩 밀어낸다 (맞닿는 것은 허용)
  _separateHands(a, b) {
    for (let it = 0; it < 2; it++) {
      let best = 0;
      for (let i = 0; i < a.npts; i++) {
        const p = tC.copy(a.pts[i]).add(a.Wc);
        for (let j = 0; j < b.npts; j++) {
          const q = tE.copy(b.pts[j]).add(b.Wc);
          const min = (a.prad[i] + b.prad[j]) * 0.85;
          const d2 = p.distanceToSquared(q);
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2);
          if (min - d > best) {
            best = min - d;
            if (d > 1e-5) tD.subVectors(p, q).multiplyScalar(1 / d); else tD.set(a.sign, 0, 0);
          }
        }
      }
      if (best < 1e-4) break;
      a.Wc.addScaledVector(tD, best * 0.5);
      b.Wc.addScaledVector(tD, -best * 0.5);
    }
  }

  // ---------- 팔 ----------
  // 팔꿈치 각도 phi에서의 팔 자세 → aE(팔꿈치), aLo(아래팔 방향), aDu·aDl(위팔·아래팔 회전)
  _armPose(arm, S, dn, reach, p0, side, phi) {
    const { L1, L2 } = arm;
    aPole.copy(p0).multiplyScalar(Math.cos(phi)).addScaledVector(side, Math.sin(phi));
    const a = (L1 * L1 - L2 * L2 + reach * reach) / (2 * reach);
    const hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    aU.copy(dn).multiplyScalar(a).addScaledVector(aPole, hgt);      // 어깨 → 팔꿈치
    aE.copy(S).add(aU);
    aLo.copy(dn).multiplyScalar(reach).sub(aU).normalize();
    aUd.copy(aU).normalize();
    // 위팔: 방향 + 팔꿈치가 굽는 평면으로 비틀림 결정
    aBend.copy(aLo).addScaledVector(aUd, -aLo.dot(aUd));
    if (aBend.lengthSq() < 1e-4) aBend.copy(aPole).negate();
    basisQuat(aDu, aUd, aBend).multiply(arm.upperQ0inv);
    // 아래팔: 위팔에서 최소 회전으로 굽힌다 (비틀림은 나중에)
    tP.copy(arm.lowerDir0).applyQuaternion(aDu);
    aDl.setFromUnitVectors(tP, aLo).multiply(aDu);
  }

  // 지금 팔 자세(aLo, aDl)에서 손 회전 Dh가 요구하는 손목 꺾임과 아래팔 회전 → aW
  _wristMetrics(arm, Dh) {
    // 손 기준틀에서 본 아래팔 방향
    tP.copy(aLo).applyQuaternion(_qi.copy(Dh).invert());
    const lf = tP.dot(arm.f0), la = tP.dot(arm.a0), lp = tP.dot(arm.pn0);
    aW.flex = Math.atan2(lp, lf);
    aW.dev = Math.asin(clamp(la, -1, 1));
    // 아래팔 회전: 손바닥 가로 방향을 아래팔 축 둘레에서 비교 (T자세 = 손바닥 아래 = 0)
    const cNo = tP.copy(arm.across0).applyQuaternion(aDl);
    const c1 = tPush.copy(arm.a0).applyQuaternion(Dh);
    perp(c1, aLo);
    aW.rel = c1.length();
    if (aW.rel > 1e-4) {
      c1.multiplyScalar(1 / aW.rel);
      const ang = Math.atan2(tPush2.crossVectors(cNo, c1).dot(aLo), cNo.dot(c1));
      aW.sup = -arm.sign * ang; // 손바닥을 위로 돌리는 쪽이 +
    } else aW.sup = 0;
  }

  _armCost(arm, S, dn, reach, p0, side, phi, hint) {
    this._armPose(arm, S, dn, reach, p0, side, phi);
    let c = ((phi - hint) / 0.7) ** 2;
    if (arm.have) {
      this._wristMetrics(arm, arm.qHand);
      const fe = Math.max(0, Math.abs(aW.flex) - WRIST_FLEX_SOFT);
      const de = Math.max(0, Math.abs(aW.dev) - WRIST_DEV_SOFT);
      let sup = aW.sup;
      if (sup < -100 * DEG) sup += 2 * Math.PI;
      const te = Math.max(0, SUP_SOFT[0] - sup, sup - SUP_SOFT[1]) * smooth(0.05, 0.4, aW.rel);
      c += 5 * fe * fe + 6 * de * de + 2.5 * te * te;
    }
    // 팔꿈치·아래팔·위팔이 몸을 뚫으면 큰 벌점
    const sh = this.shape;
    let pen = this._bodyDepth(aE, sh.uaR * 0.55);
    pen += this._bodyDepth(tC.copy(S).addScaledVector(aU, 0.6), sh.uaR * 0.45);
    tD.copy(aLo).multiplyScalar(arm.L2);
    pen += this._bodyDepth(tC.copy(aE).addScaledVector(tD, 0.33), sh.laR * 0.55);
    pen += this._bodyDepth(tC.copy(aE).addScaledVector(tD, 0.66), sh.laR * 0.5);
    if (pen > 0) c += 0.2 + 45 * pen;
    return c;
  }

  _arm(arm, S_data, E_data, W_data, breath) {
    const T = this._t;
    const Wc = arm.Wc;
    const Lm = arm.L1 + arm.L2;

    // ----- 쇄골: 손을 높이 들면 어깨가 올라가고, 몸 앞을 가로지르거나 멀리 뻗으면 앞으로 나온다 -----
    if (arm.shoulder) {
      const rel = tA.subVectors(Wc, arm.upper.pos);
      const dist0 = rel.length();
      const raise = 0.4 * smooth(-0.15, 0.85, rel.y / Lm);
      const prot = 0.3 * smooth(0.25, 0.9, -arm.sign * rel.x / Lm) * (rel.z > 0 ? 1 : 0.5)
        + 0.14 * smooth(0.78, 1.0, dist0 / Lm);
      arm.raise = this._follow(arm.raise, raise, 0.1, 4);
      arm.prot = this._follow(arm.prot, prot, 0.1, 4);
      qA.setFromAxisAngle(Z, arm.sign * (arm.raise + 0.008 * breath));
      qB.setFromAxisAngle(Y, -arm.sign * arm.prot);
      qT.copy(T.Dtop).multiply(qA).multiply(qB);
      this._set(arm.shoulder, qT);
      const p = arm.upper.parent;
      arm.upper.pos.copy(arm.upper.off).applyQuaternion(p.D).add(p.pos);
    }

    // ----- 2관절 IK -----
    const S = arm.upper.pos;
    const dn = tA.subVectors(Wc, S);
    let dist = dn.length();
    if (dist < 1e-5) { dn.set(0, -1, 0); dist = 1e-5; }
    dn.multiplyScalar(1 / dist);
    // 팔을 끝까지 뻗기 직전부터 부드럽게 멈춘다 (팔꿈치가 탁 펴지지 않게)
    const x = dist / Lm;
    let reach = x < 0.9 ? dist : Lm * (0.9 + 0.095 * (1 - Math.exp(-(x - 0.9) / 0.095)));
    reach = Math.max(reach, Math.abs(arm.L1 - arm.L2) + 1e-3);

    // 팔꿈치 각도의 기준(0): 아래·살짝 바깥·뒤. +로 갈수록 팔꿈치가 바깥(위)으로 돈다
    const p0 = perp(tB.set(arm.sign * 0.25, -1, -0.25), dn);
    if (p0.lengthSq() < 1e-6) p0.set(arm.sign, 0, 0);
    p0.normalize();
    const side = tF.crossVectors(dn, p0).multiplyScalar(arm.sign);

    // 참고값 1: 좌표의 팔꿈치가 어깨-손목 선에서 벗어난 쪽
    const line = tC.subVectors(W_data, S_data);
    const pole = tD.subVectors(E_data, S_data);
    const ll = line.lengthSq();
    if (ll > 1e-8) pole.addScaledVector(line, -pole.dot(line) / ll);
    const kd = smooth(0.03, 0.15, pole.length());
    perp(pole, dn);
    const phiD = clamp(Math.atan2(pole.dot(side), pole.dot(p0)), -0.4, 2.2);
    // 참고값 2: 사람의 자연스러운 팔꿈치 — 손이 몸 안쪽·위로 갈수록 바깥으로 들린다
    const phiN = 0.22 + 0.6 * smooth(-0.5, 0.6, -arm.sign * Wc.x) + 0.35 * smooth(-0.2, 0.7, Wc.y);
    const hint = lerp(phiN, phiD, 0.55 * kd);

    // 후보 각도마다 비용(참고값과의 차이 + 손목 무리 + 몸 뚫기)을 따져 가장 편한 각도를 고른다
    const step = (PHI_MAX - PHI_MIN) / (PHI_N - 1);
    let bi = 0;
    for (let i = 0; i < PHI_N; i++) {
      _cost[i] = this._armCost(arm, S, dn, reach, p0, side, PHI_MIN + i * step, hint);
      if (_cost[i] < _cost[bi]) bi = i;
    }
    let phi = PHI_MIN + bi * step;
    if (bi > 0 && bi < PHI_N - 1) {
      const c0 = _cost[bi - 1], c1 = _cost[bi], c2 = _cost[bi + 1];
      const den = c0 - 2 * c1 + c2;
      if (den > 1e-9) phi += clamp(0.5 * (c0 - c2) / den, -0.5, 0.5) * step;
    }
    arm.phi = this._follow(arm.phi, phi, 0.12, 7);
    this._armPose(arm, S, dn, reach, p0, side, arm.phi);
    this._set(arm.upper, aDu);

    // ----- 아래팔 비틀림과 손목 -----
    const Dh = qC;
    arm.clamped = false;
    if (arm.have) {
      Dh.copy(arm.qHand);
      this._wristMetrics(arm, Dh);
      // 손바닥 아래(0)~위(180°) 범위에서, 지난 값에 가까운 쪽으로 푼다 (±180° 근처에서 뒤집히지 않게)
      let sup = aW.sup, bestD = Infinity, pick = sup;
      for (const c of [sup - 2 * Math.PI, sup, sup + 2 * Math.PI]) {
        if (c < SUP_HARD[0] - 0.5 || c > SUP_HARD[1] + 0.5) continue;
        const d = this._snap ? Math.max(0, SUP_SOFT[0] - c, c - SUP_SOFT[1]) : Math.abs(c - arm.sup);
        if (d < bestD) { bestD = d; pick = c; }
      }
      sup = clamp(pick, SUP_HARD[0], SUP_HARD[1]) * smooth(0.05, 0.4, aW.rel);
      arm.sup = this._follow(arm.sup, sup, 0.03, 25);
      aDl.premultiply(qA.setFromAxisAngle(aLo, -arm.sign * arm.sup * FOREARM_TWIST));
      // 손목 한계를 넘으면 손을 한계까지만 꺾는다
      const flex = clamp(aW.flex, -WRIST_FLEX_HARD, WRIST_FLEX_HARD);
      const dev = clamp(aW.dev, -WRIST_DEV_HARD, WRIST_DEV_HARD);
      if (flex !== aW.flex || dev !== aW.dev) {
        arm.clamped = Math.abs(flex - aW.flex) + Math.abs(dev - aW.dev) > 0.03;
        const cd = Math.cos(dev);
        tP.set(0, 0, 0).addScaledVector(arm.f0, cd * Math.cos(flex)).addScaledVector(arm.a0, Math.sin(dev))
          .addScaledVector(arm.pn0, cd * Math.sin(flex)).applyQuaternion(Dh);
        Dh.premultiply(qA.setFromUnitVectors(tP, aLo));
      }
    } else {
      // 손 좌표가 없으면 아래팔을 따라 자연스럽게 둔다
      arm.sup = this._follow(arm.sup, 0, 0.15, 6);
      arm.qHand.slerp(aDl, this._k(0.08));
      Dh.copy(arm.qHand);
      // 아래팔에서 너무 벗어나 있으면(손 좌표가 막 사라졌을 때) 한계 안으로
      this._wristMetrics(arm, Dh);
      const flex = clamp(aW.flex, -WRIST_FLEX_HARD, WRIST_FLEX_HARD);
      const dev = clamp(aW.dev, -WRIST_DEV_HARD, WRIST_DEV_HARD);
      if (flex !== aW.flex || dev !== aW.dev) {
        const cd = Math.cos(dev);
        tP.set(0, 0, 0).addScaledVector(arm.f0, cd * Math.cos(flex)).addScaledVector(arm.a0, Math.sin(dev))
          .addScaledVector(arm.pn0, cd * Math.sin(flex)).applyQuaternion(Dh);
        Dh.premultiply(qA.setFromUnitVectors(tP, aLo));
        arm.qHand.copy(Dh);
      }
    }
    this._set(arm.lower, aDl);
    this._set(arm.hand, Dh);

    // 손가락: 손 기준 회전(L)을 손 회전에 얹는다
    for (const fg of arm.fingers) {
      for (let i = 0; i < 3; i++) this._set(fg.chain[i], qA.copy(Dh).multiply(fg.L[i]));
    }
  }

  // 얼굴 좌표에서 표정 수치 뽑기 (좌우 대칭 값은 거울 모드와 무관)
  _faceMetrics(face) {
    const g = (i, out) => out.set(face[i][0], face[i][1], face[i][2]);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
    const up = new THREE.Vector3();
    const o = FACE.oval.start;
    g(o + OVAL_TOP, up).sub(g(o + OVAL_CHIN, a)).normalize();
    const le = this._mean(face, FACE.leftEye, 1, new THREE.Vector3());
    const re = this._mean(face, FACE.rightEye, 1, new THREE.Vector3());
    const eyeDist = Math.max(1e-4, le.distanceTo(re));
    const lb = this._mean(face, FACE.leftBrow, 1, a);
    const rb = this._mean(face, FACE.rightBrow, 1, b);
    const brow = (lb.sub(le).dot(up) + rb.sub(re).dot(up)) / 2 / eyeDist;
    const il = FACE.innerLips.start, ol = FACE.outerLips.start;
    const upL = g(il + INNER_UP, a).clone(), dnL = g(il + INNER_DOWN, b).clone();
    const innerW = Math.max(1e-4, g(il + INNER_CORNER_L, c).distanceTo(g(il + INNER_CORNER_R, d)));
    const open = upL.distanceTo(dnL) / innerW;
    const cl = g(ol + OUTER_CORNER_L, c).clone(), cr = g(ol + OUTER_CORNER_R, d).clone();
    const mouthW = Math.max(1e-4, cl.distanceTo(cr));
    const lift = cl.add(cr).multiplyScalar(0.5).sub(upL.add(dnL).multiplyScalar(0.5)).dot(up) / mouthW;
    const ear = (grp) => {
      const s = grp.start;
      const w = Math.max(1e-4, g(s, a).distanceTo(g(s + 3, b)));
      return (g(s + 1, a).distanceTo(g(s + 5, b)) + g(s + 2, c).distanceTo(g(s + 4, d))) / (2 * w);
    };
    return { brow, open, lift, width: mouthW / eyeDist, earL: ear(FACE.leftEye), earR: ear(FACE.rightEye) };
  }

  _expressions(face, mirror, dt) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    const target = { aa: 0, ou: 0, happy: 0, sad: 0, angry: 0, surprised: 0, blinkLeft: 0, blinkRight: 0 };
    if (face) {
      const mt = this._faceMetrics(face);
      if (!this._base) this._base = mt;
      const base = this._base;
      const dOpen = mt.open - base.open;
      target.aa = clamp01((dOpen - 0.03) / 0.4);
      const narrow = clamp01((0.92 - mt.width / Math.max(1e-4, base.width)) / 0.25);
      target.ou = narrow * 0.8;
      target.aa *= 1 - narrow * 0.5;
      const dLift = mt.lift - base.lift;
      target.happy = clamp01((dLift - 0.01) / 0.13) * 0.85;
      target.sad = clamp01((-dLift - 0.015) / 0.15) * 0.6;
      const dBrow = mt.brow / Math.max(1e-4, Math.abs(base.brow)) - 1;
      target.surprised = clamp01((dBrow - 0.05) / 0.35) * 0.85;
      target.angry = clamp01((-dBrow - 0.04) / 0.3) * 0.8;
      const blink = (v, b0) => clamp01((0.62 - v / Math.max(1e-4, b0)) / 0.35);
      const bl = blink(mt.earL, base.earL), br = blink(mt.earR, base.earR);
      target.blinkLeft = mirror ? br : bl;
      target.blinkRight = mirror ? bl : br;
    }
    // 가만히 있을 때의 자연스러운 눈 깜빡임
    this._blinkAt -= dt;
    if (this._blinkAt <= 0 && this._blinkT < 0) { this._blinkT = 0; this._blinkAt = 2.5 + Math.random() * 3.5; }
    let idle = 0;
    if (this._blinkT >= 0) {
      this._blinkT += dt;
      const x = this._blinkT / 0.16;
      idle = x >= 1 ? 0 : Math.sin(Math.PI * x);
      if (x >= 1) this._blinkT = -1;
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 18) : 1;
    const e = this._expr;
    for (const n of Object.keys(target)) e[n] = (e[n] || 0) + (target[n] - (e[n] || 0)) * k;
    const set = (n, v) => { if (this.has[n]) em.setValue(n, clamp01(v)); };
    set('aa', e.aa); set('ou', e.ou); set('happy', e.happy); set('sad', e.sad);
    set('angry', e.angry); set('surprised', e.surprised);
    const bl = Math.max(e.blinkLeft, idle), br = Math.max(e.blinkRight, idle);
    if (this.has.blinkLeft && this.has.blinkRight) { set('blinkLeft', bl); set('blinkRight', br); }
    else set('blink', Math.max(bl, br));
  }

  // 뷰어에서 떼어 낸다. 풀에 자리가 있으면 보관하고, 없으면 완전히 지운다.
  dispose() {
    this.group.parent?.remove(this.group);
    if (this._destroyed) return;
    if (pool.length < POOL_MAX && !pool.includes(this)) pool.push(this);
    else if (!pool.includes(this)) this.destroy();
  }

  destroy() {
    this._destroyed = true;
    this.group.parent?.remove(this.group);
    VRMUtils.deepDispose(this.vrm.scene);
  }
}
