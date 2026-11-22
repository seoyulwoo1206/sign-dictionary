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
import {
  VRMLoaderPlugin, VRMUtils,
  VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapeSphere,
} from '@pixiv/three-vrm';
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
const aW = { flex: 0, dev: 0, sup: 0, rel: 0, fw: 1 };

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

// 좌표를 만든 쪽이 가정한 몸통 (skeleton.js의 마네킹과 같은 모양): [반지름 배율, 높이(0 = 엉덩이, 1 = 어깨)]
const DATA_TORSO = [
  [0.62, 0], [0.66, 0.08], [0.6, 0.32], [0.64, 0.5], [0.76, 0.72],
  [0.85, 0.88], [0.84, 0.97], [0.7, 1.04], [0.42, 1.09], [0.16, 1.11],
];
const DATA_TORSO_RX = 0.5, DATA_TORSO_RZ = 0.285, DATA_HIP_Y = -1.55;
// 툰 재질 다듬기: 그늘 색을 더 진하게, 명암 경계는 조금 부드럽게, 가장자리에 약한 윤곽광
const LOOK = {
  skinShade: '#e9a99b', skinToony: 0.72, skinShift: -0.12, skinRim: '#3a2a22',
  clothShade: '#a9b3d1', clothToony: 0.6, clothShift: -0.1, clothRim: '#2a2e3a',
  hairShade: '#b98a7a', hairToony: 0.8,
};
const SKIN = 0.003;          // 살갗 사이에 두는 틈
const ELBOW_OMEGA = 15;       // 팔꿈치 각도가 목표를 따라가는 빠르기 (1/s)
const CORR_SPEED_MAX = 6;     // 충돌 보정량이 바뀌는 최대 속도 (어깨 너비/초)
const HAND_TURN_GAIN = 45, HAND_TURN_ACCEL = 260;   // 손 회전: 남은 각도 → 속도 (1/s), 최대 각가속도 (rad/s²)
const TWIST_GAIN = 20, TWIST_SPEED_MAX = 12, TWIST_ACCEL_MAX = 220; // 아래팔 비틀림
const HAND_TURN_MAX = 14;     // 손이 돌 수 있는 최대 각속도 (rad/s, 약 800°/s)
const REMAP_POINTS = [0, 4, 8, 9, 12, 16, 20]; // 얼굴·몸통 보정을 구할 때 보는 손의 점
const REST_Y0 = -1.4, REST_Y1 = -0.75; // 이 높이 아래는 '늘어뜨린 손'으로 본다 (사이는 서서히 바뀐다)
const SPRING_STEP = 1 / 60;   // 스프링 본(머리카락·옷자락) 물리의 기준 시간 간격
// 머리카락 가닥이 몸(옷) 표면에서 떨어져 있을 거리 (가닥 두께 절반쯤)
const HAIR_BODY_GAP = 0.03;
// 팔이 머리카락을 밀 때 한 단계에 겹친 양의 얼마만큼 밀어낼지 (1 = 한 번에 전부)
const HAIR_ARM_SOFT = 0.5;
const SOFT = 0.035;          // 몸에 닿기 전부터 서서히 밀리기 시작하는 거리
const PROFILE_POW = 2.6;     // 몸통 단면의 둥근 정도 (2 = 타원, 클수록 네모) — 메시를 못 잰 경우에만 쓴다
const PROFILE_NA = 48;       // 몸통 윤곽의 각도 칸 수
const HEAD_NLAT = 25, HEAD_NLON = 48; // 머리 윤곽의 위도·경도 칸 수

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
    if (n === 'hips') c = { id: 'torso', strict: true };
    else if (/UpperLeg$/.test(n)) c = { id: 'torso', strict: false }; // 다리에 딸린 옷자락 포함
    else if (/LowerLeg$|Foot$|Toes$/.test(n)) c = { id: 'none', strict: false };
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

  const a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), c3 = new THREE.Vector3();
  const addPoint = (c, v) => {
    if (c.id === 'torso') {
      // 겨드랑이 위쪽에서 어깨 관절보다 바깥에 있는 것은 소매이므로 뺀다 (T자세에서 옆으로 펼쳐져 있다)
      if (v.y > armpitY && Math.abs(v.x) > sleeveX) return;
      torso.push(v.x, v.y, v.z);
    } else if (c.id === 'head') headAll.push(v.x, v.y, v.z);
  };
  vrm.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!pos || !si || !sw) return;
    mesh.skeleton.update();
    const cls = mesh.skeleton.bones.map(classify);
    const isFace = faceMeshes.has(mesh);
    const vc = new Array(pos.count);
    const wpos = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let bi = si.getX(i), bw = sw.getX(i);
      if (sw.getY(i) > bw) { bw = sw.getY(i); bi = si.getY(i); }
      if (sw.getZ(i) > bw) { bw = sw.getZ(i); bi = si.getZ(i); }
      if (sw.getW(i) > bw) { bw = sw.getW(i); bi = si.getW(i); }
      const c = cls[bi];
      vc[i] = c && c.id !== 'none' ? c : null;
      if (!vc[i]) continue;
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      wpos[3 * i] = v.x; wpos[3 * i + 1] = v.y; wpos[3 * i + 2] = v.z;
      if (c.id === 'head' && isFace) headFace.push(v.x, v.y, v.z);
      else if (c.id === 'neck' && bones.neck) neckD.push(axisDist(v, bones.neck.rest, bones.head.rest));
      else if (c.id === 'ua') uaD.push(axisDist(v, arms[c.side].upper.rest, arms[c.side].lower.rest));
      else if (c.id === 'la') laD.push(axisDist(v, arms[c.side].lower.rest, arms[c.side].hand.rest));
      else if (c.id === 'palm') palmD.push(Math.abs(w.subVectors(v, arms[c.side].hand.rest).dot(arms[c.side].pn0)));
    }
    // 몸통·머리는 삼각형 면을 촘촘히 찍는다 (꼭짓점만으로는 넓은 면이 비어 보인다)
    const idx = g.index ? g.index.array : null;
    const cnt = idx ? (g.groups.length ? g.groups[0].start + g.groups[0].count : idx.length) : pos.count;
    for (let t = idx && g.groups.length ? g.groups[0].start : 0; t + 2 < cnt; t += 3) {
      const ia = idx ? idx[t] : t, ib = idx ? idx[t + 1] : t + 1, ic = idx ? idx[t + 2] : t + 2;
      const c = vc[ia];
      if (!c || (c.id !== 'torso' && c.id !== 'head')) continue;
      if (!vc[ib] || !vc[ic] || vc[ib].id !== c.id || vc[ic].id !== c.id) continue;
      a3.fromArray(wpos, 3 * ia); b3.fromArray(wpos, 3 * ib); c3.fromArray(wpos, 3 * ic);
      const edge = Math.max(a3.distanceTo(b3), b3.distanceTo(c3), c3.distanceTo(a3));
      const m = clamp(Math.ceil(edge / 0.025), 1, 16);
      for (let p = 0; p <= m; p++) {
        for (let q = 0; q <= m - p; q++) {
          v.set(0, 0, 0).addScaledVector(a3, p / m).addScaledVector(b3, q / m).addScaledVector(c3, (m - p - q) / m);
          addPoint(c, v);
        }
      }
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
  const dy = 0.05;
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
  // 높이·각도별 실제 윤곽: 단면 중심에서 그 방향으로 가장 먼 면까지의 거리 (옷·가슴 굴곡이 그대로 담긴다)
  const NA = PROFILE_NA;
  const rho = new Float32Array(n * NA);
  for (let i = 0; i < torso.length; i += 3) {
    const fi = (yTop - torso[i + 1]) / dy;
    const k0 = Math.floor(fi);
    for (const k of [k0, k0 + 1]) {
      if (k < 0 || k >= n) continue;
      const dx = torso[i] - pr.cx[k], dz = torso[i + 2] - pr.cz[k];
      const fa = (Math.atan2(dx, dz) / (2 * Math.PI) + 1) % 1 * NA;
      const d = Math.hypot(dx, dz);
      const j0 = Math.floor(fa) % NA, j1 = (j0 + 1) % NA;
      if (d > rho[k * NA + j0]) rho[k * NA + j0] = d;
      if (d > rho[k * NA + j1]) rho[k * NA + j1] = d;
    }
  }
  // 빈칸 메우기: 같은 높이의 이웃 각도 → 없으면 기본 타원
  for (let k = 0; k < n; k++) {
    const row = rho.subarray(k * NA, (k + 1) * NA);
    const had = Array.from(row, (x) => x > 0);
    const any = had.some(Boolean);
    for (let j = 0; j < NA; j++) {
      if (had[j]) continue;
      if (!any) {
        const a = j / NA * 2 * Math.PI;
        row[j] = 1 / Math.hypot(Math.sin(a) / pr.hx[k], Math.cos(a) / pr.hz[k]);
        continue;
      }
      let l = 1, r2 = 1;
      while (!had[(j - l + NA * 4) % NA]) l++;
      while (!had[(j + r2) % NA]) r2++;
      row[j] = lerp(row[(j - l + NA * 4) % NA], row[(j + r2) % NA], l / (l + r2));
    }
  }
  // 살짝 다듬되 잰 값보다 작아지지는 않게 (표면 안쪽으로 들어가는 일이 없도록)
  {
    const src0 = Float32Array.from(rho);
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < NA; j++) {
        const at = (kk, jj) => src0[clamp(kk, 0, n - 1) * NA + (jj + NA) % NA];
        const sm = 0.4 * at(k, j) + 0.2 * (at(k, j - 1) + at(k, j + 1)) + 0.1 * (at(k - 1, j) + at(k + 1, j));
        rho[k * NA + j] = Math.max(src0[k * NA + j], sm);
      }
    }
  }
  pr.rho = rho; pr.na = NA;
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
  // 방향별 실제 반지름 (얼굴 굴곡·머리통). 흘러내린 머리카락(스프링 본)은 들어 있지 않다.
  const NLAT = HEAD_NLAT, NLON = HEAD_NLON;
  const hr = new Float32Array(NLAT * NLON);
  if (headAll.length >= 900) {
    for (let i = 0; i < headAll.length; i += 3) {
      const dx = headAll[i] - c.x, dy2 = headAll[i + 1] - c.y, dz = headAll[i + 2] - c.z;
      const d = Math.hypot(dx, dy2, dz);
      if (d < 1e-6) continue;
      const fa = Math.acos(clamp(dy2 / d, -1, 1)) / Math.PI * (NLAT - 1);
      const fo = (Math.atan2(dx, dz) / (2 * Math.PI) + 1) % 1 * NLON;
      const a0 = Math.floor(fa), o0 = Math.floor(fo) % NLON;
      for (const a of [a0, Math.min(NLAT - 1, a0 + 1)]) for (const o of [o0, (o0 + 1) % NLON]) {
        if (d > hr[a * NLON + o]) hr[a * NLON + o] = d;
      }
    }
  }
  const ell = (a, o) => {
    const th = a / (NLAT - 1) * Math.PI, ph = o / NLON * 2 * Math.PI;
    const ex = Math.sin(th) * Math.sin(ph), ey = Math.cos(th), ez = Math.sin(th) * Math.cos(ph);
    return 1 / Math.hypot(ex / r.x, ey / r.y, ez / r.z);
  };
  for (let a = 0; a < NLAT; a++) {
    for (let o = 0; o < NLON; o++) {
      // 목 아래쪽처럼 면이 없는 방향은 타원체로 메운다 (타원체보다 한참 안쪽인 값도 구멍으로 본다)
      const e = ell(a, o);
      if (hr[a * NLON + o] < 0.55 * e) hr[a * NLON + o] = e * (a > NLAT * 0.7 ? 0.8 : 1);
    }
  }
  {
    const src0 = Float32Array.from(hr);
    for (let a = 0; a < NLAT; a++) {
      for (let o = 0; o < NLON; o++) {
        const at = (aa, oo) => src0[clamp(aa, 0, NLAT - 1) * NLON + (oo + NLON) % NLON];
        const sm = 0.4 * at(a, o) + 0.15 * (at(a, o - 1) + at(a, o + 1) + at(a - 1, o) + at(a + 1, o));
        hr[a * NLON + o] = Math.max(src0[a * NLON + o], sm);
      }
    }
  }
  shape.head = { c: c.sub(head.rest), r, rho: hr, nlat: NLAT, nlon: NLON };
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
  const rho = pr.rho, NA = pr.na;
  const r0 = i * NA, r1 = r0 + NA;
  const F = rho ? (x, z) => {
    // 실제 윤곽: 이 방향의 반지름(높이·각도로 보간)보다 안쪽이면 < 1
    const fa = (Math.atan2(x, z) / (2 * Math.PI) + 1) % 1 * NA;
    const j0 = Math.floor(fa) % NA, j1 = (j0 + 1) % NA, ft = fa - Math.floor(fa);
    const R = lerp(lerp(rho[r0 + j0], rho[r0 + j1], ft), lerp(rho[r1 + j0], rho[r1 + j1], ft), t) * s + r;
    return (x * x + z * z) / (R * R);
  } : (x, z) => Math.pow(Math.abs(x) / hx, PROFILE_POW) + Math.pow(Math.abs(z) / hz, PROFILE_POW);
  if (F(u, w) >= 1) return 0;
  // 가운데 쪽 점은 거의 똑바로 앞으로, 옆구리 쪽 점은 옆으로 나가게 축을 잡는다
  // 엉덩이 아래 높이에서는 단면 중심에서 곧장 바깥으로(= 거의 옆으로) 민다: 늘어뜨린 손이 허벅지 앞으로 밀려 나오지 않고 몸 옆에 놓인다
  const low = smooth(REST_Y0, REST_Y1, p.y);
  const oz = -0.45 * hz * low;
  const ox = u * 0.85 * (1 - smooth(0.55, 1.0, Math.abs(u) / hx)) * low;
  let dx = u - ox, dz = w - oz;
  let len = Math.hypot(dx, dz);
  if (len < 1e-5) { dx = 0; dz = 1; len = 1; }
  let lo = 1, hi = 1 + 2 * (hx + hz) / len;
  for (let k = 0; k < 14; k++) {
    const m = (lo + hi) / 2;
    if (F(ox + dx * m, oz + dz * m) < 1) lo = m; else hi = m;
  }
  out.set(dx * (hi - 1), 0, dz * (hi - 1));
  return len * (hi - 1);
}

// 몸통 윤곽에서 높이 y, 방향 (sn, cs) = (x, z)/길이 의 표면까지 거리. out에 그 높이의 단면 중심 (cx, 0, cz)
function profileRadius(pr, y, sn, cs, out) {
  const fi = clamp((pr.yTop - y) / pr.dy, 0, pr.n - 1.001);
  const i = Math.floor(fi), t = fi - i;
  let s = 1;
  const yc = pr.yTop - pr.cap;
  if (y > yc) { const u = Math.min(1, (y - yc) / pr.cap); s = Math.sqrt(Math.max(0, 1 - u * u)); }
  out.set(lerp(pr.cx[i], pr.cx[i + 1], t), 0, lerp(pr.cz[i], pr.cz[i + 1], t));
  if (!pr.rho) {
    const hx = lerp(pr.hx[i], pr.hx[i + 1], t), hz = lerp(pr.hz[i], pr.hz[i + 1], t);
    return s / Math.pow(Math.pow(Math.abs(sn) / hx, PROFILE_POW) + Math.pow(Math.abs(cs) / hz, PROFILE_POW), 1 / PROFILE_POW);
  }
  const NA = pr.na, rho = pr.rho;
  const fa = (Math.atan2(sn, cs) / (2 * Math.PI) + 1) % 1 * NA;
  const j0 = Math.floor(fa) % NA, j1 = (j0 + 1) % NA, ft = fa - Math.floor(fa);
  const r0 = i * NA, r1 = r0 + NA;
  return lerp(lerp(rho[r0 + j0], rho[r0 + j1], ft), lerp(rho[r1 + j0], rho[r1 + j1], ft), t) * s;
}

// 좌표 속 사람(마네킹과 같은 체형)의 몸통 반지름 (yf: 0 = 엉덩이, 1 = 어깨)
function dataTorsoR(yf) {
  const P = DATA_TORSO;
  if (yf <= 0) return P[0][0];
  const last = P[P.length - 1];
  if (yf >= last[1]) return Math.max(0.02, last[0] - (yf - last[1]) * 8);
  for (let i = 1; i < P.length; i++) {
    if (yf <= P[i][1]) return lerp(P[i - 1][0], P[i][0], (yf - P[i - 1][1]) / (P[i][1] - P[i - 1][1]));
  }
  return last[0];
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

// 두 선분 p0-p1, q0-q1 사이의 가장 가까운 점. out = [s, t] (각 선분 위의 위치 0~1)
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _rr = new THREE.Vector3();
function segSeg(p0, p1, q0, q1, out) {
  _d1.subVectors(p1, p0); _d2.subVectors(q1, q0); _rr.subVectors(p0, q0);
  const a = _d1.lengthSq(), e = _d2.lengthSq(), f = _d2.dot(_rr);
  let s = 0, t = 0;
  if (a > 1e-10 && e > 1e-10) {
    const c = _d1.dot(_rr), b = _d1.dot(_d2), den = a * e - b * b;
    s = den > 1e-10 ? clamp01((b * f - c * e) / den) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
  } else if (a > 1e-10) s = clamp01(-_d1.dot(_rr) / a);
  else if (e > 1e-10) t = clamp01(f / e);
  out[0] = s; out[1] = t;
}
const _st = [0, 0];
const hP0 = new THREE.Vector3(), hP1 = new THREE.Vector3(), hT = new THREE.Vector3(), hA = new THREE.Vector3(), hB = new THREE.Vector3();
const hN = new THREE.Vector3(), hD0 = new THREE.Vector3(), hD1 = new THREE.Vector3();
const hQ = new THREE.Quaternion(), hQw = new THREE.Quaternion(), hQp = new THREE.Quaternion();

// 선분 a-b(반지름 R) 캡슐에서 점 p(반지름 r)를 밀어내되, 캡슐 축에서 nOut 반대쪽으로 치우친 점을 기준으로 민다.
// 축에서 곧장 바깥으로 밀면(capsulePush) 손이 축을 넘어가는 순간 미는 방향이 뒤집혀 손이 팔 반대편으로 튄다.
// 이렇게 하면 팔 속 어디에 있든 늘 nOut 쪽(몸 바깥쪽·위쪽) 겉으로 나온다.
const _co = new THREE.Vector3(), _cd = new THREE.Vector3(), _cn = new THREE.Vector3();
function capsulePushBiased(p, r, a, b, R, nOut, out) {
  out.subVectors(b, a);
  const l2 = Math.max(1e-9, out.lengthSq());
  const t = clamp(tP.subVectors(p, a).dot(out) / l2, 0, 1);
  _cn.copy(nOut).addScaledVector(out, -nOut.dot(out) / l2); // 축에 수직인 성분만
  out.multiplyScalar(t).add(a).sub(p).negate();             // 축 → p
  const RR = R + r;
  const d2 = out.lengthSq();
  if (d2 >= RR * RR) return 0;
  if (_cn.lengthSq() < 1e-6) _cn.set(0, 0, 1);
  _cn.normalize();
  _co.copy(_cn).multiplyScalar(-0.6 * RR);   // 기준점 (축에서 안쪽으로)
  _cd.subVectors(out, _co);                  // 기준점 → p
  const dd = _cd.lengthSq();
  if (dd < 1e-10) { _cd.copy(_cn); }
  const od = _co.dot(_cd), d3 = Math.max(1e-10, _cd.lengthSq());
  const m = (-od + Math.sqrt(Math.max(0, od * od - d3 * (_co.lengthSq() - RR * RR)))) / d3;
  const k = Math.max(0, m - (dd < 1e-10 ? 0 : 1));
  out.copy(_cd).multiplyScalar(k);
  return out.length();
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
    this._headYaw = 0; this._headPitch = 0;
    this._gazeX = 0; this._gazeY = 0; this._gazeTx = 0; this._gazeTy = 0; this._gazeAt = 1;
    this._blink2 = false;
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
        qOut: new THREE.Quaternion(),    // 손목 한계까지 적용한 최종 손 회전 (회전 속도 제한)
        Wf: new THREE.Vector3(),         // 손목 목표 (부드럽게)
        Wc: new THREE.Vector3(),         // 손목 목표 (충돌 보정 뒤)
        cU: new THREE.Vector3(), cE: new THREE.Vector3(), cW: new THREE.Vector3(), // 반대쪽 손의 충돌 계산에 쓰는 팔 위치 (부드럽게)
        remap: new THREE.Vector3(),      // 몸통 보정량 (아바타 체형에 맞춰 앞으로 옮기는 양)
        cOut: new THREE.Vector3(),       // 지난 프레임에 실제로 쓴 충돌 보정량
        W0: new THREE.Vector3(), corr: new THREE.Vector3(), // 충돌 보정 전 위치, 부드럽게 따라가는 보정량
        phi: 0.3, phiV: 0, raise: 0, prot: 0, sup: 0, supV: 0, turnV: 0,
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
    for (const n of ['aa', 'ou', 'happy', 'sad', 'angry', 'surprised', 'relaxed', 'blink', 'blinkLeft', 'blinkRight']) {
      this.has[n] = !!(em && em.getExpression(n));
    }

    this._setupSprings();
    this._setupLook();

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

  // 스프링 본(머리카락·옷자락) 준비.
  //  - three-vrm의 스프링 본은 충돌 반지름·탄성·중력을 "모델 단위(m)" 그대로 월드 공간에서 쓴다.
  //    아바타를 키워 놓았기 때문에(scale배) 그대로 두면 충돌체가 실제 팔·몸보다 훨씬 작아 머리카락이 팔을 그냥 통과하고,
  //    탄성·중력도 약해져 머리카락이 무게 없이 흐느적거린다. 모두 scale배로 맞춘다.
  //  - 손바닥·손가락 충돌체를 더해 손이 머리카락을 헤치고 지나가게 한다 (원래는 손목 근처 공 하나뿐).
  _setupSprings() {
    const sm = this.vrm.springBoneManager;
    this._springBase = [];
    this._hairJoints = [];
    if (!sm || !sm.joints || !sm.joints.size) return;
    const s = this.scale;
    const h = this.vrm.humanoid;
    try {
      for (const c of sm.colliders) if (c.shape && c.shape.radius > 0) c.shape.radius *= s;
      for (const j of sm.joints) {
        const st = j.settings;
        st.hitRadius *= s;
        this._springBase.push({ j, stiffness: st.stiffness * s, gravity: st.gravityPower * s, drag: st.dragForce });
      }
      // 머리에 달린 스프링 본(머리카락)
      const headRaw = h.getRawBoneNode('head');
      const isUnder = (n, top) => { for (let p = n; p; p = p.parent) if (p === top) return true; return false; };
      const hairJoints = [...sm.joints].filter((j) => headRaw && isUnder(j.bone, headRaw));
      const groups = sm.colliderGroups;
      const _a = new THREE.Vector3();
      for (const side of ['left', 'right']) {
        const arm = this.arms[side];
        const rawHand = h.getRawBoneNode(`${side}Hand`);
        if (!rawHand) continue;
        // 손 충돌체 묶음: 이미 있으면 거기에 더하고, 없으면 새로 만들어 머리카락에 건다
        let group = groups.find((g) => g.colliders.some((c) => c.parent === rawHand));
        if (!group) {
          group = { name: `${side}HandExtra`, colliders: [] };
          for (const j of hairJoints) j.colliderGroups.push(group);
        }
        const local = (rawParent, bone) => rawParent.worldToLocal(_a.copy(bone.rest)).clone();
        const add = (rawParent, shape) => {
          const col = new VRMSpringBoneCollider(shape);
          rawParent.add(col);
          group.colliders.push(col);
        };
        const mp = this.bones[`${side}MiddleProximal`], mi = this.bones[`${side}MiddleIntermediate`], md = this.bones[`${side}MiddleDistal`];
        const halfW = arm.width * 0.5;
        if (mp) {
          // 손바닥: 손목 → 중지 뿌리
          add(rawHand, new VRMSpringBoneColliderShapeCapsule({ offset: new THREE.Vector3(), tail: local(rawHand, mp), radius: halfW * 0.85 }));
          const rawMp = h.getRawBoneNode(`${side}MiddleProximal`), rawMi = h.getRawBoneNode(`${side}MiddleIntermediate`);
          // 손가락 첫 마디·둘째 마디 (네 손가락을 한 덩어리로)
          if (rawMp && mi) add(rawMp, new VRMSpringBoneColliderShapeCapsule({ offset: new THREE.Vector3(), tail: local(rawMp, mi), radius: halfW * 0.75 }));
          if (rawMi && md) add(rawMi, new VRMSpringBoneColliderShapeCapsule({ offset: new THREE.Vector3(), tail: local(rawMi, md).multiplyScalar(1.8), radius: halfW * 0.55 }));
        }
      }
      // 중력이 없는 긴 머리카락 가닥은 팔에 들리면 끝이 뻣뻣하게 뻗는다 → 다른 가닥만큼 중력을 준다 (끝이 아래로 늘어진다)
      for (const base of this._springBase) {
        const j = base.j;
        if (!hairJoints.includes(j) || !j.child || base.gravity > 0) continue;
        if (j.child.position.length() * s < 0.2) continue; // 짧은 앞머리는 그대로
        j.settings.gravityDir.set(0, -1, 0);
        base.gravity = 0.1 * s;
      }
      // 옷자락(다리 쪽 스프링 본)은 손·아래팔에 밀리게 한다 → 차렷 자세에서 손이 옷자락을 뚫지 않고 옷이 눌린다
      const armGroups = [];
      for (const side of ['left', 'right']) {
        for (const part of ['Hand', 'LowerArm']) {
          const raw = h.getRawBoneNode(side + part);
          const g = raw && sm.colliderGroups.find((cg) => cg.colliders.some((c) => c.parent === raw));
          if (g) armGroups.push(g);
        }
      }
      const hipsRaw = h.getRawBoneNode('hips');
      const armRaws = ['left', 'right'].map((sd) => h.getRawBoneNode(`${sd}UpperArm`)).filter(Boolean);
      for (const j of sm.joints) {
        if (hairJoints.includes(j) || !hipsRaw || !isUnder(j.bone, hipsRaw)) continue;
        if (armRaws.some((a) => isUnder(j.bone, a))) continue; // 소매는 제외
        for (const g of armGroups) if (!j.colliderGroups.includes(g)) j.colliderGroups.push(g);
      }
      // 머리카락 마디(선분)와 팔(캡슐)의 충돌은 따로 처리한다 (_hairVsArms)
      this._hairJoints = hairJoints.filter((j) => j.child && j._currentTail && j._prevTail && !j.center)
        .map((j) => ({ j, r: j.settings.hitRadius + 0.03, out: false, hold: 0, squeeze: 0, arm: false }));
      this._caps = Array.from({ length: 8 }, () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 }));
      for (const hj of this._hairJoints) { const b = this._springBase.find((x) => x.j === hj.j); if (b) b.hj = hj; }
      // 충돌체를 더했으니 갱신 순서를 다시 계산하게 한다
      const first = sm.joints.values().next().value;
      sm.deleteJoint(first); sm.addJoint(first);
    } catch (err) {
      console.warn('[avatar] 스프링 본 설정을 건너뜁니다:', err);
    }
  }

  // 재질·그림자: 살과 옷이 단단한 덩어리로 읽히게 한다
  _setupLook() {
    for (const m of this.vrm.materials || []) {
      if (!m.isMToonMaterial) continue;
      // 만화풍 외곽선은 끈다: 그림자와 겹치면 옷·팔 가장자리에 점선처럼 끊겨 치직거려 보이고, 실제 사람 느낌과도 멀다
      m.outlineWidthFactor = 0;
      const name = m.name || '';
      if (/SKIN/i.test(name)) {
        m.shadeColorFactor?.set(LOOK.skinShade);
        m.shadingToonyFactor = LOOK.skinToony;
        m.shadingShiftFactor = LOOK.skinShift;
        m.parametricRimColorFactor?.set(LOOK.skinRim);
        m.parametricRimFresnelPowerFactor = 4;
      } else if (/CLOTH/i.test(name)) {
        m.shadeColorFactor?.set(LOOK.clothShade);
        m.shadingToonyFactor = LOOK.clothToony;
        m.shadingShiftFactor = LOOK.clothShift;
        m.parametricRimColorFactor?.set(LOOK.clothRim);
        m.parametricRimFresnelPowerFactor = 4;
      } else if (/HAIR/i.test(name)) {
        m.shadeColorFactor?.set(LOOK.hairShade);
        m.shadingToonyFactor = LOOK.hairToony;
      }
    }
    this.vrm.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // 눈·눈썹·속눈썹 같은 얼굴 위의 얇은 판은 그림자를 드리우지 않는다
      const overlay = mats.every((m) => /EYE|Eyeline|Brow|Mouth/i.test(m.name || ''));
      o.castShadow = !overlay;
      o.receiveShadow = !/EYE/i.test(mats[0]?.name || '');
    });
  }

  // 머리카락이 팔을 뚫지 않게 한다.
  // three-vrm의 스프링 본 충돌은 "마디 끝점"만 본다. 긴 머리카락은 마디 하나가 길어서 팔이 마디 중간을 그냥 지나간다.
  // 그래서 마디 전체(선분)와 팔·손(캡슐)을 견주어, 겹치면 머리카락을 몸 바깥쪽(주로 앞)으로 밀어 팔 위에 걸쳐지게 한다.
  // 팔 뒤에 눌린 머리카락은 갈 곳이 없어 팔이나 몸을 뚫어 보이므로 항상 바깥쪽으로 빼낸다. 한 번에 조금씩만 움직여 튀지 않게 한다.
  _hairVsArms(k) {
    const hs = this._hairJoints;
    if (!hs.length) return;
    const caps = this._caps, sh = this.shape;
    let nc = 0;
    for (const side of ['left', 'right']) {
      const arm = this.arms[side];
      const mp = this.bones[`${side}MiddleProximal`], md = this.bones[`${side}MiddleDistal`];
      const cap = (a, b, r) => { const c = caps[nc++]; c.a.copy(a); c.b.copy(b); c.r = r; };
      cap(hA.copy(arm.upper.pos).lerp(arm.lower.pos, 0.45), arm.lower.pos, sh.uaR);
      cap(arm.lower.pos, arm.hand.pos, sh.laR);
      if (mp) {
        cap(arm.hand.pos, mp.pos, arm.width * 0.42);
        if (md) cap(mp.pos, md.pos, arm.width * 0.36);
      }
    }
    const axis = this.bones.upperChest || this.bones.chest || this.bones.spine;
    const maxStep = 0.045 * k;
    for (const hj of hs) {
      const j = hj.j, bone = j.bone;
      hP0.setFromMatrixPosition(bone.matrixWorld);
      hP1.setFromMatrixPosition(j.child.matrixWorld);
      const len = hP0.distanceTo(hP1);
      if (len < 1e-4) continue;
      hT.copy(hP1);
      let moved = false;
      for (let ci = 0; ci < nc; ci++) {
        const c = caps[ci];
        segSeg(hP0, hT, c.a, c.b, _st);
        if (_st[0] < 0.04) continue; // 뿌리 쪽은 움직일 수 없다
        const rootW = smooth(0.04, 0.3, _st[0]); // 뿌리에 가까울수록 덜 민다 (문턱에서 켜졌다 꺼졌다 하지 않게 서서히)
        hA.copy(hP0).lerp(hT, _st[0]);       // 머리카락 위의 점
        hB.copy(c.a).lerp(c.b, _st[1]);      // 팔 위의 점
        const need = c.r + hj.r;
        const d2 = hA.distanceToSquared(hB);
        if (d2 >= need * need) continue;
        // 미는 방향: 몸통 축에서 바깥으로 (앞뒤를 더 크게) — 팔에서 멀어지는 방향이 아니라 늘 몸 바깥쪽
        hN.set((hA.x - axis.pos.x) * 0.5, 0, (hA.z - axis.pos.z) * 2);
        if (hN.lengthSq() < 1e-8) hN.set(0, 0, 1);
        hN.normalize();
        // 머리카락이 팔과 몸 사이(팔 뒤)에 있고 그 사이에 머리카락이 들어갈 틈이 있으면, 팔을 뚫고 앞으로 빼내지 않고
        // 팔에서 멀어지는 쪽(몸 쪽)으로 밀어 그대로 팔 뒤에 둔다. 틈이 없으면(팔이 몸에 붙어 있으면) 몸 바깥쪽으로 빼낸다.
        // 한 번 정한 쪽은 조건이 뚜렷이 바뀔 때까지 유지한다 (오락가락하며 떨지 않게).
        hD0.subVectors(hA, hB);
        if (hD0.dot(hN) < 0) {
          const tight = this._bodyDepth(hB, c.r + 2 * hj.r + 0.04);
          if (tight > 0.03 || hj.squeeze > 0.1) hj.out = true; else if (tight <= 0) hj.out = false;
          if (!hj.out && d2 > 1e-8) hN.copy(hD0).normalize();
        } else hj.out = false;
        const b = hD0.subVectors(hA, hB).dot(hN);
        // 한 번에 다 밀지 않고 겹친 만큼의 일부만 민다(부드러운 접촉): 팔이 스치며 머리카락을 툭툭 치는 떨림을 줄인다
        const t = Math.min(-b + Math.sqrt(Math.max(0, b * b - (d2 - need * need))), maxStep) * rootW * HAIR_ARM_SOFT;
        hT.addScaledVector(hN, t / Math.max(_st[0], 0.3));
        hT.sub(hP0).setLength(len).add(hP0);
        moved = true;
      }
      hj.arm = moved;
      if (!moved) continue;
      hj.hold = 1;
      // 한 번에 움직이는 양을 제한한다 (여러 캡슐에 한꺼번에 걸려도 머리카락이 순간 이동하지 않게)
      const mv = hD0.subVectors(hT, hP1).length();
      if (mv > 1.4 * maxStep) hT.copy(hP1).addScaledVector(hD0, 1.4 * maxStep / mv).sub(hP0).setLength(len).add(hP0);
      // 마디를 새 끝점 쪽으로 돌리고, 물리 상태(끝점 위치)도 맞춘다
      hD0.subVectors(hP1, hP0).normalize();
      hD1.subVectors(hT, hP0).normalize();
      hQ.setFromUnitVectors(hD0, hD1);
      bone.getWorldQuaternion(hQw);
      bone.parent.getWorldQuaternion(hQp);
      bone.quaternion.copy(hQp.invert()).multiply(hQ).multiply(hQw);
      bone.updateMatrix();
      bone.updateWorldMatrix(false, true);
      // 밀려난 만큼 '지난 위치'도 함께 옮겨 속도가 붙지 않게 하고(튕겨 나가 떨리는 것을 막는다), 닿아 있는 동안은 마찰처럼 속도를 줄인다
      j._prevTail.add(hD0.subVectors(hT, hP1));
      j._currentTail.copy(hT);
      j._prevTail.lerp(j._currentTail, 0.85);
    }
  }

  // 머리카락이 몸(옷 포함)을 뚫지 않게 한다.
  // 모델에 들어 있는 몸 충돌체는 가슴·배의 작은 공뿐이라, 헐렁한 옷 앞자락과 어깨 위로 늘어진 머리카락이 옷 속으로 들어가
  // 옷과 머리카락이 번갈아 비쳐 치지직거린다. 메시에서 잰 실제 몸통 윤곽(_torsoPush)으로 마디 끝과 가운데를 검사해
  // 들어가 있으면 몸 표면 바깥으로 마디를 돌려 낸다. 몸에 얹힌 동안은 제자리로 돌아가려는 힘을 줄여(hold) 안팎으로 떨지 않게 한다.
  _hairVsBody(k) {
    const hs = this._hairJoints;
    if (!hs.length || !this.torsoOwners || this._noHairBody) return; // _noHairBody: 개발용 비교 스위치
    const maxStep = 0.06 * k;
    for (const hj of hs) {
      const j = hj.j, bone = j.bone;
      hP0.setFromMatrixPosition(bone.matrixWorld);
      hP1.setFromMatrixPosition(j.child.matrixWorld);
      const len = hP0.distanceTo(hP1);
      if (len < 1e-4) continue;
      // 끝점이 필요한 만큼 움직일 양: 끝에서 잰 것과, 가운데에서 잰 것을 끝으로 옮긴 것(두 배) 가운데 큰 쪽
      let need = 0;
      hT.set(0, 0, 0);
      for (const t of [1, 0.5]) {
        hA.copy(hP0).lerp(hP1, t);
        const d = this._torsoPush(hA, HAIR_BODY_GAP, hN);
        if (d > 0 && d / t > need) { need = d / t; hT.copy(hN).multiplyScalar(1 / t); }
      }
      if (need <= 0) continue;
      hj.hold = 1;
      if (hj.arm && need > 0.01) hj.squeeze = 1; // 팔과 몸 사이에 끼었다 → 다음부터 팔 앞으로 빼낸다
      if (need > maxStep) hT.multiplyScalar(maxStep / need);
      hT.add(hP1).sub(hP0).setLength(len).add(hP0);
      // 마디를 새 끝점 쪽으로 돌리고, 물리 상태도 맞춘다 (_hairVsArms 와 같은 방식)
      hD0.subVectors(hP1, hP0).normalize();
      hD1.subVectors(hT, hP0).normalize();
      hQ.setFromUnitVectors(hD0, hD1);
      bone.getWorldQuaternion(hQw);
      bone.parent.getWorldQuaternion(hQp);
      bone.quaternion.copy(hQp.invert()).multiply(hQ).multiply(hQw);
      bone.updateMatrix();
      bone.updateWorldMatrix(false, true);
      j._prevTail.add(hD0.subVectors(hT, hP1));
      j._currentTail.copy(hT);
      j._prevTail.lerp(j._currentTail, 0.6); // 몸에 스치는 동안은 마찰처럼 속도를 줄인다
    }
  }

  // vrm.update(dt)와 같은 순서로 갱신하되, 스프링 본은 프레임 속도와 무관하게 움직이도록 한다.
  // (three-vrm의 스프링 본은 "한 번 갱신할 때마다" 감쇠가 걸려서 화면 주사율에 따라 머리카락 움직임이 달라진다)
  _vrmUpdate(dt) {
    const vrm = this.vrm;
    vrm.humanoid.update();
    if (vrm.lookAt) vrm.lookAt.update(dt);
    if (vrm.expressionManager) vrm.expressionManager.update();
    if (vrm.nodeConstraintManager) vrm.nodeConstraintManager.update();
    const sm = vrm.springBoneManager;
    if (sm && dt > 0) {
      const n = clamp(Math.round(dt / SPRING_STEP), 1, 4);
      const h = dt / n, k = h / SPRING_STEP;
      for (const b of this._springBase) {
        const st = b.j.settings;
        // 팔에 걸쳐 있는 머리카락 마디는 제자리로 돌아가려는 힘을 크게 줄인다.
        // (라이브러리가 매번 안쪽으로 당기고 여기서 다시 밀어내면 머리카락이 팔 위에서 톱니처럼 떤다. 팔에서 떨어지면 서서히 되돌린다.)
        let hold = 1, drag = b.drag;
        if (b.hj) {
          const c = b.hj.hold;
          hold = 1 - 0.88 * c;
          // 팔·몸에 닿아 있는 동안은 공기 저항을 크게 해 끼인 머리카락이 안팎으로 떨지 않고 가라앉게 한다
          drag = Math.max(drag, lerp(drag, 0.85, c));
          b.hj.hold *= Math.exp(-h / 0.25);
          b.hj.squeeze = (b.hj.squeeze || 0) * Math.exp(-h / 0.4);
        }
        st.stiffness = b.stiffness * k * hold;
        st.gravityPower = b.gravity * k * hold;
        st.dragForce = 1 - Math.pow(1 - drag, k);
      }
      for (let i = 0; i < n; i++) { sm.update(h); this._hairVsArms(k); this._hairVsBody(k); }
    }
    if (vrm.materials) for (const m of vrm.materials) if (m.update) m.update(dt);
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
    this._headYaw = 0; this._headPitch = 0;
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

  // frame: 관절 좌표, dtHint: 지난 호출 뒤 흐른 시간(초). 없으면 직접 잰다.
  update(frame, dtHint) {
    if (!frame || !frame.pose) return;
    const now = performance.now();
    const gap = this._last ? (now - this._last) / 1000 : -1;
    // 뷰어가 준 시간 간격(재생 위치를 옮긴 바로 그 값)을 쓴다 → 프레임 간격이 들쭉날쭉해도 좌표와 필터가 같은 시계로 움직인다.
    // 한 프레임 안에서 두 번 불리면(클립 교체 직후 등) 두 번째는 0으로 본다.
    const dt = gap >= 0 && gap < 0.002 ? 0 : Math.min(0.1, Math.max(0, dtHint ?? gap));
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
    // 체중 이동: 아주 느리게 좌우로 실리는 무게 (주기가 다른 두 물결을 섞어 되풀이가 눈에 띄지 않게)
    const weight = 0.6 * Math.sin(time * 0.23 + 0.4) + 0.4 * Math.sin(time * 0.37 + 2.0);
    // 손이 얼마나 "일하고 있는지" (허리 위로 올라와 있으면 1) — 머리·시선이 손을 살짝 따라간다
    const actL = smooth(-1.15, -0.6, T.Lw.y), actR = smooth(-1.15, -0.6, T.Rw.y);

    // ----- 몸통: 어깨선 방향 + 손을 뻗는 쪽으로 살짝 따라가기 -----
    v0.subVectors(T.Ls, T.Rs);
    if (v0.lengthSq() < 1e-8) v0.copy(X);
    basisQuat(q0, v0, Y);
    const reachF = (w, sign) => smooth(0.6, 1.3, w.z) + 0.5 * smooth(0, 0.7, -sign * w.x) * smooth(0.2, 0.6, w.z);
    const fL = reachF(T.Lw, 1), fR = reachF(T.Rw, -1);
    // 손을 높이 들면 그쪽 어깨가 올라가며 몸통이 아주 조금 반대로 기운다
    const liftL = smooth(0.1, 0.9, T.Lw.y), liftR = smooth(0.1, 0.9, T.Rw.y);
    _eul.set(
      0.05 * Math.min(fL, fR) - 0.007 * breath,
      0.09 * (fR - fL) + 0.006 * sway2,
      0.005 * sway1 + 0.007 * weight + 0.025 * (liftL - liftR),
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
    // 머리: 작은 흔들림 + 일하는 손 쪽으로 아주 조금 돌아보고 숙인다 (좌표의 머리 움직임에 얹는다)
    const hy = clamp(0.07 * (actL * clamp(T.Lw.x, -0.8, 0.8) + actR * clamp(T.Rw.x, -0.8, 0.8)), -0.06, 0.06);
    const hp = 0.03 * Math.max(actL * smooth(0.3, -0.9, T.Lw.y), actR * smooth(0.3, -0.9, T.Rw.y));
    this._headYaw = this._follow(this._headYaw, hy, 0.35, 0.5);
    this._headPitch = this._follow(this._headPitch, hp, 0.35, 0.5);
    _eul.set(
      0.008 * Math.sin(time * 0.9 + 0.5) + 0.004 * breath + this._headPitch,
      0.012 * sway2 + this._headYaw,
      0.006 * sway1 - 0.004 * weight,
      'YXZ',
    );
    T.Dhead.multiply(q1.setFromEuler(_eul));
    this.qHead.slerp(T.Dhead, this._k(0.06));
    T.Dhead.copy(this.qHead);
    if (B.neck) { q1.copy(T.Dtop).slerp(T.Dhead, 0.45); this._set(B.neck, q1); }
    this._set(B.head, T.Dhead);
    // 눈: 주로 앞(보는 사람)을 보다가 가끔 시선이 조금씩 옮겨 간다 (빠르게 옮기고 잠깐 머문다)
    this._gazeAt -= dt;
    if (this._gazeAt <= 0) {
      const away = Math.random() < 0.35; // 가끔은 손 쪽을 흘끗 본다
      this._gazeTx = away ? clamp(0.25 * (actR * T.Rw.x + actL * T.Lw.x), -0.12, 0.12) + (Math.random() - 0.5) * 0.04 : (Math.random() - 0.5) * 0.05;
      this._gazeTy = away ? -0.08 * Math.max(actL, actR) + (Math.random() - 0.5) * 0.03 : (Math.random() - 0.5) * 0.03;
      this._gazeAt = away ? 0.35 + Math.random() * 0.5 : 1.2 + Math.random() * 2.6;
    }
    this._gazeX = this._follow(this._gazeX, this._gazeTx, 0.035, 6);
    this._gazeY = this._follow(this._gazeY, this._gazeTy, 0.035, 6);
    if (B.leftEye || B.rightEye) {
      // 머리가 돌아간 만큼 눈은 반대로 돌아 앞을 계속 본다
      _eul.set(-this._gazeY - 0.6 * this._headPitch, this._gazeX - 0.6 * this._headYaw, 0, 'YXZ');
      q1.copy(T.Dhead).multiply(T.q[3].setFromEuler(_eul));
      if (B.leftEye) this._set(B.leftEye, q1);
      if (B.rightEye) this._set(B.rightEye, q1);
    }

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
    shift.x += 0.008 * weight;
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
    // 몸통 보정(앞으로 옮기는 양)은 손마다 따로 구하면 서로 닿아 있던 손과 팔이 어긋난다.
    // 한 손이 반대쪽 손·아래팔에 가까울수록 두 손의 보정량을 평균 쪽으로 모아 서로의 위치 관계를 지킨다.
    this._remap(L, T.Lw, handL);
    this._remap(R, T.Rw, handR);
    {
      const near = (hand, W, oE, oW, oHand) => {
        const pt = hand ? hand[9] : W;
        let d = tA.copy(oW).sub(oE), t = clamp(tB.subVectors(pt, oE).dot(d) / Math.max(1e-9, d.lengthSq()), 0, 1);
        let best = tB.addScaledVector(d, -t).length();
        if (oHand) best = Math.min(best, pt.distanceTo(oHand[9]), pt.distanceTo(oHand[0]));
        return best;
      };
      const dmin = Math.min(near(handL, T.Lw, T.Re, T.Rw, handR), near(handR, T.Rw, T.Le, T.Lw, handL));
      const w = 1 - smooth(0.25, 0.75, dmin);
      if (w > 0) {
        const mean = 0.5 * (L.remap.z + R.remap.z);
        L.remap.z = lerp(L.remap.z, mean, w);
        R.remap.z = lerp(R.remap.z, mean, w);
      }
    }
    this._hand(L, T.Lw, handL);
    this._hand(R, T.Rw, handR);

    // ----- 충돌: 두 손끼리, 손과 몸(몸통·목·머리·반대쪽 팔) -----
    this._separateHands(L, R);
    this._collide(L, R, true);
    this._collide(R, L, true);
    this._separateHands(L, R);
    this._resolveHand(L, R, 0);
    this._resolveHand(R, L, 0);
    // 보정량이 한 프레임에 바뀔 수 있는 크기를 제한한다 (초당 6 = 어깨 너비의 6배; 손이 몸에 다가가는 어떤 동작보다 빠르다).
    // 손 모양·방향이 갑자기 바뀌어 손가락이 몸속으로 들어간 순간에도 손 전체가 한 프레임에 튀어 나가지 않고 두세 프레임에 걸쳐 빠져나온다.
    for (const arm of [L, R]) {
      const c = tA.subVectors(arm.Wc, arm.Wf);
      if (!this._snap) {
        const d = tB.subVectors(c, arm.cOut), dl = d.length(), lim = CORR_SPEED_MAX * dt;
        if (dl > lim) c.copy(arm.cOut).addScaledVector(d, lim / Math.max(1e-9, dl));
      }
      arm.cOut.copy(c);
      arm.Wc.copy(arm.Wf).add(c);
    }

    // ----- 팔 (쇄골 → 2관절 IK → 손목) -----
    this._arm(L, T.Ls, T.Le, handL ? handL[0] : T.Lw, breath);
    this._arm(R, T.Rs, T.Re, handR ? handR[0] : T.Rw, breath);
    L.valid = true; R.valid = true;
    {
      const k = this._snap ? 1 : 1 - Math.exp(-dt / 0.05);
      for (const arm of [L, R]) { arm.cU.lerp(arm.upper.pos, k); arm.cE.lerp(arm.lower.pos, k); arm.cW.lerp(arm.hand.pos, k); }
    }
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
        this._collide(arm, left ? R : L, false);
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

    this._vrmUpdate(dt);
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


  // 몸 앞의 점 p를 아바타 체형에 맞게 옮기는 보정량.
  // 좌표는 마네킹 체형(가슴 앞면이 어깨선에서 0.24쯤) 기준인데, 아바타는 옷·가슴 때문에 앞면이 훨씬 앞에 있다.
  // 그대로 두면 "몸 앞 공간"의 손이 모두 옷 속에 들어가 표면으로 밀려나 붙어 버린다.
  // 좌표 속 몸 표면에서 떨어진 거리(c)가 아바타 몸 표면에서도 그대로 유지되도록 옮긴다. 멀리 뻗은 손은 그대로 둔다.
  // 돌려주는 값: 좌표 속 몸에서 떨어진 거리 c (가까운 점일수록 크게 반영하는 데 쓴다)
  // gx: 손 전체의 가로 위치(손목·손바닥). 손이 몸 '앞'에 있는지 '옆'에 늘어져 있는지는 손가락 끝이 아니라 손 전체로 판단한다.
  _torsoCorrection(p, out, gx = p.x) {
    out.set(0, 0, 0);
    // 좌표 속 몸의 앞면 (타원 단면)
    const Rd = dataTorsoR((p.y - DATA_HIP_Y) / -DATA_HIP_Y);
    const k = Rd * Rd - (p.x / DATA_TORSO_RX) ** 2;
    const zD = k > 0 ? DATA_TORSO_RZ * Math.sqrt(k) : 0;
    const c = p.z - zD;
    const pr = this.shape.profile;
    // 어깨 위(몸통이 끝난 곳)부터는 얼굴 보정이 맡는다. 몸 옆으로 벗어난 점·멀리 뻗은 점은 그대로 둔다.
    // 좌표 속 몸의 옆으로 벗어난 점(차렷 자세의 손 등)은 '몸 앞'이 아니므로 옮기지 않는다
    const wd = 1 - smooth(1.0, 1.8, Math.abs(gx) / (DATA_TORSO_RX * Rd));
    // 몸 옆으로 늘어뜨린 손(쉬는 자세)은 wd가 0이라 앞으로 옮기지 않는다 → 손이 허벅지 앞이 아니라 몸 옆에 놓인다
    const w = wd * (1 - smooth(0.05, 0.3, p.y)) * (1 - smooth(0.3, 1.0, c)) * smooth(-0.25, 0, c);
    if (w <= 0) return c;
    // 아바타 몸의 앞면: 같은 x에서 윤곽과 만나는 z (이분법)
    const fi = clamp((pr.yTop - p.y) / pr.dy, 0, pr.n - 1.001);
    const i = Math.floor(fi), t = fi - i;
    const cx = lerp(pr.cx[i], pr.cx[i + 1], t), cz = lerp(pr.cz[i], pr.cz[i + 1], t);
    const u = p.x - cx;
    const side = profileRadius(pr, p.y, Math.sign(u) || 1, 0, tP);
    const wx = 1 - smooth(0.7, 1.0, Math.abs(u) / Math.max(1e-4, side));
    if (wx <= 0) return c;
    let lo = 0, hi = 1.2;
    for (let n = 0; n < 12; n++) {
      const m = (lo + hi) / 2;
      const d = Math.hypot(u, m);
      if (d < profileRadius(pr, p.y, u / d, m / d, tP)) lo = m; else hi = m;
    }
    out.z = Math.max(0, cz + lo - zD) * w * wx;
    return c;
  }

  // 이 손에 줄 몸통 보정량 → arm.remap (몸에 가까운 손의 점일수록 크게 반영)
  _remap(arm, W_pose, hand) {
    const v = this._t.v[11];
    if (!hand) { this._torsoCorrection(W_pose, arm.remap); return; }
    arm.remap.set(0, 0, 0);
    const gx = 0.5 * (hand[0].x + hand[9].x);
    let wsum = 0;
    for (const i of REMAP_POINTS) {
      const c = Math.max(0, this._torsoCorrection(hand[i], v, gx));
      const wt = 1 / (c * c + 0.01);
      arm.remap.addScaledVector(v, wt);
      wsum += wt;
    }
    arm.remap.multiplyScalar(1 / wsum);
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
      for (const i of REMAP_POINTS) {
        const d2 = hand[i].distanceToSquared(center);
        const w = 1 / (d2 * d2 + 0.002);
        const f = this._faceCorrection(hand[i], v11);
        corr.addScaledVector(v11, w * f);
        wsum += w;
      }
      corr.multiplyScalar(1 / wsum).add(arm.remap);
      // 중지 뿌리가 좌표의 그 자리에 오도록 손목 목표를 정한다
      Wt.copy(arm.knuckleOff).applyQuaternion(arm.DhRaw).negate().add(hand[9]).add(corr);
      arm.qHand.slerp(arm.DhRaw, this._k(0.03));
      this._fingerTargets(arm, hand);
    } else {
      const f = this._faceCorrection(W_pose, v11);
      Wt.copy(W_pose).addScaledVector(v11, f);
      Wt.add(arm.remap);
      this._relaxTargets(arm);
    }
    arm.Wf.lerp(Wt, this._k(0.025));
    arm.Wc.copy(arm.Wf);

    // 손가락 각도: 부드럽게 따라가되 각속도를 제한한다 (떨림 제거)
    const tau = have ? 0.05 : 0.16;
    // 쉬고 있는 손(허리 아래)은 손가락이 숨결처럼 아주 조금 오므렸다 펴진다 (굳은 손처럼 보이지 않게)
    const rest = 1 - smooth(-1.25, -0.9, W_pose.y);
    if (rest > 0) {
      const ph = performance.now() / 1000 * 0.55 + (arm.sign > 0 ? 0 : 1.7);
      for (const fg of arm.nonThumb) {
        const wv = 0.035 * rest * Math.sin(ph + fg.k * 0.5);
        fg.tgt[1] += wv; fg.tgt[2] = Math.max(0, fg.tgt[2] + wv);
      }
    }
    for (const fg of arm.fingers) {
      for (let i = fg.thumb ? 2 : 0; i < 4; i++) fg.ang[i] = this._follow(fg.ang[i], fg.tgt[i], tau, 18);
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
    // 멀리 있으면 바로 끝낸다
    if (tP.lengthSq() > (Math.max(rx, ry, rz) * 1.35) ** 2) return 0;
    const hr = sh.rho, NLAT = sh.nlat, NLON = sh.nlon;
    const F = hr ? (x, y, z) => {
      const d = Math.hypot(x, y, z);
      if (d < 1e-6) return 0;
      const fa = Math.acos(clamp(y / d, -1, 1)) / Math.PI * (NLAT - 1);
      const fo = (Math.atan2(x, z) / (2 * Math.PI) + 1) % 1 * NLON;
      const a0 = Math.min(NLAT - 2, Math.floor(fa)), ta = fa - a0;
      const o0 = Math.floor(fo) % NLON, o1 = (o0 + 1) % NLON, to = fo - Math.floor(fo);
      const R = lerp(lerp(hr[a0 * NLON + o0], hr[a0 * NLON + o1], to), lerp(hr[(a0 + 1) * NLON + o0], hr[(a0 + 1) * NLON + o1], to), ta) + r;
      return d / R;
    } : (x, y, z) => (x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2;
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

  // 손을 몸 밖으로 밀어내되, 밀어낸 양이 줄어들 때는 천천히 줄인다.
  // 몸에 닿는 쪽(늘어나는 쪽)은 바로 따라가므로 파묻히지 않고, 몸에서 떨어질 때 손이 "툭" 하고 제자리로 튀지 않는다.
  _collide(arm, other, store) {
    const W0 = arm.W0.copy(arm.Wc);
    this._resolveHand(arm, other, SOFT);
    const c = tG.subVectors(arm.Wc, W0);
    if (this._snap) { if (store) arm.corr.copy(c); return; }
    const a = arm.corr.length(), b = c.length();
    const g = smooth(0, 0.6, (a - b) / (a + 1e-4)) * Math.exp(-this._dt / 0.1);
    c.addScaledVector(tPush.subVectors(arm.corr, c), g);
    if (store) arm.corr.copy(c);
    arm.Wc.copy(W0).add(c);
  }

  // 손(손목·손바닥·손가락 마디)이 몸이나 반대쪽 팔에 파묻히면 손 전체를 표면까지 밀어낸다.
  // "가장 깊이 들어간 점 하나"만 골라 밀면 그 점이 바뀌는 순간 미는 방향이 확 바뀌어 손이 튄다(떨림의 원인).
  // 모든 점을 정해진 순서로 하나씩 풀면(가우스-자이델) 결과가 입력에 대해 연속이라 튀지 않는다.
  // soft > 0: 표면에 닿기 조금 전(soft)부터 서서히 밀기 시작해, 몸에 닿는 순간 속도가 꺾이지 않게 한다.
  _resolveHand(arm, other, soft) {
    const sh = this.shape, B = this.bones;
    const W0 = tH.copy(arm.Wc);
    const sink = 0.07 * (1 - smooth(REST_Y0, REST_Y1, arm.Wc.y));
    for (let it = 0; it < 3; it++) {
      let moved = 0;
      for (let i = 0; i < arm.npts; i++) {
        const p = tC.copy(arm.pts[i]).add(arm.Wc);
        const r = arm.prad[i] + SKIN + soft;
        // 늘어뜨린 손의 손가락은 헐렁한 옷자락에 살짝 묻혀도 된다 (옷자락은 스프링 본이라 손에 밀린다).
        // 손가락 끝까지 옷 밖으로 빼려면 팔을 옆으로 크게 벌려야 해서 차렷 자세가 어색해진다.
        let d = this._torsoPush(p, i >= 4 ? r - sink : r, tPush);
        if (d > 0) { arm.Wc.add(tPush); p.add(tPush); moved += d; }
        d = this._headPush(p, r, tPush);
        if (d > 0) { arm.Wc.add(tPush); p.add(tPush); moved += d; }
        if (B.neck) {
          d = capsulePush(p, r, B.neck.pos, B.head.pos, sh.neckR, tPush);
          if (d > 0) { arm.Wc.add(tPush); p.add(tPush); moved += d; }
        }
        if (other.valid) {
          // 반대쪽 팔 (위팔, 아래팔의 팔꿈치 쪽 85%). 몸 바깥쪽·위쪽 겉으로 밀어낸다.
          // 지난 프레임 자세를 그대로 쓰면 두 팔이 한 프레임 늦게 서로를 밀어내며 두 프레임 주기로 떤다 → 부드럽게 따라가는 위치(cU·cE·cW)를 쓴다.
          const ax = this.torso.length ? this.torso[this.torso.length - 1].pos : B.hips.pos;
          tF.set(p.x - ax.x, 0, (p.z - ax.z) * 1.5);
          if (tF.lengthSq() < 1e-8) tF.set(0, 0, 1);
          tF.normalize(); tF.y = 0.5;
          d = capsulePushBiased(p, r, other.cU, other.cE, sh.uaR * 0.8, tF, tPush);
          if (d > 0) { arm.Wc.add(tPush); p.add(tPush); moved += d; }
          tE.copy(other.cE).lerp(other.cW, 0.85);
          d = capsulePushBiased(p, r, other.cE, tE, sh.laR * 0.8, tF, tPush);
          if (d > 0) { arm.Wc.add(tPush); moved += d; }
        }
      }
      if (moved < 1e-5) break;
    }
    if (soft > 0) {
      // 부풀린 반지름으로 구한 보정량 m → 실제 보정량: 2·soft 까지는 m²/(4·soft), 그 뒤로는 m − soft
      const c = tD.subVectors(arm.Wc, W0);
      const m = c.length();
      if (m > 1e-9) arm.Wc.copy(W0).addScaledVector(c, m < 2 * soft ? m / (4 * soft) : (m - soft) / m);
    }
  }

  // 두 손이 서로 파묻히지 않게 반씩 밀어낸다 (맞닿는 것은 허용).
  // 겹친 점 쌍들을 깊이로 가중 평균해 민다 (한 쌍만 고르면 쌍이 바뀔 때 튄다).
  _separateHands(a, b) {
    for (let it = 0; it < 2; it++) {
      let wsum = 0, best = 0;
      tD.set(0, 0, 0);
      for (let i = 0; i < a.npts; i++) {
        const p = tC.copy(a.pts[i]).add(a.Wc);
        for (let j = 0; j < b.npts; j++) {
          const q = tE.copy(b.pts[j]).add(b.Wc);
          const min = (a.prad[i] + b.prad[j]) * 0.85;
          const d2 = p.distanceToSquared(q);
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2);
          const depth = min - d;
          if (d > 1e-5) tD.addScaledVector(tG.subVectors(p, q), depth * depth / d); else tD.x += a.sign * depth * depth;
          wsum += depth;
          if (depth > best) best = depth;
        }
      }
      if (best < 1e-5) break;
      tD.multiplyScalar(1 / wsum);
      a.Wc.addScaledVector(tD, 0.5);
      b.Wc.addScaledVector(tD, -0.5);
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
    // 아래팔이 손의 가로축과 거의 나란하면(좌우 꺾임 ≈ 90°) 굽힘 각은 뜻이 없어 조금만 달라져도 부호가 뒤집힌다.
    // 그럴수록 굽힘을 0 쪽으로 줄여서, 한계로 되돌릴 때 손이 반대편으로 홱 뒤집히지 않게 한다.
    aW.fw = smooth(0.08, 0.4, Math.hypot(lf, lp));
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
    if (pen > 0) c += 0.2 * smooth(0, 0.02, pen) + 45 * pen;
    // 지금 각도 근처에 머무르려는 힘: 비슷한 비용의 두 해 사이를 오가지 않게 한다
    if (!this._snap) c += 0.35 * ((phi - arm.phi) / 0.7) ** 2;
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
    arm.phiT = phi;
    // 임계 감쇠 스프링으로 따라간다: 고른 각도가 갑자기 바뀌어도 팔꿈치가 속도까지 부드럽게 이어진다 (1차 필터는 속도가 꺾인다)
    if (this._snap) { arm.phi = phi; arm.phiV = 0; }
    else if (this._dt > 0) {
      const w = ELBOW_OMEGA, h = this._dt, x = arm.phi - phi, e = Math.exp(-w * h);
      const c = arm.phiV + w * x;
      arm.phi = phi + (x + c * h) * e;
      arm.phiV = (arm.phiV - c * w * h) * e;
    }
    this._armPose(arm, S, dn, reach, p0, side, arm.phi);
    this._set(arm.upper, aDu);

    // ----- 아래팔 비틀림과 손목 -----
    const Dh = qC;
    arm.clamped = false;
    if (arm.have) {
      Dh.copy(arm.qHand);
      this._wristMetrics(arm, Dh);
      // 손바닥 아래(0)~위(180°) 범위에서, 지난 값에 가까운 쪽으로 푼다 (±180° 근처에서 뒤집히지 않게)
      // 같은 손 방향을 내는 각(±360°) 가운데 가동 범위를 가장 덜 벗어나는 것을 고른다.
      // 범위를 벗어난 정도가 비슷하면 지금 있는 쪽에 머문다 → 한계 근처에서 아래팔이 반대편 끝으로 한 바퀴 휙 도는 일을 막는다.
      let sup = aW.sup, bestD = Infinity, pick = sup;
      for (const c of [sup - 2 * Math.PI, sup, sup + 2 * Math.PI]) {
        const cc = clamp(c, SUP_HARD[0], SUP_HARD[1]);
        const d = this._snap
          ? Math.max(0, SUP_SOFT[0] - c, c - SUP_SOFT[1])
          : Math.abs(c - cc) + 0.12 * Math.abs(cc - arm.sup);
        if (d < bestD) { bestD = d; pick = cc; }
      }
      sup = pick * smooth(0.05, 0.4, aW.rel);
      // 임계 감쇠 스프링 + 속도 제한 (갑자기 방향이 바뀌어도 속도가 부드럽게 이어진다)
      if (this._snap) { arm.sup = sup; arm.supV = 0; }
      else if (this._dt > 0) {
        // 속도와 가속도를 함께 제한해 따라간다. 속도만 제한하면 목표가 반대로 바뀔 때 최고 속도에서 곧바로 반대 최고 속도로 꺾인다
        // (손 방향이 손목·아래팔 가동 범위를 벗어난 구간에서 아래팔이 탁탁 끊겨 도는 원인).
        const h = this._dt;
        const want = clamp(TWIST_GAIN * (sup - arm.sup), -TWIST_SPEED_MAX, TWIST_SPEED_MAX);
        arm.supV += clamp(want - arm.supV, -TWIST_ACCEL_MAX * h, TWIST_ACCEL_MAX * h);
        arm.sup += arm.supV * h;
      }
      aDl.premultiply(qA.setFromAxisAngle(aLo, -arm.sign * arm.sup * FOREARM_TWIST));
      // 손목 한계를 넘으면 손을 한계까지만 꺾는다
      const flex = clamp(aW.flex, -WRIST_FLEX_HARD, WRIST_FLEX_HARD) * aW.fw;
      const dev = clamp(aW.dev, -WRIST_DEV_HARD, WRIST_DEV_HARD);
      if (flex !== aW.flex || dev !== aW.dev) {
        arm.clamped = true;
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
      const flex = clamp(aW.flex, -WRIST_FLEX_HARD, WRIST_FLEX_HARD) * aW.fw;
      const dev = clamp(aW.dev, -WRIST_DEV_HARD, WRIST_DEV_HARD);
      if (flex !== aW.flex || dev !== aW.dev) {
        const cd = Math.cos(dev);
        tP.set(0, 0, 0).addScaledVector(arm.f0, cd * Math.cos(flex)).addScaledVector(arm.a0, Math.sin(dev))
          .addScaledVector(arm.pn0, cd * Math.sin(flex)).applyQuaternion(Dh);
        Dh.premultiply(qA.setFromUnitVectors(tP, aLo));
        arm.qHand.copy(Dh);
      }
    }
    // 손 회전의 최대 속도를 제한한다: 손목 한계 처리나 팔꿈치 해가 바뀌는 순간에도 손이 한 프레임에 홱 돌지 않는다
    if (this._snap || !arm.valid) { arm.qOut.copy(Dh); arm.turnV = 0; }
    else if (this._dt > 0) {
      // 남은 각도에 비례한 속도로 따라가되, 속도가 갑자기 늘지 않게 가속도도 제한한다
      const h = this._dt;
      const want = Math.min(HAND_TURN_MAX, HAND_TURN_GAIN * arm.qOut.angleTo(Dh));
      arm.turnV = Math.min(want, arm.turnV + HAND_TURN_ACCEL * h);
      arm.qOut.rotateTowards(Dh, arm.turnV * h);
    }
    Dh.copy(arm.qOut);
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
    // 빨리 감고(0.07초) 조금 천천히 뜬다(0.13초). 다섯 번에 한 번쯤은 연달아 두 번 깜빡인다.
    this._blinkAt -= dt;
    if (this._blinkAt <= 0 && this._blinkT < 0) {
      this._blinkT = 0;
      if (this._blink2) { this._blink2 = false; this._blinkAt = 2.2 + Math.random() * 4; }
      else if (Math.random() < 0.2) { this._blink2 = true; this._blinkAt = 0.28; }
      else this._blinkAt = 2.2 + Math.random() * 4;
    }
    let idle = 0;
    if (this._blinkT >= 0) {
      this._blinkT += dt;
      const x = this._blinkT;
      idle = x < 0.07 ? smooth(0, 0.07, x) : 1 - smooth(0.07, 0.2, x);
      if (x >= 0.2) this._blinkT = -1;
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 18) : 1;
    const e = this._expr;
    for (const n of Object.keys(target)) e[n] = (e[n] || 0) + (target[n] - (e[n] || 0)) * k;
    const set = (n, v) => { if (this.has[n]) em.setValue(n, clamp01(v)); };
    set('aa', e.aa); set('ou', e.ou); set('happy', e.happy); set('sad', e.sad);
    set('angry', e.angry); set('surprised', e.surprised);
    // 아무 표정도 없을 때는 굳은 얼굴 대신 편안한 얼굴
    set('relaxed', 0.22 * (1 - clamp01(e.happy + e.sad + e.angry + e.surprised + e.aa)));
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
