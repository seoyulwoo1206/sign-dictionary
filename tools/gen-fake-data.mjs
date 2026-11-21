// 테스트용 가짜 동작 데이터 생성기
// 실행: node tools/gen-fake-data.mjs   (프로젝트 폴더에서)
// 실제 수어가 아니라 뷰어·학습·문장 기능을 시험하기 위한 임시 동작이다.
// 진짜 데이터는 recorder.html로 직접 찍어서 덮어쓴다.
//
// 임시 동작이라도 "사람이 움직이는 것처럼" 보이도록 다음을 지킨다.
//  - 손: 실제 손 비율의 관절 모델(관절 각도로 굽힘, 엄지는 맞섬 동작)
//  - 움직임: 최소 저크 궤적 + 곡선 경로 + 스프링 추종(살짝 지나쳤다가 자리 잡음)
//  - 몸: 어깨 들림, 몸통 돌림, 고개·시선, 눈 깜빡임, 미세한 흔들림
//  - 몸통·머리 안으로 손과 팔이 들어가지 않게 밀어낸다

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACE_GROUPS } from '../js/viewer/landmarks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 30;
const DEG = Math.PI / 180;

// ---------- 벡터 ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const r4 = (v) => Math.round(v * 10000) / 10000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);
const sstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
// 최소 저크(minimum jerk) 곡선: 처음과 끝에서 속도·가속도가 0
const minJerk = (u) => { u = clamp01(u); return u * u * u * (10 - 15 * u + 6 * u * u); };
// 사람 팔처럼 빠르게 출발해서 부드럽게 도착하는 비대칭 속도 곡선
const reachProfile = (t) => { t = clamp01(t); return minJerk(t + 0.22 * t * (1 - t)); };
// 여러 점을 지나는 연속 동작용: 양 끝만 가감속하고 가운데는 일정한 속도
function cruiseProfile(t, r = 0.22) {
  t = clamp01(t);
  const ramp = (u) => r * (u * u * u - (u * u * u * u) / 2);
  let v;
  if (t < r) v = ramp(t / r);
  else if (t > 1 - r) v = 1 - r - ramp((1 - t) / r);
  else v = r / 2 + (t - r);
  return v / (1 - r);
}

// 축 a를 중심으로 v를 각도 ang만큼 회전 (로드리게스)
function rotate(v, axis, ang) {
  const k = norm(axis);
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// 가우시안으로 시간축을 다듬는다 (양 끝은 값을 이어 붙여 유지)
function smoothTrack(arr, sigma) {
  if (sigma <= 0) return arr.slice();
  const R = Math.ceil(sigma * 3);
  const w = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const n = arr.length;
  const isVec = Array.isArray(arr[0]);
  return arr.map((_, i) => {
    let sw = 0;
    let acc = isVec ? arr[0].map(() => 0) : 0;
    for (let k = -R; k <= R; k++) {
      const v = arr[clamp(i + k, 0, n - 1)];
      const ww = w[k + R];
      sw += ww;
      if (isVec) acc = acc.map((a, j) => a + v[j] * ww); else acc += v * ww;
    }
    return isVec ? acc.map((a) => a / sw) : acc / sw;
  });
}

// 단어마다 같은 결과가 나오는 난수 (흔들림 위상, 눈 깜빡임 시점)
function makeRng(str) {
  let h = 2166136261;
  for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 쿼터니언 [w, x, y, z] ----------
// 열벡터가 X, Y, Z인 회전행렬 → 쿼터니언
function qFromBasis(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2];
  const m01 = Y[0], m11 = Y[1], m21 = Y[2];
  const m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const l = Math.hypot(w, x, y, z);
  return [w / l, x / l, y / l, z / l];
}
function qRot(q, v) {
  const u = [q[1], q[2], q[3]];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, q[0])), cross(u, t));
}
const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qAngle = (a, b) => 2 * Math.acos(clamp(Math.abs(qDot(a, b)), 0, 1));
// 구면 선형 보간: 방향 벡터를 섞는 것과 달리 손이 일정한 각속도로 돈다
function qSlerp(a, b, t) {
  let d = qDot(a, b);
  let bb = b;
  if (d < 0) { d = -d; bb = b.map((v) => -v); }
  if (d > 0.9995) {
    const q = a.map((v, i) => v + (bb[i] - v) * t);
    const l = Math.hypot(...q);
    return q.map((v) => v / l);
  }
  const th = Math.acos(d);
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return a.map((v, i) => v * sa + bb[i] * sb);
}
// 손바닥 방향 n, 손가락 방향 f → 손의 방향(쿼터니언). 지역 축: Y = 손가락, Z = 손바닥이 향하는 쪽
function orientOf(nIn, fIn) {
  const n = norm(nIn);
  let f = sub(fIn, mul(n, dot(fIn, n)));
  if (len(f) < 0.01) f = Math.abs(n[1]) < 0.9 ? sub([0, 1, 0], mul(n, n[1])) : [0, 0, 1];
  f = norm(f);
  return qFromBasis(cross(f, n), f, n);
}

// ---------- 몸 ----------
// 단위: 어깨 너비 = 1 (어른 기준 약 38cm)
const L_SH = [0.5, 0, 0];
const R_SH = [-0.5, 0, 0];
const UPPER = 0.78;
const FORE = 0.7;
const NECK = [0, 0.5, -0.02];
const HIP_Y = -1.55;

const BASE_POSE = (() => {
  const p = Array.from({ length: 25 }, () => [0, 0, 0]);
  p[0] = [0, 0.82, 0.2];
  p[1] = [0.06, 0.93, 0.15]; p[2] = [0.11, 0.93, 0.14]; p[3] = [0.16, 0.93, 0.12];
  p[4] = [-0.06, 0.93, 0.15]; p[5] = [-0.11, 0.93, 0.14]; p[6] = [-0.16, 0.93, 0.12];
  p[7] = [0.28, 0.87, -0.05]; p[8] = [-0.28, 0.87, -0.05];
  p[9] = [0.07, 0.66, 0.15]; p[10] = [-0.07, 0.66, 0.15];
  p[11] = L_SH; p[12] = R_SH;
  p[23] = [0.36, HIP_Y, 0]; p[24] = [-0.36, HIP_Y, 0];
  return p;
})();

// 얼굴 점: FACE_GROUPS 순서대로 만든다. blink: 0(뜸) ~ 1(감음)
function baseFace({ brow = 0, smile = 0, mouthOpen = 0, blink = 0 } = {}) {
  const pts = [];
  const zFace = (x) => 0.14 - 1.2 * x * x;
  for (const g of FACE_GROUPS) {
    const n = g.indices.length;
    for (let i = 0; i < n; i++) {
      let p;
      switch (g.name) {
        case 'leftBrow': { const x = 0.21 - (0.16 * i) / (n - 1); p = [x, 1.03 + brow - 0.006 * blink + 0.015 * Math.sin((Math.PI * i) / (n - 1)), 0]; break; }
        case 'rightBrow': { const x = -0.21 + (0.16 * i) / (n - 1); p = [x, 1.03 + brow - 0.006 * blink + 0.015 * Math.sin((Math.PI * i) / (n - 1)), 0]; break; }
        case 'leftEye':
        case 'rightEye': {
          const cx = g.name === 'leftEye' ? 0.115 : -0.115;
          // 0: 안쪽/바깥쪽 꼭짓점부터 위 → 반대 꼭짓점 → 아래
          const a = (Math.PI * 2 * i) / n;
          const sgn = g.name === 'leftEye' ? -1 : 1;
          // 눈을 감으면 윗눈꺼풀이 아랫눈꺼풀까지 내려온다
          const up = Math.sin(a);
          const lid = up > 0 ? up * (1 - blink) - 0.75 * up * blink : up * (1 - 0.15 * blink);
          p = [cx + sgn * 0.05 * Math.cos(a), 0.93 + 0.02 * lid + brow * 0.2, 0];
          break;
        }
        case 'outerLips':
        case 'innerLips': {
          const w = g.name === 'outerLips' ? 0.1 : 0.07;
          const h = g.name === 'outerLips' ? 0.035 : 0.012 + mouthOpen;
          // 61(오른쪽 입꼬리)에서 시작해 위 → 왼쪽 → 아래
          const a = (Math.PI * 2 * i) / n;
          const x = -w * Math.cos(a);
          let y = 0.66 + h * Math.sin(a);
          if (g.name === 'outerLips' && Math.sin(a) < 0) y -= mouthOpen;
          y += smile * Math.pow(Math.abs(Math.cos(a)), 3);
          p = [x, y, 0];
          break;
        }
        case 'nose': { const t = i / (n - 1); p = [0, 0.92 - 0.14 * t, 0.06 + 0.12 * t]; break; }
        case 'oval': {
          const a = Math.PI / 2 - (Math.PI * 2 * i) / n; // 위(10)에서 시작해 +x 쪽으로
          const x = 0.3 * Math.cos(a);
          p = [x, 0.82 + 0.4 * Math.sin(a), 0];
          // 입을 벌리면 턱도 조금 내려간다
          if (Math.sin(a) < -0.5) p[1] -= mouthOpen * 0.6 * (-Math.sin(a) - 0.5) * 2;
          p[2] = zFace(x) - 0.08;
          break;
        }
      }
      if (g.name !== 'oval' && g.name !== 'nose') p[2] = zFace(p[0]);
      pts.push(p);
    }
  }
  return pts;
}

// ---------- 몸의 부피 (손·팔이 뚫고 들어가지 않게 하는 데 쓴다) ----------
// 몸통: 마네킹 뷰어의 몸통 단면과 같은 모양 (높이 0 = 엉덩이, 1 = 어깨). 가로 반지름 0.5r, 앞뒤 반지름 0.285r
const TORSO_PROFILE = [
  [0.62, 0], [0.66, 0.08], [0.6, 0.32], [0.64, 0.5], [0.76, 0.72],
  [0.85, 0.88], [0.84, 0.97], [0.7, 1.04], [0.42, 1.09], [0.16, 1.11],
];
const TORSO_RX = 0.5;
const TORSO_RZ = 0.285;
function torsoRadius(yf) {
  const P = TORSO_PROFILE;
  if (yf <= 0) return P[0][0];
  const last = P[P.length - 1];
  if (yf >= last[1]) return last[0] - (yf - last[1]) * 8; // 어깨 위로는 빠르게 닫힌다
  for (let i = 1; i < P.length; i++) {
    if (yf <= P[i][1]) {
      const t = (yf - P[i - 1][1]) / (P[i][1] - P[i - 1][1]);
      return P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t;
    }
  }
  return last[0];
}
const torsoField = (q) => Math.hypot(q[0] / TORSO_RX, q[2] / TORSO_RZ) - torsoRadius((q[1] - HIP_Y) / -HIP_Y);
// 머리: 얼굴 윤곽을 감싸는 타원체
const HEAD_C = [0, 0.62, -0.08];
const HEAD_R = [0.25, 0.33, 0.24];
const headField = (q) => Math.hypot((q[0] - HEAD_C[0]) / HEAD_R[0], (q[1] - HEAD_C[1]) / HEAD_R[1], (q[2] - HEAD_C[2]) / HEAD_R[2]) - 1;
// 목: 캡슐
const NECK_A = [0, 0.1, -0.03];
const NECK_B = [0, 0.4, -0.05];
const NECK_RAD = 0.115;
function neckDist(q) {
  const ab = sub(NECK_B, NECK_A);
  const t = clamp01(dot(sub(q, NECK_A), ab) / dot(ab, ab));
  const c = add(NECK_A, mul(ab, t));
  const v = sub(q, c);
  const l = len(v) || 1e-6;
  return { d: l - NECK_RAD, g: mul(v, 1 / l) };
}
const SHOULDER_RAD = 0.15;
// 음함수 F(=0이 표면)를 거리 근삿값 F/|∇F|와 바깥 방향으로 바꾼다
function fieldDist(F, q) {
  const h = 0.004;
  const f0 = F(q);
  const g = [
    (F([q[0] + h, q[1], q[2]]) - F([q[0] - h, q[1], q[2]])) / (2 * h),
    (F([q[0], q[1] + h, q[2]]) - F([q[0], q[1] - h, q[2]])) / (2 * h),
    (F([q[0], q[1], q[2] + h]) - F([q[0], q[1], q[2] - h])) / (2 * h),
  ];
  const gl = len(g) || 1e-6;
  return { d: f0 / gl, g: mul(g, 1 / gl) };
}
// 몸 표면까지의 거리(안쪽이면 음수)와 바깥으로 나가는 방향
function bodyDist(q, withShoulders = true) {
  // 몸통은 위아래가 아니라 앞·옆으로만 밀어낸다 (어깨 경사에서 손이 위로 튀어 오르지 않게)
  const h = 0.004;
  const gx = (torsoField([q[0] + h, q[1], q[2]]) - torsoField([q[0] - h, q[1], q[2]])) / (2 * h);
  const gz = (torsoField([q[0], q[1], q[2] + h]) - torsoField([q[0], q[1], q[2] - h])) / (2 * h);
  const gl = Math.hypot(gx, gz) || 1e-6;
  let best = { d: torsoField(q) / gl, g: [gx / gl, 0, gz / gl] };
  if (withShoulders && q[1] > -0.3) {
    // 어깨(삼각근): 손이 어깨 관절을 뚫고 지나가지 않게 한다
    const sx = q[0] < 0 ? -0.5 : 0.5;
    const sv = [q[0] - sx, q[1] + 0.02, q[2]];
    const sl = len(sv) || 1e-6;
    if (sl - SHOULDER_RAD < best.d) best = { d: sl - SHOULDER_RAD, g: mul(sv, 1 / sl) };
  }
  if (q[1] > -0.15) {
    const nk = neckDist(q);
    if (nk.d < best.d) best = nk;
    const hd = fieldDist(headField, q);
    if (hd.d < best.d) best = hd;
  }
  return best;
}

// ---------- 손 ----------
// 손 모양 = 관절 각도 13개
//   [0..3]  엄지: 손바닥 앞으로 세움(맞섬), 옆으로 벌림, MCP 굽힘, IP 굽힘
//   [4..11] 검지·중지·약지·새끼의 [MCP 굽힘, PIP 굽힘] (DIP는 PIP의 0.67배로 따라 굽는다)
//   [12]    손가락 사이 벌림 (1 = 활짝, 0 = 붙임, 음수 = 끝을 모음)
const FIST_F = [[84, 100], [86, 102], [86, 100], [84, 96]];
const SHAPE_DEFS = {
  //          엄지(초깃값)       손가락 [MCP, PIP] × 4                              벌림  엄지가 닿는 곳
  open:    { th: [8, 46, 3, 3],    fg: [[2, 3], [1, 3], [3, 4], [5, 6]], sp: 0.7 },
  relaxed: { th: [28, 32, 12, 18], fg: [[18, 28], [25, 36], [31, 43], [36, 50]], sp: 0.35 },
  fist:    { th: [45, 25, 30, 45], fg: FIST_F, sp: 0, wrap: [0, 1] },
  point:   { th: [48, 18, 30, 45], fg: [[3, 4], FIST_F[1], FIST_F[2], FIST_F[3]], sp: 0, wrap: [1] },
  two:     { th: [50, 10, 32, 45], fg: [[3, 4], [2, 3], FIST_F[2], FIST_F[3]], sp: 1, wrap: [2] },
  three:   { th: [52, 5, 35, 50],  fg: [[3, 4], [2, 3], [3, 4], FIST_F[3]], sp: 0.8, wrap: [3] },
  thumb:   { th: [6, 55, 0, -5],   fg: FIST_F, sp: 0 },
  pinky:   { th: [45, 25, 30, 45], fg: [FIST_F[0], FIST_F[1], FIST_F[2], [4, 5]], sp: 1, wrap: [0, 1] },
  pinch:   { th: [45, 30, 15, 30], fg: [[55, 70], FIST_F[1], FIST_F[2], FIST_F[3]], sp: 0, tips: [0] },
  bunch:   { th: [50, 25, 10, 20], fg: [[72, 45], [74, 43], [72, 45], [68, 50]], sp: -0.7, tips: [0, 1] },
  cup:     { th: [38, 38, 10, 18], fg: [[32, 36], [34, 38], [36, 40], [38, 42]], sp: 0.1 },
  claw:    { th: [30, 50, 20, 45], fg: [[12, 78], [10, 80], [12, 78], [16, 74]], sp: 1 },
  ok:      { th: [45, 30, 15, 30], fg: [[50, 72], [10, 10], [5, 7], [2, 6]], sp: 0.9, tips: [0] },
  y:       { th: [5, 62, 0, 0],    fg: [FIST_F[0], FIST_F[1], FIST_F[2], [3, 4]], sp: 1 },
  l:       { th: [3, 72, 0, 0],    fg: [[3, 4], FIST_F[1], FIST_F[2], FIST_F[3]], sp: 0 },
};

// 손 뼈대 치수 (손바닥 중심 기준, [손가락 방향 f, 엄지 쪽 s, 손바닥 쪽 n])
const HAND = {
  wrist: [-0.13, 0, 0],
  thumbBase: [-0.092, 0.055, 0.012],
  thumbSegs: [0.106, 0.08, 0.064],
  // 손허리뼈 머리(MCP)는 가운데가 솟은 아치 모양이다
  fingers: [
    { mcp: [0.105, 0.07, 0.004], segs: [0.105, 0.06, 0.048], abd: 9 },
    { mcp: [0.117, 0.021, -0.006], segs: [0.117, 0.068, 0.05], abd: 1.5 },
    { mcp: [0.107, -0.028, -0.002], segs: [0.108, 0.064, 0.05], abd: -6 },
    { mcp: [0.09, -0.074, 0.008], segs: [0.085, 0.047, 0.044], abd: -15 },
  ],
};
const DIP_RATIO = 0.67;

// 손 21점 생성. side: 'R' | 'L', c: 손바닥 중심, n: 손바닥이 향하는 방향, f: 손가락 방향(n과 수직), h: 관절 각도 13개(라디안)
function buildHand(side, c, n, f, h) {
  const s = side === 'R' ? cross(f, n) : mul(cross(f, n), -1); // 엄지 쪽
  const at = (v) => [
    c[0] + f[0] * v[0] + s[0] * v[1] + n[0] * v[2],
    c[1] + f[1] * v[0] + s[1] * v[1] + n[1] * v[2],
    c[2] + f[2] * v[0] + s[2] * v[1] + n[2] * v[2],
  ];
  const pts = new Array(21);
  pts[0] = at(HAND.wrist);
  // 엄지: 손목 옆(CMC)에서 시작. 맞섬 각 a만큼 손바닥 앞으로 서고, b만큼 옆으로 벌어진다.
  {
    const [a, b, m, ip] = h;
    const dM = [Math.cos(b) * Math.cos(a), Math.sin(b) * Math.cos(a), Math.sin(a)];
    // 굽히는 방향: 손바닥을 가로질러 새끼손가락 쪽으로
    const w = [0, -1, 0.35];
    const gRaw = sub(w, mul(dM, dot(w, dM)));
    const g = norm(gRaw);
    const turn = (ang) => add(mul(dM, Math.cos(ang)), mul(g, Math.sin(ang)));
    let p = HAND.thumbBase;
    pts[1] = at(p);
    const angs = [0, m, m + ip];
    for (let j = 0; j < 3; j++) {
      p = add(p, mul(turn(angs[j]), HAND.thumbSegs[j]));
      pts[2 + j] = at(p);
    }
  }
  // 나머지 손가락: 벌림은 굽힐수록 줄어들고, 세 마디가 같은 평면에서 손바닥 쪽으로 말린다
  const spread = h[12];
  for (let fi = 0; fi < 4; fi++) {
    const fg = HAND.fingers[fi];
    const mcp = h[4 + fi * 2];
    const pip = h[5 + fi * 2];
    const abd = fg.abd * DEG * spread * clamp01(1 - mcp / (70 * DEG));
    const d0 = [Math.cos(abd), Math.sin(abd), 0];
    let p = fg.mcp;
    pts[5 + fi * 4] = at(p);
    const angs = [mcp, mcp + pip, mcp + pip + pip * DIP_RATIO];
    for (let j = 0; j < 3; j++) {
      const ca = Math.cos(angs[j]), sa = Math.sin(angs[j]);
      p = add(p, mul([d0[0] * ca, d0[1] * ca, sa], fg.segs[j]));
      pts[6 + fi * 4 + j] = at(p);
    }
  }
  return pts;
}

// 엄지가 닿아야 하는 곳(집기: 손가락 끝, 주먹: 말아 쥔 손가락 위)을 찾아 엄지 각도를 맞춘다
function solveShape(def) {
  const h = [...def.th.map((v) => v * DEG), ...def.fg.flat().map((v) => v * DEG), def.sp];
  if (!def.tips && !def.wrap) return h;
  const I = [[0, 0, 1], [0, 1, 0]]; // n, f
  const build = (hh) => buildHand('R', [0, 0, 0], I[0], I[1], hh);
  const base = build(h);
  let target;
  let gap;
  if (def.tips) {
    // 손가락 끝과 엄지 끝의 살이 맞닿는다 (관절 중심끼리는 조금 떨어짐)
    target = mul(def.tips.reduce((acc, fi) => add(acc, base[8 + fi * 4]), [0, 0, 0]), 1 / def.tips.length);
    gap = 0.024;
  } else {
    // 말아 쥔 손가락의 가운데 마디 바깥쪽에 엄지를 얹는다
    target = [0, 0, 0];
    for (const fi of def.wrap) {
      const mid = mix(base[6 + fi * 4], base[7 + fi * 4], 0.5);
      const out = norm(sub(mid, base[5 + fi * 4]));
      target = add(target, add(mid, mul(out, 0.036)));
    }
    target = mul(target, 1 / def.wrap.length);
    gap = 0;
  }
  const lo = [0, -10, -5, -10].map((v) => v * DEG);
  const hi = [75, 80, 60, 80].map((v) => v * DEG);
  const init = h.slice(0, 4);
  const cost = (th) => {
    const hh = [...th, ...h.slice(4)];
    const tip = build(hh)[4];
    const e = len(sub(tip, target)) - gap;
    let reg = 0;
    for (let i = 0; i < 4; i++) reg += ((th[i] - init[i]) / (hi[i] - lo[i])) ** 2;
    return e * e + 0.0004 * reg;
  };
  let th = init.slice();
  let best = cost(th);
  let step = 12 * DEG;
  for (let it = 0; it < 60 && step > 0.05 * DEG; it++) {
    let improved = false;
    for (let i = 0; i < 4; i++) {
      for (const sgn of [1, -1]) {
        const t2 = th.slice();
        t2[i] = clamp(t2[i] + sgn * step, lo[i], hi[i]);
        const c2 = cost(t2);
        if (c2 < best - 1e-12) { best = c2; th = t2; improved = true; }
      }
    }
    if (!improved) step /= 2;
  }
  return [...th, ...h.slice(4)];
}
const SHAPES = Object.fromEntries(Object.entries(SHAPE_DEFS).map(([k, def]) => [k, solveShape(def)]));

// 손가락이 한꺼번에 움직이지 않게 하는 시간차 (엄지, 검지, 중지, 약지, 새끼 / 구간 길이에 대한 비율)
const FINGER_LAG = [0.05, 0, 0.035, 0.07, 0.105];
const groupOf = (i) => (i < 4 ? 0 : i < 12 ? 1 + ((i - 4) >> 1) : 5);

// ---------- 키포즈 ----------
const DIR = {
  up: [0, 1, 0], down: [0, -1, 0], fwd: [0, 0, 1], back: [0, 0, -1],
  vl: [1, 0, 0], vr: [-1, 0, 0], // 보는 사람 기준 오른쪽(vl=+x는 수어하는 사람의 왼쪽)
};
const dirOf = (d) => (typeof d === 'string' ? DIR[d] : d);

// 중립 자세: 두 팔을 몸 옆으로 편하게 내린 상태 (손바닥이 허벅지를 향함)
const NEUTRAL = {
  R: { p: [-0.6, -1.47, 0.13], n: [0.85, 0.05, -0.4], f: [0.05, -1, 0.28], s: 'relaxed' },
  L: { p: [0.6, -1.47, 0.13], n: [-0.85, 0.05, -0.4], f: [-0.05, -1, 0.28], s: 'relaxed' },
};

function handState(h) {
  return { p: h.p, q: orientOf(dirOf(h.n), dirOf(h.f)), h: SHAPES[h.s], shape: h.s };
}

// 이동에 걸리는 프레임 수: 멀수록 오래 걸리지만 거리에 비례하지는 않는다 (피츠의 법칙과 비슷하게)
function moveFrames(a, b) {
  const dist = len(sub(b.p, a.p));
  const ang = qAngle(a.q, b.q);
  let dh = 0;
  for (let i = 0; i < 12; i++) dh = Math.max(dh, Math.abs(a.h[i] - b.h[i]));
  if (dist < 0.004 && ang < 0.03 && dh < 0.05) return 0;
  // 손을 돌리면 손끝이 그만큼 먼 길을 가므로 회전도 거리로 친다
  const reach = 4 + 9 * Math.pow(dist + 0.24 * ang, 0.6);
  const shape = dh > 0.3 ? 6 + 3 * Math.min(1, dh) : 0;
  return Math.max(reach, shape);
}

// 두 지점 사이의 경로: 직선이 아니라 몸 바깥(앞·위)으로 살짝 부푼 호
// 지나가는 동안에는 몸통·머리와 자기 어깨에서 넉넉히 떨어져서 돌아간다
// (배에서 반대쪽 어깨로 갈 때 몸을 뚫지 않고 앞으로 돌아가도록). 출발·도착 지점은 건드리지 않는다.
function arcPoint(a, b, s, side) {
  const chord = sub(b, a);
  const dist = len(chord);
  if (dist < 1e-6) return a;
  const dir = mul(chord, 1 / dist);
  const out = [0, 0.45, 0.9];
  const perp = sub(out, mul(dir, dot(out, dir)));
  const bulge = Math.min(0.28, 0.14 * dist);
  const lift = Math.sin(Math.PI * s);
  let p = add(mix(a, b, s), mul(perp, bulge * lift));
  const need = lift * Math.min(1, dist / 0.7);
  for (let it = 0; it < 2; it++) {
    const { d, g } = bodyDist(p, false);
    const lack = 0.2 * need - d;
    if (lack > 0) p = add(p, mul(g, lack));
  }
  // 자기 어깨 바로 앞을 지날 때는 앞으로 더 크게 돌아간다 (팔꿈치가 갑자기 꺾이지 않게)
  const sh = side === 'R' ? R_SH : L_SH;
  const near = Math.exp(-((p[0] - sh[0]) ** 2 + (p[1] - sh[1]) ** 2) / (2 * 0.5 * 0.5));
  const lackZ = 0.55 * need * near - (p[2] - sh[2]);
  if (lackZ > 0) p = [p[0], p[1], p[2] + lackZ];
  return p;
}

function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return [0, 1, 2].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
}

// 한 구간에서 손의 상태. t: 0~1 (구간 진행률)
function moveHand(a, b, t, side) {
  if (a === b) return { p: a.p, q: a.q, h: a.h };
  // 손 모양은 이동보다 먼저 완성된다(목표 지점에 닿기 전에 모양을 잡음).
  // 힘을 푸는 쪽(중립으로 돌아갈 때)은 반대로 이동보다 늦게 풀린다.
  const relaxing = b.shape === 'relaxed';
  const start = relaxing ? 0.18 : 0;
  const span = relaxing ? 0.72 : 0.68;
  const h = a.h.map((v, i) => {
    if (v === b.h[i]) return v;
    const lag = FINGER_LAG[groupOf(i)] ?? 0.03;
    return v + (b.h[i] - v) * minJerk((t - start - lag) / span);
  });
  return {
    p: arcPoint(a.p, b.p, reachProfile(t), side),
    // 손목 방향은 위치보다 조금 일찍 자리를 잡는다
    q: qSlerp(a.q, b.q, minJerk(t / 0.88)),
    h,
  };
}

const lerpObj = (a, b, t) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] - a[k]) * t]));

// ---------- 키포즈 목록 → 프레임 목록 ----------
// key: { r?, l?, d: 이동 프레임(최소값), hold?: 정지 프레임, via?: 멈추지 않고 지나감,
//        face?: {brow, smile, mouthOpen}, head?: {nod, shake} }
function animate(keys, seed, { blinkChance = 1 } = {}) {
  const rng = makeRng(seed);
  const T = { R: { p: [], q: [], h: [] }, L: { p: [], q: [], h: [] }, face: [], head: [] };
  const push = (st) => {
    for (const side of ['R', 'L']) { T[side].p.push(st[side].p); T[side].q.push(st[side].q); T[side].h.push(st[side].h); }
    T.face.push(st.face);
    T.head.push(st.head);
  };
  const FACE0 = { brow: 0, smile: 0, mouthOpen: 0 };
  const HEAD0 = { nod: 0, shake: 0 };
  let cur = { R: handState(NEUTRAL.R), L: handState(NEUTRAL.L), face: FACE0, head: HEAD0 };
  for (let i = 0; i < 4; i++) push(cur);

  const all = [...keys, { r: NEUTRAL.R, l: NEUTRAL.L, d: 12, hold: 8, face: FACE0, head: HEAD0 }];
  let ki = 0;
  while (ki < all.length) {
    // via로 표시된 키는 멈추지 않고 지나가므로 다음 멈춤까지 한 구간으로 묶는다
    const group = [];
    while (all[ki].via && ki < all.length - 1) group.push(all[ki++]);
    group.push(all[ki++]);
    const way = [cur];
    for (const k of group) {
      const prev = way[way.length - 1];
      way.push({
        R: k.r ? handState(k.r) : prev.R,
        L: k.l ? handState(k.l) : prev.L,
        face: { ...prev.face, ...(k.face || {}) },
        head: { ...HEAD0, ...(k.head || {}) },
      });
    }
    const target = way[way.length - 1];
    const last = group[group.length - 1];
    if (way.length === 2) {
      // 한 번에 가는 동작
      let n = Math.max(moveFrames(cur.R, target.R), moveFrames(cur.L, target.L), 0.8 * (last.d ?? 8));
      // 힘을 빼고 내려놓는 동작은 조금 더 느긋하다
      if (target.R.shape === 'relaxed' && target.L.shape === 'relaxed') n *= 1.12;
      n = Math.max(4, Math.round(n));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = minJerk(t);
        push({
          R: moveHand(cur.R, target.R, t, 'R'),
          L: moveHand(cur.L, target.L, t, 'L'),
          face: lerpObj(cur.face, target.face, e),
          head: lerpObj(cur.head, target.head, e),
        });
      }
    } else {
      // 여러 점을 멈추지 않고 지나는 동작 (원 그리기 등)
      const ds = group.map((k) => k.d ?? 4);
      const total = ds.reduce((a, b) => a + b, 0);
      const cum = [0];
      for (const d of ds) cum.push(cum[cum.length - 1] + d / total);
      const n = Math.max(6, Math.round(total));
      const W = (side, i) => way[clamp(i, 0, way.length - 1)][side].p;
      for (let i = 1; i <= n; i++) {
        const w = cruiseProfile(i / n);
        let k = 0;
        while (k < cum.length - 2 && w > cum[k + 1]) k++;
        const u = clamp01((w - cum[k]) / (cum[k + 1] - cum[k]));
        const A = way[k], B = way[k + 1];
        const st = { face: lerpObj(A.face, B.face, u), head: lerpObj(A.head, B.head, u) };
        for (const side of ['R', 'L']) {
          st[side] = {
            p: catmullRom(W(side, k - 1), W(side, k), W(side, k + 1), W(side, k + 2), u),
            q: qSlerp(A[side].q, B[side].q, u),
            h: A[side].h.map((v, j) => v + (B[side].h[j] - v) * u),
          };
        }
        push(st);
      }
    }
    cur = target;
    for (let i = 0; i < (last.hold ?? 0); i++) push(cur);
  }
  return finish(T, rng, blinkChance);
}

// 스프링-댐퍼로 목표점을 따라가게 한다: 살짝 늦게 출발하고, 도착해서 조금 지나쳤다가 자리 잡는다.
// 방향이 바뀌는 곳(왕복 동작)도 모서리 없이 둥글게 이어진다.
function springFollow(target, omega = 30, zeta = 0.66) {
  const SUB = 8;
  const dt = 1 / FPS / SUB;
  let x = target[0];
  let v = [0, 0, 0];
  const out = [x];
  for (let i = 1; i < target.length; i++) {
    for (let s = 1; s <= SUB; s++) {
      const g = mix(target[i - 1], target[i], s / SUB);
      const a = sub(mul(sub(g, x), omega * omega), mul(v, 2 * zeta * omega));
      v = add(v, mul(a, dt));
      x = add(x, mul(v, dt));
    }
    out.push(x);
  }
  return out;
}

// 손 전체(21점)를 몸 밖으로 밀어내는 데 필요한 이동량
const HAND_MARGIN = 0.036; // 손가락 굵기 절반 + 여유
const WRIST_MARGIN = 0.055;
function handPushOut(pts, start = [0, 0, 0]) {
  let off = start;
  for (let it = 0; it < 6; it++) {
    let worst = 0;
    let dir = null;
    for (let i = 0; i < 21; i++) {
      const { d, g } = bodyDist(add(pts[i], off));
      const need = (i === 0 ? WRIST_MARGIN : HAND_MARGIN) - d;
      if (need > worst) { worst = need; dir = g; }
    }
    if (!dir || worst < 1e-4) break;
    off = add(off, mul(dir, worst));
  }
  return off;
}

// 손 궤적 전체를 몸 밖으로 밀어낸다. 이동량을 시간축으로 다듬어 닿는 순간이 덜 딱딱하게 하고,
// 다듬으면서 모자라진 만큼은 한 번 더 밀어 채운다.
function pushHands(track) {
  const raw = track.map((pts) => handPushOut(pts));
  // 빠르게 스쳐 지나갈 때 한 프레임만 툭 밀리지 않도록, 앞뒤 프레임 중 가장 큰 이동량을 쓰고 다듬는다
  let off = raw.map((_, i) => {
    let best = raw[i];
    for (let k = -2; k <= 2; k++) { const o = raw[clamp(i + k, 0, raw.length - 1)]; if (len(o) > len(best)) best = o; }
    return best;
  });
  off = smoothTrack(off, 1.6);
  off = off.map((o, i) => handPushOut(track[i], o));
  return track.map((pts, i) => pts.map((q) => add(q, off[i])));
}

// ---------- 팔 IK ----------
// 어깨와 손목이 정해지면 팔꿈치는 둘을 잇는 축 둘레의 원 위 어디든 올 수 있다.
// 그 원 위에서 사람이 편하게 느끼는 자리를 고른다.
function armCircle(sh, wrist) {
  const d = sub(wrist, sh);
  const dist = clamp(len(d), Math.abs(UPPER - FORE) + 0.02, UPPER + FORE - 0.002);
  const axis = norm(d);
  const x = (UPPER * UPPER - FORE * FORE + dist * dist) / (2 * dist);
  const hgt = Math.sqrt(Math.max(0, UPPER * UPPER - x * x));
  const ref = Math.abs(axis[1]) < 0.9 ? [0, -1, 0] : [0, 0, -1];
  const u = norm(sub(ref, mul(axis, dot(ref, axis))));
  const v = cross(axis, u);
  const base = add(sh, mul(axis, x));
  return {
    base, hgt, axis,
    dir: (th) => add(mul(u, Math.cos(th)), mul(v, Math.sin(th))),
    // 임의의 점을 원 위로 옮긴다
    snap: (p) => {
      const r = sub(p, base);
      const flat = sub(r, mul(axis, dot(r, axis)));
      return add(base, mul(norm(len(flat) > 1e-6 ? flat : u), hgt));
    },
  };
}
// 팔(위팔 아래쪽, 팔꿈치, 아래팔)이 몸에서 얼마나 떨어져 있는지 (음수면 파고듦)
function armClearance(sh, elbow, wrist) {
  let c = bodyDist(elbow, false).d - 0.075;
  for (const t of [0.2, 0.4, 0.6, 0.8]) c = Math.min(c, bodyDist(mix(elbow, wrist, t), false).d - (0.07 - 0.02 * t));
  for (const t of [0.55, 0.78]) c = Math.min(c, bodyDist(mix(sh, elbow, t), false).d - 0.06);
  return c;
}
const SWIVEL_N = 72;
// 팔꿈치 자리의 "불편함". 위팔을 옆으로 벌리거나 뒤로 젖히는 것은 앞으로 드는 것보다 힘들다.
function elbowCost(side, sh, el, wrist, fingerDir) {
  const out = side === 'R' ? -1 : 1;
  const u = mul(sub(el, sh), 1 / UPPER);
  // 가장 편한 자리는 살짝 벌어지고 살짝 뒤로 간 곳
  const abd = out * u[0] - 0.16;
  const flex = Math.max(0, u[2] + 0.08);
  const ext = Math.max(0, -u[2] - 0.08);
  const extOver = Math.max(0, -u[2] - 0.6);
  // 손목이 지나치게 꺾이지 않는 쪽을 좋아한다
  const bend = Math.acos(clamp(dot(norm(sub(wrist, el)), fingerDir), -1, 1));
  const over = Math.max(0, bend - 35 * DEG);
  const pen = Math.max(0, 0.025 - armClearance(sh, el, wrist));
  // 팔꿈치를 어깨 위로 들거나 몸 가운데 쪽으로 넣는 것은 더 힘들다
  const lift = Math.max(0, el[1] - sh[1] + 0.12);
  const inward = Math.max(0, 0.34 - out * el[0]);
  // 팔꿈치는 무게 때문에 되도록 아래에 있으려 한다
  return 0.7 * (1 + u[1]) + 1.5 * abd * abd + 0.45 * flex * flex + 2.6 * ext * ext + 25 * extOver * extOver
    + 0.3 * over * over + 4000 * pen * pen + 7 * lift * lift + 22 * inward * inward;
}
// 프레임마다 따로 고르면 팔꿈치가 튀므로, 전체 시간에 걸쳐 가장 편하면서 매끄러운 경로를 고른다 (동적 계획법)
function solveElbows(side, shoulders, wrists, fingerDirs) {
  const N = wrists.length;
  const circles = wrists.map((w, i) => armCircle(shoulders[i], w));
  const dirs = [], costs = [];
  for (let i = 0; i < N; i++) {
    const c = circles[i];
    const dRow = [], cRow = [];
    for (let k = 0; k < SWIVEL_N; k++) {
      const e = c.dir((2 * Math.PI * k) / SWIVEL_N);
      dRow.push(e);
      cRow.push(elbowCost(side, shoulders[i], add(c.base, mul(e, c.hgt)), wrists[i], fingerDirs[i]));
    }
    dirs.push(dRow);
    costs.push(cRow);
  }
  const still = costs.map((row) => row.slice());
  const JUMP = 5;
  // 처음과 끝은 멈춰 있는 중립 자세이므로 그 자세에서 가장 편한 자리로 고정한다
  const pin = (row) => { const m = row.indexOf(Math.min(...row)); return row.map((c, k) => (k === m ? c : c + 1e6)); };
  costs[0] = pin(costs[0]);
  costs[N - 1] = pin(costs[N - 1]);
  let acc = costs[0].slice();
  const back = [];
  for (let i = 1; i < N; i++) {
    const nb = new Array(SWIVEL_N);
    const na = new Array(SWIVEL_N);
    for (let k = 0; k < SWIVEL_N; k++) {
      let best = Infinity, bj = 0;
      const e = dirs[i][k];
      for (let j = 0; j < SWIVEL_N; j++) {
        const p = dirs[i - 1][j];
        const dd = (e[0] - p[0]) ** 2 + (e[1] - p[1]) ** 2 + (e[2] - p[2]) ** 2;
        const c = acc[j] + JUMP * dd;
        if (c < best) { best = c; bj = j; }
      }
      na[k] = best + costs[i][k];
      nb[k] = bj;
    }
    back.push(nb);
    acc = na;
  }
  let k = acc.indexOf(Math.min(...acc));
  const pick = new Array(N);
  for (let i = N - 1; i >= 0; i--) { pick[i] = k; if (i > 0) k = back[i - 1][k]; }
  // 격자 사이의 실제 최소점을 포물선으로 찾아 계단을 줄인다 (멈춰 있을 때 늘 같은 자리에 오도록)
  const raw = pick.map((kk, i) => {
    const c0 = still[i][(kk + SWIVEL_N - 1) % SWIVEL_N], c1 = still[i][kk], c2 = still[i][(kk + 1) % SWIVEL_N];
    const den = c0 - 2 * c1 + c2;
    const frac = den > 1e-9 ? clamp((0.5 * (c0 - c2)) / den, -0.5, 0.5) : 0;
    return add(circles[i].base, mul(circles[i].dir((2 * Math.PI * (kk + frac)) / SWIVEL_N), circles[i].hgt));
  });
  // 격자에서 고른 값이라 계단이 지므로 다듬은 뒤 다시 원 위에 올린다
  // (처음과 끝 프레임은 다듬지 않아 모든 동작이 똑같은 중립 자세로 시작하고 끝난다)
  const smooth = smoothTrack(raw, 2.2).map((p, i) => mix(raw[i], p, sstep(0, 5, i) * sstep(0, 5, N - 1 - i)));
  const out = smooth.map((p, i) => {
    const c = circles[i];
    let el = c.snap(p);
    // 다듬다가 몸에 닿게 됐으면 다듬기 전 위치 쪽으로 되돌린다
    for (let s = 1; s <= 4 && armClearance(shoulders[i], el, wrists[i]) < 0.004; s++) el = c.snap(mix(p, raw[i], s / 4));
    return el;
  });
  return out;
}

// 손목이 꺾일 수 있는 한계를 넘으면 손을 아래팔 쪽으로 돌려 준다.
// 수어에서는 손이 있는 자리가 중요하므로 손바닥 중심은 그대로 두고 돌린다 (손목이 조금 옮겨진다).
const WRIST_FREE = 50 * DEG;
const WRIST_MAX = 78 * DEG;
// 반환: 손을 돌릴 회전 벡터(축 × 각도). 한계 안이면 0
function wristTurn(pts, elbow, fingerDir) {
  const fore = norm(sub(pts[0], elbow));
  const ang = Math.acos(clamp(dot(fore, fingerDir), -1, 1));
  if (ang <= WRIST_FREE) return [0, 0, 0];
  const room = WRIST_MAX - WRIST_FREE;
  const lim = WRIST_FREE + room * (1 - Math.exp(-(ang - WRIST_FREE) / room));
  let axis = cross(fingerDir, fore);
  if (len(axis) < 1e-4) axis = cross(fingerDir, [0, 1, 0]);
  return mul(norm(axis), ang - lim);
}
function applyTurn(pts, fingerDir, turn) {
  const ang = len(turn);
  if (ang < 1e-5) return { pts, f: fingerDir };
  const c = add(pts[0], mul(fingerDir, -HAND.wrist[0]));
  return { pts: pts.map((q) => add(c, rotate(sub(q, c), turn, ang))), f: rotate(fingerDir, turn, ang) };
}

function headTransform(p, head) {
  let q = sub(p, NECK);
  if (head.tilt) q = rotate(q, [0, 0, 1], head.tilt);
  if (head.nod) q = rotate(q, [1, 0, 0], head.nod);
  if (head.shake) q = rotate(q, [0, 1, 0], head.shake);
  return add(q, NECK);
}

// 얼굴 근처 좌표를 실제 체형 비율(머리 작게, 목 짧게)로 옮긴다.
// 동작 정의는 예전 좌표로 적혀 있어서, 손 목표 위치에도 같은 변환을 적용해 얼굴과 손이 맞게 한다.
function toBody(p) {
  const t = Math.max(0, Math.min(1, (p[1] - 0.2) / 0.35));
  const w = t * t * (3 - 2 * t);
  const head = [p[0] * 0.75, 0.82 + (p[1] - 0.82) * 0.75 - 0.2, p[2] * 0.8];
  return [p[0] + (head[0] - p[0]) * w, p[1] + (head[1] - p[1]) * w, p[2] + (head[2] - p[2]) * w];
}

// 목표 궤적을 사람 몸의 움직임으로 마무리한다
function finish(T, rng, blinkChance) {
  const N = T.face.length;
  const SIDES = ['R', 'L'];
  // 처음과 끝은 정확히 중립 자세가 되도록 흔들림을 서서히 넣고 뺀다
  const env = Array.from({ length: N }, (_, i) => sstep(0, 9, i) * sstep(0, 9, N - 1 - i));
  const wave = (period, amp) => {
    const ph = rng() * Math.PI * 2;
    return (i) => amp * Math.sin((2 * Math.PI * i) / period + ph);
  };

  // 1) 손 위치: 스프링 추종 + 미세한 떨림 + 몸 밖으로 밀어내기
  const hands = {};
  for (const side of SIDES) {
    const tr = T[side];
    let P = springFollow(tr.p);
    const drift = [wave(71, 1), wave(53, 1), wave(89, 1), wave(23, 0.35), wave(29, 0.35), wave(19, 0.35)];
    P = P.map((p, i) => {
      // 쉬고 있는 손은 조금 더 크게, 수어 중인 손은 아주 작게 흔들린다
      const rest = 1 - sstep(-1.3, -0.9, p[1]);
      const amp = (0.004 + 0.007 * rest) * env[i];
      return [p[0] + amp * (drift[0](i) + drift[3](i)), p[1] + amp * 0.7 * (drift[1](i) + drift[4](i)), p[2] + amp * (drift[2](i) + drift[5](i))];
    });
    // 쉬는 손가락도 가만히 있지 않는다 (아주 작은 굽힘 변화)
    const curlDrift = wave(61, 2.2 * DEG);
    const H = tr.h.map((h, i) => {
      const rest = (1 - sstep(-1.3, -0.9, P[i][1])) * env[i];
      if (rest < 1e-3) return h;
      const dv = curlDrift(i) * rest;
      return h.map((v, j) => (j >= 4 && j < 12 ? v + dv * (0.6 + 0.12 * (j - 4)) : v));
    });
    const N3 = tr.q.map((q) => qRot(q, [0, 0, 1]));
    const F3 = tr.q.map((q) => qRot(q, [0, 1, 0]));
    const local = P.map((p, i) => buildHand(side, p, N3[i], F3[i], H[i]));
    hands[side] = pushHands(local);
    hands[side].f = F3;
  }

  // 2) 몸: 손 높이·뻗음에 따라 어깨가 들리고 몸통이 살짝 돈다 + 숨쉬기·미세한 흔들림
  const wristY = (side, i) => hands[side][i][0][1];
  const act = Object.fromEntries(SIDES.map((s) => [s, hands[s].map((_, i) => sstep(-1.25, -0.45, wristY(s, i)))]));
  const elev = {}, prot = {};
  for (const side of SIDES) {
    elev[side] = smoothTrack(hands[side].map((h, i) => 0.06 * sstep(-0.2, 0.65, h[0][1]) + 0.012 * act[side][i]), 3.5);
    prot[side] = smoothTrack(hands[side].map((h, i) => 0.04 * sstep(0.4, 0.85, h[0][2]) * act[side][i]), 3.5);
  }
  const yaw = smoothTrack(act.R.map((a, i) => 0.075 * (a - act.L[i])), 5);
  const swayX = wave(97, 0.006), swayX2 = wave(41, 0.0025), swayZ = wave(77, 0.004), breath = wave(105, 0.004);
  const body = [];
  for (let i = 0; i < N; i++) {
    const sway = [(swayX(i) + swayX2(i)) * env[i], breath(i) * env[i], swayZ(i) * env[i]];
    const c = Math.cos(yaw[i]), s = Math.sin(yaw[i]);
    // y축 둘레로 돌림: yaw > 0이면 오른쪽 어깨가 앞으로 나온다
    const sh = (x, side) => add([x * c, elev[side][i], -x * s + prot[side][i]], sway);
    body.push({ sway, R: sh(-0.5, 'R'), L: sh(0.5, 'L') });
  }

  // 3) 팔: 손이 팔 길이를 넘지 않게 하고, 팔꿈치 각도를 골라 시간축으로 다듬는다
  const elbows = { R: [], L: [] };
  for (const side of SIDES) {
    const H = hands[side];
    for (let i = 0; i < N; i++) {
      const sh = body[i][side];
      const d = sub(H[i][0], sh);
      const dist = len(d);
      const maxR = (UPPER + FORE) * 0.985;
      const minR = 0.2;
      if (dist > maxR || dist < minR) {
        const shift = mul(norm(d), (dist > maxR ? maxR : minR) - dist);
        H[i] = H[i].map((q) => add(q, shift));
      }
    }
    const shoulders = body.map((b) => b[side]);
    let el = solveElbows(side, shoulders, H.map((pts) => pts[0]), H.f);
    // 손목 한계 → 돌린 손이 몸에 닿으면 다시 밀어냄 → 손목이 옮겨진 만큼 팔꿈치를 다시 맞춤
    for (let pass = 0; pass < 2; pass++) {
      // 회전량도 시간축으로 다듬어 손이 갑자기 꺾이지 않게 한다
      const turns = smoothTrack(H.map((pts, i) => wristTurn(pts, el[i], H.f[i])), 1.5);
      const lim = H.map((pts, i) => applyTurn(pts, H.f[i], turns[i]));
      const limited = pushHands(lim.map((l) => l.pts));
      for (let i = 0; i < N; i++) { H[i] = limited[i]; H.f[i] = lim[i].f; }
      el = el.map((e, i) => armCircle(shoulders[i], H[i][0]).snap(e));
    }
    elbows[side] = el;
  }

  // 4) 머리: 정해 준 끄덕임·도리질 + 손을 따라가는 시선 + 미세한 움직임
  const cx = (i) => {
    const wR = act.R[i], wL = act.L[i];
    return (wR * hands.R[i][9][0] + wL * hands.L[i][9][0]) / 0.55;
  };
  const lowY = (i) => {
    const y = Math.min(act.R[i] > 0.5 ? hands.R[i][9][1] : 1, act.L[i] > 0.5 ? hands.L[i][9][1] : 1);
    return Math.max(act.R[i], act.L[i]) * sstep(0.2, -0.7, y);
  };
  const gazeShake = smoothTrack(Array.from({ length: N }, (_, i) => 0.11 * clamp(cx(i), -1, 1)), 5);
  const gazeNod = smoothTrack(Array.from({ length: N }, (_, i) => 0.05 * lowY(i)), 5);
  const keyNod = smoothTrack(T.head.map((h) => h.nod), 1.3);
  const keyShake = smoothTrack(T.head.map((h) => h.shake), 1.3);
  const idleNod = wave(83, 0.008), idleShake = wave(67, 0.01), idleTilt = wave(113, 0.008);
  const faceTr = {
    brow: smoothTrack(T.face.map((f) => f.brow), 1.5),
    smile: smoothTrack(T.face.map((f) => f.smile), 1.5),
    mouthOpen: smoothTrack(T.face.map((f) => f.mouthOpen), 1),
  };

  // 5) 눈 깜빡임: 감는 데 2프레임, 뜨는 데 4프레임쯤
  const blink = new Array(N).fill(0);
  const BLINK = [0.55, 1, 0.8, 0.45, 0.18, 0.05];
  if (rng() < blinkChance) {
    let at = 8 + Math.floor(rng() * Math.max(1, Math.min(40, N - 24)));
    while (at < N - 10) {
      BLINK.forEach((v, k) => { if (at + k < N - 2) blink[at + k] = v; });
      at += 55 + Math.floor(rng() * 60);
    }
  }

  // 6) 프레임 조립
  const fmt = (arr) => arr.map((p) => p.map(r4));
  const frames = [];
  for (let i = 0; i < N; i++) {
    const head = {
      nod: keyNod[i] + gazeNod[i] + idleNod(i) * env[i],
      shake: keyShake[i] + gazeShake[i] + idleShake(i) * env[i],
      tilt: idleTilt(i) * env[i] - 0.25 * yaw[i],
    };
    const b = body[i];
    // 머리는 몸통 흔들림을 따라가고, 어깨가 들릴 때 아주 조금 같이 올라간다
    const headOff = [b.sway[0] * 1.15, b.sway[1] * 0.5, b.sway[2] * 1.15];
    const placeHead = (p) => add(toBody(headTransform(p, head)), headOff);
    const pose = BASE_POSE.map((p) => [...p]);
    for (let k = 0; k <= 10; k++) pose[k] = placeHead(pose[k]);
    pose[11] = b.L;
    pose[12] = b.R;
    for (const side of SIDES) {
      const pts = hands[side][i];
      const [iEl, iWr, iPinky, iIndex, iThumb] = side === 'R' ? [14, 16, 18, 20, 22] : [13, 15, 17, 19, 21];
      pose[iEl] = elbows[side][i];
      pose[iWr] = pts[0];
      pose[iPinky] = pts[17];
      pose[iIndex] = pts[5];
      pose[iThumb] = pts[2];
    }
    const face = baseFace({ brow: faceTr.brow[i], smile: faceTr.smile[i], mouthOpen: Math.max(0, faceTr.mouthOpen[i]), blink: blink[i] }).map(placeHead);
    frames.push({ t: i, pose: fmt(pose), left: fmt(hands.L[i]), right: fmt(hands.R[i]), face: fmt(face) });
  }
  return frames;
}

// ---------- 동작 도우미 ----------
const R = (p, n, f, s) => ({ p: toBody(p), n, f, s });
const Lh = R;
// a ↔ b 를 times번 왕복
function repeat(times, a, b, d = 6) {
  const out = [];
  for (let i = 0; i < times; i++) { out.push({ ...a, d }); out.push({ ...b, d }); }
  return out;
}
// 원 그리기 (xy 또는 xz 평면). 시작점까지 간 뒤 멈추지 않고 한 번에 돈다.
function circle(center, radius, plane, turns, build, steps = 8, d = 3) {
  const out = [];
  const n = steps * turns;
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * 2 * i) / steps;
    const off = plane === 'xy' ? [Math.cos(a) * radius, Math.sin(a) * radius, 0] : [Math.cos(a) * radius, 0, Math.sin(a) * radius];
    out.push({ ...build(add(center, off), a), d: i === 0 ? 8 : d, via: i > 0 && i < n });
  }
  return out;
}

const PALM_IN_R = [1, 0, 0];   // 오른손 손바닥이 몸 가운데를 향함
const PALM_IN_L = [-1, 0, 0];

const SIGNS = {
  '안녕하세요': [
    { r: R([-0.55, 0.85, 0.3], 'fwd', 'up', 'open'), d: 10, face: { smile: 0.012 } },
    ...repeat(2, { r: R([-0.42, 0.88, 0.3], 'fwd', [0.25, 1, 0], 'open') }, { r: R([-0.68, 0.85, 0.3], 'fwd', [-0.25, 1, 0], 'open') }, 6),
    { r: R([-0.55, 0.85, 0.3], 'fwd', 'up', 'open'), d: 5, hold: 3 },
  ],
  '감사합니다': [
    { l: Lh([0.08, -0.45, 0.4], 'down', 'vr', 'open'), r: R([-0.05, -0.15, 0.4], PALM_IN_R, 'fwd', 'open'), d: 10 },
    ...repeat(2, { r: R([-0.05, -0.36, 0.4], PALM_IN_R, 'fwd', 'open'), head: { nod: 0.15 } }, { r: R([-0.05, -0.2, 0.4], PALM_IN_R, 'fwd', 'open') }, 5),
  ],
  '미안합니다': [
    ...circle([-0.12, -0.3, 0.32], 0.1, 'xy', 2, (p) => ({ r: R(p, 'back', 'up', 'fist'), face: { brow: 0.025 } })),
  ],
  '네': [
    { r: R([-0.3, -0.1, 0.4], PALM_IN_R, 'up', 'fist'), d: 9 },
    ...repeat(2, { r: R([-0.3, -0.22, 0.42], PALM_IN_R, [0, 0.6, 1], 'fist'), head: { nod: 0.2 } }, { r: R([-0.3, -0.08, 0.4], PALM_IN_R, 'up', 'fist') }, 5),
  ],
  '아니요': [
    { r: R([-0.2, 0.55, 0.45], 'fwd', 'up', 'open'), d: 10 },
    ...repeat(3, { r: R([-0.08, 0.55, 0.45], 'fwd', [0.2, 1, 0], 'open'), head: { shake: 0.2 } }, { r: R([-0.32, 0.55, 0.45], 'fwd', [-0.2, 1, 0], 'open'), head: { shake: -0.2 } }, 4),
  ],
  '괜찮다': [
    { r: R([-0.1, 0.35, 0.42], 'back', 'up', 'pinky'), d: 10 },
    ...repeat(2, { r: R([-0.05, 0.42, 0.3], 'back', 'up', 'pinky') }, { r: R([-0.1, 0.35, 0.42], 'back', 'up', 'pinky') }, 5),
  ],
  '만나다': [
    { r: R([-0.6, -0.15, 0.4], PALM_IN_R, 'up', 'point'), l: Lh([0.6, -0.15, 0.4], PALM_IN_L, 'up', 'point'), d: 10, hold: 3 },
    { r: R([-0.07, -0.15, 0.42], PALM_IN_R, 'up', 'point'), l: Lh([0.07, -0.15, 0.42], PALM_IN_L, 'up', 'point'), d: 14, hold: 6 },
  ],
  '반갑다': [
    { r: R([-0.2, -0.3, 0.32], 'back', 'up', 'open'), l: Lh([0.2, -0.1, 0.32], 'back', 'up', 'open'), d: 10, face: { smile: 0.015 } },
    ...repeat(2, { r: R([-0.2, -0.1, 0.32], 'back', 'up', 'open'), l: Lh([0.2, -0.3, 0.32], 'back', 'up', 'open') }, { r: R([-0.2, -0.3, 0.32], 'back', 'up', 'open'), l: Lh([0.2, -0.1, 0.32], 'back', 'up', 'open') }, 6),
  ],
  '나': [
    { r: R([-0.1, -0.3, 0.42], PALM_IN_R, 'back', 'point'), d: 12, hold: 10 },
  ],
  '너': [
    { r: R([-0.2, -0.15, 0.5], PALM_IN_R, 'fwd', 'point'), d: 8 },
    { r: R([-0.2, -0.1, 0.72], PALM_IN_R, 'fwd', 'point'), d: 8, hold: 10 },
  ],
  '엄마': [
    { r: R([-0.25, 0.65, 0.32], PALM_IN_R, 'up', 'point'), d: 10 },
    ...repeat(2, { r: R([-0.25, 0.52, 0.32], PALM_IN_R, 'up', 'point') }, { r: R([-0.25, 0.65, 0.32], PALM_IN_R, 'up', 'point') }, 6),
  ],
  '아빠': [
    { r: R([-0.32, 0.55, 0.3], PALM_IN_R, 'fwd', 'thumb'), d: 10 },
    { r: R([-0.32, 0.82, 0.3], PALM_IN_R, 'fwd', 'thumb'), d: 10, hold: 6 },
  ],
  '가족': [
    ...circle([0, -0.3, 0.45], 0.18, 'xz', 1, (p) => ({
      r: R([p[0] - 0.12, p[1], p[2]], 'down', 'fwd', 'open'),
      l: Lh([-p[0] + 0.12, p[1], p[2]], 'down', 'fwd', 'open'),
    }), 8, 4),
  ],
  '친구': [
    { r: R([-0.07, -0.2, 0.4], PALM_IN_R, 'up', 'fist'), l: Lh([0.07, -0.2, 0.4], PALM_IN_L, 'up', 'fist'), d: 10 },
    ...repeat(2, { r: R([-0.03, -0.2, 0.4], PALM_IN_R, 'up', 'fist'), l: Lh([0.11, -0.2, 0.4], PALM_IN_L, 'up', 'fist') }, { r: R([-0.11, -0.2, 0.4], PALM_IN_R, 'up', 'fist'), l: Lh([0.03, -0.2, 0.4], PALM_IN_L, 'up', 'fist') }, 5),
  ],
  '이름': [
    { r: R([0.0, -0.25, 0.5], 'back', 'up', 'pinch'), d: 10 },
    { r: R([0.22, -0.25, 0.3], 'back', 'up', 'pinch'), d: 10, hold: 10 },
  ],
  '하나': [
    { r: R([-0.3, -0.1, 0.35], 'back', 'up', 'point'), d: 10 },
    { r: R([-0.3, -0.05, 0.55], 'back', 'up', 'point'), d: 8, hold: 10 },
  ],
  '둘': [
    { r: R([-0.3, -0.1, 0.35], 'back', 'up', 'two'), d: 10 },
    { r: R([-0.3, -0.05, 0.55], 'back', 'up', 'two'), d: 8, hold: 10 },
  ],
  '셋': [
    { r: R([-0.3, -0.1, 0.35], 'back', 'up', 'three'), d: 10 },
    { r: R([-0.3, -0.05, 0.55], 'back', 'up', 'three'), d: 8, hold: 10 },
  ],
  '좋다': [
    { r: R([-0.06, 0.62, 0.45], PALM_IN_R, 'up', 'fist'), d: 10, face: { smile: 0.015 } },
    ...repeat(2, { r: R([-0.03, 0.7, 0.34], PALM_IN_R, 'up', 'fist') }, { r: R([-0.06, 0.62, 0.45], PALM_IN_R, 'up', 'fist') }, 5),
  ],
  '싫다': [
    { r: R([-0.06, 0.42, 0.33], 'down', 'vl', 'open'), d: 10, face: { brow: -0.02, smile: -0.01 } },
    { r: R([-0.45, 0.3, 0.5], 'down', [-1, 0, 0.5], 'open'), d: 7, hold: 8 },
  ],
  '기쁘다': [
    { r: R([-0.18, -0.45, 0.32], 'back', 'up', 'open'), l: Lh([0.18, -0.3, 0.32], 'back', 'up', 'open'), d: 10, face: { smile: 0.018, mouthOpen: 0.01 } },
    ...repeat(2, { r: R([-0.18, -0.15, 0.32], 'back', 'up', 'open'), l: Lh([0.18, -0.45, 0.32], 'back', 'up', 'open') }, { r: R([-0.18, -0.45, 0.32], 'back', 'up', 'open'), l: Lh([0.18, -0.15, 0.32], 'back', 'up', 'open') }, 6),
  ],
  '슬프다': [
    { r: R([-0.15, 0.8, 0.32], 'back', 'up', 'point'), d: 12, face: { brow: 0.02, smile: -0.012 } },
    { r: R([-0.18, 0.55, 0.32], 'back', 'up', 'point'), d: 16, hold: 6 },
  ],
  '학교': [
    { r: R([-0.12, -0.1, 0.42], PALM_IN_R, 'up', 'open'), l: Lh([0.12, -0.1, 0.42], PALM_IN_L, 'up', 'open'), d: 10 },
    ...repeat(2, { r: R([-0.04, -0.1, 0.42], PALM_IN_R, 'up', 'open'), l: Lh([0.04, -0.1, 0.42], PALM_IN_L, 'up', 'open') }, { r: R([-0.12, -0.1, 0.42], PALM_IN_R, 'up', 'open'), l: Lh([0.12, -0.1, 0.42], PALM_IN_L, 'up', 'open') }, 5),
    { r: R([-0.1, 0.15, 0.42], [0.7, -0.7, 0], [0.7, 0.7, 0], 'open'), l: Lh([0.1, 0.15, 0.42], [-0.7, -0.7, 0], [-0.7, 0.7, 0], 'open'), d: 8 },
    { r: R([-0.35, -0.08, 0.42], [0.7, -0.7, 0], [0.7, 0.7, 0], 'open'), l: Lh([0.35, -0.08, 0.42], [-0.7, -0.7, 0], [-0.7, 0.7, 0], 'open'), d: 10, hold: 4 },
  ],
  '선생님': [
    { r: R([-0.35, 0.92, 0.2], PALM_IN_R, 'fwd', 'point'), d: 12 },
    ...repeat(2, { r: R([-0.35, 0.88, 0.45], PALM_IN_R, 'fwd', 'point') }, { r: R([-0.35, 0.92, 0.2], PALM_IN_R, 'fwd', 'point') }, 6),
  ],
  '공부하다': [
    { l: Lh([0.1, -0.45, 0.4], 'up', 'fwd', 'open'), r: R([-0.08, -0.28, 0.4], 'down', 'fwd', 'open'), d: 10 },
    ...repeat(2, { r: R([-0.08, -0.28, 0.55], 'down', 'fwd', 'open') }, { r: R([-0.08, -0.28, 0.3], 'down', 'fwd', 'open') }, 6),
  ],
  '가다': [
    { r: R([-0.22, -0.3, 0.3], 'down', 'fwd', 'point'), d: 10, hold: 2 },
    { r: R([-0.22, -0.18, 0.8], 'down', 'fwd', 'point'), d: 12, hold: 6 },
  ],
  '오다': [
    { r: R([-0.22, -0.18, 0.8], 'up', 'fwd', 'point'), d: 12, hold: 2 },
    { r: R([-0.22, -0.3, 0.34], 'back', [0, 1, -0.25], 'point'), d: 12, hold: 6 },
  ],
  '먹다': [
    { r: R([-0.12, 0.38, 0.55], 'back', [0.3, 0.6, -0.6], 'bunch'), d: 10 },
    ...repeat(2, { r: R([-0.04, 0.6, 0.42], 'back', [0.3, 0.4, -0.8], 'bunch'), face: { mouthOpen: 0.015 } }, { r: R([-0.12, 0.38, 0.55], 'back', [0.3, 0.6, -0.6], 'bunch'), face: { mouthOpen: 0 } }, 6),
  ],
  '마시다': [
    { r: R([-0.1, 0.4, 0.45], PALM_IN_R, 'up', 'cup'), d: 10 },
    { r: R([-0.05, 0.6, 0.38], [0.7, 0.3, 0], [0.3, 0.6, -0.8], 'cup'), d: 10, hold: 10 },
  ],
  '물': [
    { r: R([-0.08, 0.36, 0.45], 'back', 'up', 'three'), d: 10 },
    ...repeat(2, { r: R([-0.05, 0.42, 0.33], 'back', 'up', 'three') }, { r: R([-0.08, 0.36, 0.45], 'back', 'up', 'three') }, 5),
  ],
  '밥': [
    { l: Lh([0.1, -0.4, 0.42], 'up', 'fwd', 'open'), r: R([0.05, -0.32, 0.42], 'up', 'vl', 'two'), d: 10 },
    { r: R([-0.04, 0.58, 0.42], 'back', [0.3, 0.4, -0.8], 'two'), d: 12, hold: 4 },
    { r: R([0.05, -0.32, 0.42], 'up', 'vl', 'two'), d: 10 },
    { r: R([-0.04, 0.58, 0.42], 'back', [0.3, 0.4, -0.8], 'two'), d: 12, hold: 4 },
  ],
  '오늘': [
    { r: R([-0.25, -0.45, 0.42], 'down', 'fwd', 'open'), l: Lh([0.25, -0.45, 0.42], 'down', 'fwd', 'open'), d: 10 },
    ...repeat(2, { r: R([-0.25, -0.58, 0.42], 'down', 'fwd', 'open'), l: Lh([0.25, -0.58, 0.42], 'down', 'fwd', 'open') }, { r: R([-0.25, -0.45, 0.42], 'down', 'fwd', 'open'), l: Lh([0.25, -0.45, 0.42], 'down', 'fwd', 'open') }, 5),
  ],
  '내일': [
    { r: R([-0.42, 0.78, 0.18], PALM_IN_R, 'up', 'point'), d: 12 },
    { r: R([-0.42, 0.75, 0.55], PALM_IN_R, [0, 0.5, 1], 'point'), d: 12, hold: 8 },
  ],
  '어제': [
    { r: R([-0.42, 0.78, 0.25], PALM_IN_R, 'up', 'point'), d: 12 },
    { r: R([-0.5, 0.9, -0.15], PALM_IN_R, [0, 0.5, -1], 'point'), d: 12, hold: 8 },
  ],
  '무엇': [
    { r: R([-0.3, 0.15, 0.42], 'fwd', 'up', 'point'), d: 10, face: { brow: 0.035 }, head: { nod: -0.1 } },
    ...repeat(3, { r: R([-0.24, 0.15, 0.42], 'fwd', [0.2, 1, 0], 'point'), head: { nod: -0.1 } }, { r: R([-0.36, 0.15, 0.42], 'fwd', [-0.2, 1, 0], 'point'), head: { nod: -0.1 } }, 4),
  ],
  '어디': [
    ...circle([-0.3, -0.2, 0.45], 0.08, 'xz', 2, (p) => ({ r: R(p, 'up', 'fwd', 'open'), face: { brow: 0.035 }, head: { nod: -0.1 } })),
  ],
  '끝': [
    { r: R([-0.22, -0.05, 0.4], PALM_IN_R, 'fwd', 'open'), l: Lh([0.22, -0.05, 0.4], PALM_IN_L, 'fwd', 'open'), d: 10, hold: 3 },
    { r: R([-0.28, -0.45, 0.48], 'down', 'fwd', 'open'), l: Lh([0.28, -0.45, 0.48], 'down', 'fwd', 'open'), d: 7, hold: 8, head: { nod: 0.15 } },
  ],
};

// ---------- 지문자 (가짜) ----------
const JAMO = [
  'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
  'ㄲ', 'ㄸ', 'ㅃ', 'ㅆ', 'ㅉ',
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
const FS_SHAPES = ['l', 'open', 'point', 'two', 'three', 'fist', 'thumb', 'pinky', 'ok', 'claw', 'y', 'pinch', 'cup', 'bunch'];
const FS_ORIENT = [
  { n: 'fwd', f: 'up' },
  { n: 'back', f: 'up' },
  { n: PALM_IN_R, f: 'fwd' },
  { n: 'down', f: 'vl' },
  { n: 'fwd', f: 'vl' },
];
function fingerspellKeys(i) {
  const shape = FS_SHAPES[i % FS_SHAPES.length];
  const o = FS_ORIENT[Math.floor(i / FS_SHAPES.length) % FS_ORIENT.length];
  const pos = [-0.35, 0.15, 0.45];
  return [
    { r: R(pos, o.n, o.f, shape), d: 9, hold: 6 },
    { r: R([pos[0], pos[1] - 0.02, pos[2] + 0.06], o.n, o.f, shape), d: 4, hold: 4 },
  ];
}

// ---------- 저장 ----------
function signJson(word, frames, fps = FPS) {
  const lines = frames.map((f) => '    ' + JSON.stringify(f));
  return `{\n  "version": 1,\n  "word": ${JSON.stringify(word)},\n  "fps": ${fps},\n  "frameCount": ${frames.length},\n  "coordinate": "normalized",\n  "source": "generated-placeholder",\n  "frames": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

const words = JSON.parse(readFileSync(join(ROOT, 'data', 'words.json'), 'utf8'));
mkdirSync(join(ROOT, 'data', 'signs'), { recursive: true });
mkdirSync(join(ROOT, 'data', 'fingerspelling'), { recursive: true });

let total = 0;
let made = 0;
for (const w of words) {
  const keys = SIGNS[w.word];
  if (!keys) continue; // 아직 동작이 없는 단어 (지문자로 표시됨)
  made++;
  const frames = animate(keys, w.word);
  const out = join(ROOT, 'data', w.sign);
  const text = signJson(w.word, frames);
  writeFileSync(out, text);
  total += text.length;
}
JAMO.forEach((j, i) => {
  // 지문자는 짧고 많이 이어 붙이므로 15fps로 저장한다 (뷰어가 프레임 사이를 보간함)
  // 이어 붙였을 때 글자마다 눈을 깜빡이면 어색하므로 가끔만 깜빡인다
  const frames = animate(fingerspellKeys(i), j, { blinkChance: 0.2 }).filter((_, k) => k % 2 === 0).map((f, k) => ({ ...f, t: k }));
  const text = signJson(j, frames, FPS / 2);
  writeFileSync(join(ROOT, 'data', 'fingerspelling', `${j}.json`), text);
  total += text.length;
});
console.log(`단어 ${made}개(동작 없는 단어 ${words.length - made}개 건너뜀), 지문자 ${JAMO.length}개 생성 (총 ${(total / 1024 / 1024).toFixed(2)} MB)`);
