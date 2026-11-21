// 여러 동작을 이어 붙여 하나의 클립으로 만든다 (문장용)
// 동작 사이는 앞 동작의 마지막 프레임 → 다음 동작의 첫 프레임을 부드럽게 보간한다.
import * as THREE from 'three';
import { lerpFrame, easeInOut } from './smoothing.js';

export const SEQ_FPS = 30;

// 다른 fps로 저장된 클립을 SEQ_FPS로 다시 샘플링
export function resample(clip, fps = SEQ_FPS) {
  const src = clip.frames;
  if (!src.length) return [];
  if ((clip.fps || fps) === fps) return src.slice();
  const ratio = (clip.fps || fps) / fps;
  const n = Math.max(1, Math.round((src.length - 1) / ratio) + 1);
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = k * ratio;
    const i = Math.floor(t);
    const a = src[Math.min(i, src.length - 1)];
    const b = src[Math.min(i + 1, src.length - 1)];
    out.push(lerpFrame(a, b, t - i));
  }
  return out;
}

// 두 손이 모두 가슴 아래로 내려간 프레임 = 중립 자세
function isNeutral(f) {
  const low = (side, wristIdx) => {
    const w = f[side] ? f[side][0] : f.pose?.[wristIdx];
    return !w || w[1] < -0.72;
  };
  return low('left', 15) && low('right', 16);
}

const wristOf = (f, side) => (f[side] ? f[side][0] : f.pose?.[side === 'left' ? 15 : 16]) || null;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 손을 들어 올리는(또는 내리는) 이동이 끝나고 실제 동작이 시작되는 프레임.
// order: 앞에서부터면 frames, 뒤에서부터면 뒤집은 배열을 넘긴다.
// 쉬는 자리에서 충분히 멀어진 뒤 손 속도가 크게 줄어드는 곳(첫 도착 지점)을 찾는다.
function arrivalIndex(order) {
  const n = order.length;
  if (n < 8) return 0;
  const base = { left: wristOf(order[0], 'left'), right: wristOf(order[0], 'right') };
  const disp = [];
  const speed = [0];
  for (let i = 0; i < n; i++) {
    let d = 0, v = 0;
    for (const side of ['left', 'right']) {
      const w = wristOf(order[i], side);
      if (!w || !base[side]) continue;
      d = Math.max(d, dist3(w, base[side]));
      const p = i > 0 ? wristOf(order[i - 1], side) : null;
      if (p) v = Math.max(v, dist3(w, p));
    }
    disp.push(d);
    if (i > 0) speed.push(v);
  }
  const D = Math.max(...disp);
  if (D < 0.15) return 0; // 쉬는 자세에서 거의 안 움직이는 동작
  let i = disp.findIndex((d) => d >= 0.5 * D);
  let peak = 0;
  for (let k = 1; k <= i; k++) peak = Math.max(peak, speed[k]);
  for (; i < n - 1; i++) {
    peak = Math.max(peak, speed[i]);
    if (speed[i] < 0.25 * peak || (speed[i] <= speed[i + 1] && speed[i] < 0.5 * peak)) break;
  }
  return i;
}

// 앞뒤 중립 구간(쉬는 자세 + 손을 올리고 내리는 이동)을 잘라낸다.
// keepStart/keepEnd: 문장 처음과 끝은 남김
export function trimNeutral(frames, { keepStart = false, keepEnd = false } = {}) {
  let s = 0;
  let e = frames.length - 1;
  if (!keepStart) {
    while (s < e && isNeutral(frames[s])) s++;
    s = Math.max(s, arrivalIndex(frames));
  }
  if (!keepEnd) {
    while (e > s && isNeutral(frames[e])) e--;
    e = Math.min(e, frames.length - 1 - arrivalIndex(frames.slice().reverse()));
  }
  // 너무 많이 잘렸으면 원본 유지
  if (e - s < 6) return frames.slice();
  return frames.slice(Math.max(0, s - 1), Math.min(frames.length, e + 2));
}

// ---------- 동작 사이 보간 ----------
// 손의 점들을 그대로 직선 보간하면, 손 방향이 크게 다른 두 손모양 사이(예: 손끝이 아래인 지문자 → 위인 지문자)에서
// 손이 납작하게 찌그러졌다가 뒤집힌다 (손 길이가 0에 가까워지는 순간 손 방향이 홱 돌아 손이 튄다).
// 손은 "손목 위치 + 손 전체의 회전 + 손 안에서의 모양"으로 나눠, 회전은 구면 보간(slerp)하고 모양은 손 기준틀 안에서 보간한다.
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qi = new THREE.Quaternion();

// 손 기준틀: 손목→중지 뿌리(x), 새끼→검지 쪽(y). 손이 찌그러져 있으면 null
function handQuat(h, out) {
  _x.set(h[9][0] - h[0][0], h[9][1] - h[0][1], h[9][2] - h[0][2]);
  _y.set(h[5][0] - h[17][0], h[5][1] - h[17][1], h[5][2] - h[17][2]);
  if (_x.lengthSq() < 1e-8) return null;
  _x.normalize();
  _z.crossVectors(_x, _y);
  if (_z.lengthSq() < 1e-10) return null;
  _z.normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

const FINGER_CHAINS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const _ident = new THREE.Quaternion();
const _qs = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _da = new THREE.Vector3(), _db = new THREE.Vector3();

function blendHand(a, b, t) {
  if (!a || !b || a.length < 21 || b.length < 21) return null;
  if (!handQuat(a, _qa) || !handQuat(b, _qb)) return null;
  const ia = _qi.copy(_qa).invert().clone(), ib = _qi.copy(_qb).invert().clone();
  const q = _qa.clone().slerp(_qb, t);
  const w = [0, 1, 2].map((k) => a[0][k] + (b[0][k] - a[0][k]) * t);
  // 손 기준틀 안의 점들
  const la = a.map((p) => new THREE.Vector3(p[0] - a[0][0], p[1] - a[0][1], p[2] - a[0][2]).applyQuaternion(ia));
  const lb = b.map((p) => new THREE.Vector3(p[0] - b[0][0], p[1] - b[0][1], p[2] - b[0][2]).applyQuaternion(ib));
  const lo = la.map((p, i) => p.clone().lerp(lb[i], t)); // 손바닥 뼈대(손가락 뿌리)는 직선 보간
  // 손가락 마디는 "방향"을 구면 보간하고 길이를 따로 보간한다.
  // 점을 직선으로 이으면 편 손가락 ↔ 쥔 손가락 사이에서 마디가 짧아지고 관절이 실제보다 더 꺾였다가 풀린다.
  for (const ch of FINGER_CHAINS) {
    for (let k = 1; k < ch.length; k++) {
      _da.subVectors(la[ch[k]], la[ch[k - 1]]);
      _db.subVectors(lb[ch[k]], lb[ch[k - 1]]);
      const na = _da.length(), nb = _db.length();
      if (na < 1e-6 || nb < 1e-6) { lo[ch[k]].copy(lo[ch[k - 1]]).add(_da.lerp(_db, t)); continue; }
      _da.multiplyScalar(1 / na); _db.multiplyScalar(1 / nb);
      _qs.setFromUnitVectors(_da, _db);
      _da.applyQuaternion(_qt.copy(_ident).slerp(_qs, t)).multiplyScalar(na + (nb - na) * t);
      lo[ch[k]].copy(lo[ch[k - 1]]).add(_da);
    }
  }
  return lo.map((p) => { p.applyQuaternion(q); return [w[0] + p.x, w[1] + p.y, w[2] + p.z]; });
}

// 두 프레임 사이 (손은 회전을 살려서, 나머지는 직선 보간)
export function blendFrame(a, b, t) {
  const out = lerpFrame(a, b, t);
  for (const side of ['left', 'right']) {
    const h = blendHand(a[side], b[side], t);
    if (h) out[side] = h;
  }
  return out;
}

// clips: [{ fps, frames }] (null이면 건너뜀)
// options: transition(보간 프레임 수), pause(단어 사이 멈춤 프레임 수)
// 반환: { fps, frames, segments: [{ index, start, end }] }  — index는 clips 배열의 위치
export function buildSequence(clips, { transition = 8, pause = 6 } = {}) {
  const frames = [];
  const segments = [];
  const valid = clips.map((c, i) => ({ c, i })).filter(({ c }) => c && c.frames && c.frames.length);
  valid.forEach(({ c, i }, k) => {
    let fr = resample(c);
    fr = trimNeutral(fr, { keepStart: k === 0, keepEnd: k === valid.length - 1 });
    if (frames.length) {
      const prev = frames[frames.length - 1];
      // 멈춤
      for (let p = 0; p < pause; p++) frames.push(prev);
      // 보간
      const next = fr[0];
      // 손을 크게 돌려야 하는 전환(예: 손끝이 아래인 지문자 → 위인 지문자)은 그만큼 시간을 더 준다.
      // 사람 손목은 0.13초 만에 180° 돌지 못한다: 그대로 두면 아바타의 손이 따라가지 못해 손목이 출렁인다.
      let turn = 0;
      for (const side of ['left', 'right']) {
        const ha = prev[side], hb = next[side];
        if (ha && hb && ha.length >= 21 && hb.length >= 21 && handQuat(ha, _qa) && handQuat(hb, _qb)) turn = Math.max(turn, _qa.angleTo(_qb));
      }
      const steps = transition + Math.round(Math.max(0, turn - 1.0) / 0.42);
      for (let t = 1; t <= steps; t++) {
        frames.push(blendFrame(prev, next, easeInOut(t / (steps + 1))));
      }
    }
    const start = frames.length;
    for (const f of fr) frames.push(f);
    segments.push({ index: i, start, end: frames.length - 1 });
  });
  frames.forEach((f, t) => { frames[t] = { ...f, t }; });
  return { fps: SEQ_FPS, frames, segments };
}

// 현재 프레임이 속한 구간 (전환 구간이면 다음 단어로 본다)
export function segmentAt(seq, time) {
  if (!seq?.segments?.length) return -1;
  for (let k = 0; k < seq.segments.length; k++) {
    if (time <= seq.segments[k].end + 0.5) return k;
  }
  return seq.segments.length - 1;
}
