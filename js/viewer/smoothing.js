// 손떨림 제거(One Euro Filter)와 프레임 보간 도구

const PARTS = ['pose', 'left', 'right', 'face'];

class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// 값 하나를 거르는 One Euro Filter
export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.prev = null;
  }
  reset() {
    this.x = new LowPass();
    this.dx = new LowPass();
    this.prev = null;
  }
  filter(value, dt) {
    const prev = this.prev;
    this.prev = value;
    const d = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(d, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

// 프레임 배열 전체에 One Euro Filter를 적용한다 (원본은 바꾸지 않음).
// strength: 0(거의 그대로) ~ 1(강하게) — minCutoff를 조절한다.
export function smoothFrames(frames, { fps = 30, strength = 0.5, beta = 0.01 } = {}) {
  const dt = 1 / fps;
  const minCutoff = 3.0 - 2.7 * Math.max(0, Math.min(1, strength)); // 3.0Hz ~ 0.3Hz
  const filters = {};
  const out = [];
  for (const f of frames) {
    const nf = { t: f.t };
    for (const part of PARTS) {
      const pts = f[part];
      if (!pts) {
        nf[part] = pts ?? null;
        // 손이 사라지면 필터를 초기화해서 다시 나타날 때 끌려오지 않게 한다
        if (filters[part]) filters[part] = null;
        continue;
      }
      if (!filters[part]) {
        filters[part] = pts.map(() => [0, 1, 2].map(() => new OneEuroFilter({ minCutoff, beta })));
      }
      nf[part] = pts.map((p, i) => p.map((v, k) => round4(filters[part][i][k].filter(v, dt))));
    }
    out.push(nf);
  }
  return out;
}

// 손이 잠깐 사라진 구간(maxGap 프레임 이하)을 앞뒤 프레임으로 선형 보간해 채운다.
export function fillGaps(frames, { maxGap = 8, parts = ['left', 'right', 'face'] } = {}) {
  const out = frames.map((f) => ({ ...f }));
  for (const part of parts) {
    let i = 0;
    while (i < out.length) {
      if (out[i][part]) { i++; continue; }
      let j = i;
      while (j < out.length && !out[j][part]) j++;
      const before = i - 1;
      const after = j;
      const gap = j - i;
      if (before >= 0 && after < out.length && gap <= maxGap) {
        const a = out[before][part];
        const b = out[after][part];
        for (let k = i; k < j; k++) {
          const t = (k - before) / (after - before);
          out[k][part] = lerpPoints(a, b, t);
        }
      }
      i = j;
    }
  }
  return out;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpPoints(a, b, t) {
  if (!a && !b) return null;
  if (!a) return t >= 0.5 ? b : null;
  if (!b) return t < 0.5 ? a : null;
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = [lerp(a[i][0], b[i][0], t), lerp(a[i][1], b[i][1], t), lerp(a[i][2], b[i][2], t)];
  }
  return out;
}

// 두 프레임 사이를 t(0~1)로 보간한 새 프레임
export function lerpFrame(a, b, t) {
  const out = { t: lerp(a.t ?? 0, b.t ?? 0, t) };
  for (const part of PARTS) out[part] = lerpPoints(a[part], b[part], t);
  return out;
}

// 부드러운 가속/감속 (동작 사이 연결용)
export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function round4(v) {
  return Math.round(v * 10000) / 10000;
}
