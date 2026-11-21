// MediaPipe 결과 → 원시 프레임(이미지 좌표) → 정규화 프레임(landmarks.js 좌표계)
//
// 원시 프레임(raw): 이미지 좌표 그대로 (x, y는 0~1, y+ = 아래, z- = 카메라 쪽)
//   { ts: 초, pose: [[x,y,z,visibility] × 25] | null, left, right: [[x,y,z] × 21] | null,
//     face: [[x,y,z] × FACE_COUNT] | null }   ← left/right는 "수어하는 사람" 기준
//
// 정규화 프레임: 양 어깨 중점 = 원점, 어깨 너비 = 1,
//   x+ = 보는 사람 기준 오른쪽, y+ = 위, z+ = 카메라 쪽

import { POSE, POSE_COUNT, HAND_COUNT, FACE_INDICES } from '../viewer/landmarks.js';
import { round4, lerp } from '../viewer/smoothing.js';

// z가 이 범위를 넘으면 잘라 낸다 (어깨 너비 단위)
export const Z_LIMIT = 2.0;
// 손가락 z는 손목 기준 상대값이므로 이 범위 안이어야 정상이다
const HAND_Z_LIMIT = 1.0;
const FACE_Z_LIMIT = 0.8;
// face 배열 안에서 코끝(얼굴 메시 1번)의 위치 — 얼굴 깊이의 기준점
const FACE_NOSE_TIP = FACE_INDICES.indexOf(1);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const xyz = (p) => [p.x, p.y, p.z ?? 0];

// ---------------------------------------------------------------------------
// 1) MediaPipe 결과를 공통 모양으로 모은다
//    반환: { pose: Landmark[33] | null, poseWorld: Landmark[33] | null, hands: [{ points: Landmark[21], side }], face: Landmark[] | null }
//    side는 "수어하는 사람 기준"으로 추정한 값('left' | 'right')
// ---------------------------------------------------------------------------

// HolisticLandmarker 결과: left/rightHandLandmarks는 이미 사람 기준 왼손/오른손이다.
export function collectHolistic(result) {
  const hands = [];
  const l = result.leftHandLandmarks?.[0];
  const r = result.rightHandLandmarks?.[0];
  if (l?.length === HAND_COUNT) hands.push({ points: l, side: 'left' });
  if (r?.length === HAND_COUNT) hands.push({ points: r, side: 'right' });
  return {
    pose: result.poseLandmarks?.[0] ?? null,
    poseWorld: result.poseWorldLandmarks?.[0] ?? null,
    hands,
    face: result.faceLandmarks?.[0] ?? null,
  };
}

// PoseLandmarker + HandLandmarker + FaceLandmarker 결과.
// HandLandmarker의 handedness 라벨은 "좌우가 뒤집힌(셀카) 영상"을 가정하므로,
// 뒤집지 않은 영상을 넣으면 라벨이 실제와 반대다 → 'Left' = 수어하는 사람의 오른손.
export function collectSeparate(poseResult, handResult, faceResult) {
  const hands = [];
  const list = handResult?.landmarks ?? [];
  const labels = handResult?.handedness ?? handResult?.handednesses ?? [];
  list.forEach((points, i) => {
    if (points?.length !== HAND_COUNT) return;
    const label = labels[i]?.[0]?.categoryName ?? '';
    hands.push({ points, side: label === 'Left' ? 'right' : 'left' });
  });
  return {
    pose: poseResult?.landmarks?.[0] ?? null,
    poseWorld: poseResult?.worldLandmarks?.[0] ?? null,
    hands,
    face: faceResult?.faceLandmarks?.[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2) 손을 왼손/오른손에 배정한다 (포즈 손목과의 거리 우선, 애매하면 라벨)
// ---------------------------------------------------------------------------
export function assignHands(pose, hands, aspect = 1) {
  const out = { left: null, right: null };
  if (!hands?.length) return out;
  const cands = hands.slice(0, 2);

  const lw = pose?.[POSE.LEFT_WRIST];
  const rw = pose?.[POSE.RIGHT_WRIST];
  const ls = pose?.[POSE.LEFT_SHOULDER];
  const rs = pose?.[POSE.RIGHT_SHOULDER];
  const dist = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  // 포즈 손목을 믿을 수 있는지 (둘 다 거의 안 보이면 라벨만 쓴다)
  const wristsUsable = lw && rw && ls && rs
    && Math.max(lw.visibility ?? 1, rw.visibility ?? 1) > 0.2;

  const byLabel = () => {
    for (const h of cands) {
      if (!out[h.side]) out[h.side] = h.points;
      else out[h.side === 'left' ? 'right' : 'left'] = h.points;
    }
    return out;
  };
  if (!wristsUsable) return byLabel();

  const margin = 0.15 * dist(ls, rs); // 이보다 차이가 작으면 "애매함"
  const dL = cands.map((h) => dist(h.points[0], lw));
  const dR = cands.map((h) => dist(h.points[0], rw));

  if (cands.length === 1) {
    let side = cands[0].side;
    if (Math.abs(dL[0] - dR[0]) > margin) side = dL[0] < dR[0] ? 'left' : 'right';
    out[side] = cands[0].points;
    return out;
  }

  const straight = dL[0] + dR[1]; // 0번 = 왼손, 1번 = 오른손
  const swapped = dR[0] + dL[1];
  let firstIsLeft;
  if (Math.abs(straight - swapped) > margin) firstIsLeft = straight < swapped;
  else if (cands[0].side !== cands[1].side) firstIsLeft = cands[0].side === 'left';
  else firstIsLeft = straight <= swapped;
  out.left = (firstIsLeft ? cands[0] : cands[1]).points;
  out.right = (firstIsLeft ? cands[1] : cands[0]).points;
  return out;
}

// ---------------------------------------------------------------------------
// 3) 원시 프레임 만들기 (필요한 점만 남긴다)
// ---------------------------------------------------------------------------
// 포즈의 이미지 좌표 z는 실제보다 3~4배 과장되어 나온다(실측). 그래서 깊이는 월드 좌표
// (미터 단위, 비율이 실제 몸에 가깝다)에서 가져와 "이미지 x와 같은 단위"로 바꿔 넣는다.
// 월드 좌표가 없을 때는 이미지 z에 이 배율을 곱해 비슷한 크기로 맞춘다.
const IMAGE_Z_FALLBACK = 0.3;

function poseDepths(pose, world, aspect) {
  const l = world?.[POSE.LEFT_SHOULDER];
  const r = world?.[POSE.RIGHT_SHOULDER];
  const worldWidth = l && r ? Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z) : 0;
  if (!(world?.length >= POSE_COUNT) || !(worldWidth > 1e-6)) {
    return pose.map((p) => (p.z ?? 0) * IMAGE_Z_FALLBACK);
  }
  // 이미지에서 잰 어깨 너비(x 단위) / 월드 어깨 너비 = 월드 z를 이미지 x 단위로 바꾸는 배율
  const a = pose[POSE.LEFT_SHOULDER];
  const b = pose[POSE.RIGHT_SHOULDER];
  const imageWidth = Math.hypot((a.x - b.x) * aspect, a.y - b.y) / aspect;
  return world.map((p) => (p.z / worldWidth) * imageWidth);
}

export function toRawFrame(detection, aspect, ts) {
  const { pose, poseWorld, hands, face } = detection;
  const usablePose = pose && pose.length >= POSE_COUNT ? pose : null;
  const assigned = assignHands(usablePose, hands, aspect);
  const depths = usablePose ? poseDepths(usablePose, poseWorld, aspect) : null;
  return {
    ts,
    pose: usablePose
      ? usablePose.slice(0, POSE_COUNT).map((p, i) => [p.x, p.y, depths[i], p.visibility ?? 1])
      : null,
    left: assigned.left ? assigned.left.map(xyz) : null,
    right: assigned.right ? assigned.right.map(xyz) : null,
    face: face && face.length >= 468 ? FACE_INDICES.map((i) => xyz(face[i])) : null,
  };
}

// ---------------------------------------------------------------------------
// 4) 시간 간격이 들쭉날쭉한 원시 프레임(웹캠)을 일정한 fps로 다시 뽑는다
// ---------------------------------------------------------------------------
function lerpRawPoints(a, b, t) {
  if (!a || !b) return (t < 0.5 ? a : b) ?? null; // 한쪽이 없으면 가까운 쪽을 따른다
  return a.map((p, i) => p.map((v, k) => lerp(v, b[i][k], t)));
}

export function resampleRaw(raw, fps) {
  if (raw.length < 2) return raw.map((f, i) => ({ ...f, ts: i / fps }));
  const t0 = raw[0].ts;
  const count = Math.floor((raw[raw.length - 1].ts - t0) * fps) + 1;
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i / fps;
    while (j < raw.length - 2 && raw[j + 1].ts < t) j++;
    const a = raw[j];
    const b = raw[j + 1];
    const span = b.ts - a.ts;
    const u = span > 0 ? clamp((t - a.ts) / span, 0, 1) : 0;
    out.push({
      ts: i / fps,
      pose: lerpRawPoints(a.pose, b.pose, u),
      left: lerpRawPoints(a.left, b.left, u),
      right: lerpRawPoints(a.right, b.right, u),
      face: lerpRawPoints(a.face, b.face, u),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5) 정규화
// ---------------------------------------------------------------------------

// 한 프레임의 어깨 너비 (x에 화면 비율을 곱해 y와 같은 단위로 맞춘 값)
export function shoulderWidth(rawPose, aspect) {
  const l = rawPose[POSE.LEFT_SHOULDER];
  const r = rawPose[POSE.RIGHT_SHOULDER];
  return Math.hypot((l[0] - r[0]) * aspect, l[1] - r[1]);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 원시 프레임 하나를 정규화한다. 포즈가 없으면 null.
//   aspect: 영상 가로/세로 비율, scale: 어깨 너비(생략하면 이 프레임에서 잰다),
//   depthScale: 몸(포즈) 깊이 z에 곱하는 배율 — 깊이 추정이 과장돼 보일 때 줄인다
export function normalizeFrame(raw, { aspect = 1, scale = null, depthScale = 1, t = 0 } = {}) {
  if (!raw.pose) return null;
  const s = scale ?? shoulderWidth(raw.pose, aspect);
  if (!(s > 1e-6)) return null;
  const ls = raw.pose[POSE.LEFT_SHOULDER];
  const rs = raw.pose[POSE.RIGHT_SHOULDER];
  const ox = (ls[0] + rs[0]) / 2;
  const oy = (ls[1] + rs[1]) / 2;
  const oz = (ls[2] + rs[2]) / 2;

  const nx = (x) => ((x - ox) * aspect) / s; // 이미지 오른쪽 = 보는 사람 오른쪽
  const ny = (y) => -(y - oy) / s;            // 이미지 y는 아래가 +이므로 뒤집는다
  // MediaPipe z는 카메라 쪽이 -, 크기는 x(가로 폭 기준)와 같은 단위
  const relZ = (z, z0) => (-(z - z0) * aspect) / s;

  const pose = raw.pose.map((p) => [
    round4(nx(p[0])),
    round4(ny(p[1])),
    round4(clamp(relZ(p[2], oz) * depthScale, -Z_LIMIT, Z_LIMIT)),
  ]);

  // 손: x, y는 이미지 좌표 그대로, z는 "손목 기준 상대값"이라 포즈 손목 깊이에 붙인다
  const hand = (pts, wristIndex) => {
    if (!pts) return null;
    const anchor = pose[wristIndex][2];
    const z0 = pts[0][2];
    return pts.map((p) => [
      round4(nx(p[0])),
      round4(ny(p[1])),
      round4(clamp(anchor + clamp(relZ(p[2], z0), -HAND_Z_LIMIT, HAND_Z_LIMIT), -Z_LIMIT, Z_LIMIT)),
    ]);
  };

  // 얼굴: z는 코끝 기준 상대값으로 바꿔 포즈 코 깊이에 붙인다
  let face = null;
  if (raw.face) {
    const anchor = pose[POSE.NOSE][2];
    const z0 = raw.face[FACE_NOSE_TIP][2];
    face = raw.face.map((p) => [
      round4(nx(p[0])),
      round4(ny(p[1])),
      round4(clamp(anchor + clamp(relZ(p[2], z0), -FACE_Z_LIMIT, FACE_Z_LIMIT), -Z_LIMIT, Z_LIMIT)),
    ]);
  }

  return {
    t,
    pose,
    left: hand(raw.left, POSE.LEFT_WRIST),
    right: hand(raw.right, POSE.RIGHT_WRIST),
    face,
  };
}

// 클립 전체를 정규화한다.
// - 원점은 프레임마다 어깨 중점으로 잡는다 (몸이 흔들려도 어깨는 제자리).
// - 배율은 클립 전체 어깨 너비의 중앙값 하나만 쓴다 (프레임마다 재면 크기가 떨린다).
// - 포즈가 없는 프레임은 직전(없으면 다음) 프레임의 포즈를 유지하고 손·얼굴은 null로 둔다.
export function normalizeClip(rawFrames, { aspect = 1, depthScale = 1 } = {}) {
  const widths = rawFrames.filter((f) => f.pose).map((f) => shoulderWidth(f.pose, aspect)).filter((w) => w > 1e-6);
  if (!widths.length) return [];
  const scale = median(widths);

  const out = rawFrames.map((f, i) => normalizeFrame(f, { aspect, scale, depthScale, t: i }));
  const firstValid = out.find((f) => f);
  let last = firstValid;
  for (let i = 0; i < out.length; i++) {
    if (out[i]) { last = out[i]; continue; }
    out[i] = { t: i, pose: last.pose.map((p) => [...p]), left: null, right: null, face: null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6) 중립 자세 자동 트리밍
//    앞뒤에서 "두 손목이 어깨보다 lowY 넘게 아래 + 거의 멈춤"인 프레임을 잘라 낼 범위를 찾는다.
//    반환: { start, end } (둘 다 포함) 또는 중립 구간이 전혀 없으면 null
// ---------------------------------------------------------------------------
export function findNeutralTrim(frames, { fps = 30, lowY = -0.8, maxSpeed = 0.6, keep = 3 } = {}) {
  const n = frames.length;
  if (n < 3) return null;
  const wrist = (f, part, poseIndex) => (f[part] ? f[part][0] : f.pose[poseIndex]);
  const isNeutral = (i) => {
    const f = frames[i];
    const g = frames[Math.max(0, i - 1)];
    const h = frames[Math.min(n - 1, i + 1)];
    const span = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) / fps;
    for (const [part, idx] of [['left', POSE.LEFT_WRIST], ['right', POSE.RIGHT_WRIST]]) {
      const w = wrist(f, part, idx);
      if (w[1] > lowY) return false;
      // 손 인식이 켜졌다 꺼지는 순간의 튐을 피하려고 속도는 포즈 손목으로 잰다
      const a = g.pose[idx];
      const b = h.pose[idx];
      const speed = Math.hypot(b[0] - a[0], b[1] - a[1]) / span; // 어깨 너비/초
      if (speed > maxSpeed) return false;
    }
    return true;
  };

  let first = 0;
  while (first < n && isNeutral(first)) first++;
  if (first >= n) return null; // 처음부터 끝까지 중립 자세
  let last = n - 1;
  while (last > first && isNeutral(last)) last--;
  if (first === 0 && last === n - 1) return null;

  // 이어 붙일 때 자연스럽도록 중립 자세를 몇 프레임 남긴다
  return { start: Math.max(0, first - keep), end: Math.min(n - 1, last + keep) };
}
