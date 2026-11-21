// 여러 동작을 이어 붙여 하나의 클립으로 만든다 (문장용)
// 동작 사이는 앞 동작의 마지막 프레임 → 다음 동작의 첫 프레임을 부드럽게 보간한다.
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
      for (let t = 1; t <= transition; t++) {
        frames.push(lerpFrame(prev, next, easeInOut(t / (transition + 1))));
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
