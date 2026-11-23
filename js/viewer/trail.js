// 손 궤적: 수어 동작에서 손이 지나간 길을 굵은 선으로 보여 준다.
//  - 손바닥 가운데(손목·검지 뿌리·새끼 뿌리의 평균)를 따라간다 (손목은 소매에 가려 잘 안 보임)
//  - 몸·손에 가리지 않게 맨 위에 그리고, 흰 테두리로 어떤 배경에서도 보이게 한다
//  - 전체 길은 옅게, 재생 중인 손 뒤에는 진한 꼬리가 따라가서 움직이는 방향을 알 수 있다
//  - 손을 올리고 내리는 준비·마무리 구간은 빼고, 수어 동작 부분만 그린다
//  - 움직이지 않고 제자리에 있는 손은 그리지 않는다
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const COLOR = { left: 0x2563eb, right: 0xea580c }; // 수어하는 사람의 왼손: 파랑, 오른손: 주황
const PATH_W = 4, PATH_OUT = 7;   // 전체 길: 선 굵기, 흰 테두리 굵기 (픽셀)
const TAIL_W = 8, TAIL_OUT = 12;  // 꼬리
const TAIL = 12;                  // 꼬리 길이 (프레임)
const TOP = 900;                  // 그리는 순서: 아바타보다 나중(위)에
const MIN_MOVE = 0.06;            // 수어 동작 동안 이보다 적게 움직인 손은 제자리 손으로 보고 그리지 않는다
const STILL = 0.01;               // 한 프레임에 이보다 적게 움직이면 멈춰 있는 것
const RAISE = 0.05;               // 한 프레임에 이보다 많이 움직이면 손을 올리거나 내리는 중

// 손바닥 가운데. 손 좌표가 없으면 몸 좌표의 손목.
function palm(f, side) {
  const h = f[side];
  if (h && h[0] && h[5] && h[17]) {
    return [(h[0][0] + h[5][0] + h[17][0]) / 3, (h[0][1] + h[5][1] + h[17][1]) / 3, (h[0][2] + h[5][2] + h[17][2]) / 3];
  }
  const w = f.pose?.[side === 'left' ? 15 : 16];
  return w ? [w[0], w[1], w[2]] : null;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 손을 올리는 구간과 내리는 구간을 잘라 낸 [시작, 끝] (프레임 번호). 그 사이에 거의 움직이지 않으면 null.
// 손을 올릴 때는 빨라졌다가 수어 시작 자리에서 느려진다 → 처음으로 속도가 바닥이 되는 곳부터,
// 끝에서 거꾸로도 똑같이 찾은 곳까지가 수어 동작이다.
function coreRange(pts) {
  const n = pts.length - 1;
  const sp = (i) => (pts[i] && pts[i + 1] ? dist(pts[i], pts[i + 1]) : 0);
  // 손을 올리고 내리는 움직임은 빠르다 (수어 동작 중의 움직임보다). 쉬는 손의 작은 흔들림은 건너뛴다.
  const fast = (i) => sp(i) > RAISE;
  let a = 0;
  while (a < n && !fast(a)) a++;               // 아직 쉬는 중
  if (a >= n) { a = 0; while (a < n && sp(a) < STILL) a++; }
  while (a < n && sp(a + 1) >= sp(a)) a++;     // 빨라지는 중
  while (a < n && sp(a + 1) < sp(a)) a++;      // 느려지는 중 → 바닥
  let b = n - 1;
  while (b > 0 && !fast(b)) b--;
  if (b <= 0) { b = n - 1; while (b > 0 && sp(b) < STILL) b--; }
  while (b > 0 && sp(b - 1) >= sp(b)) b--;
  while (b > 0 && sp(b - 1) < sp(b)) b--;
  b++;
  if (b - a < 2) return null;
  let len = 0;
  for (let i = a; i < b; i++) len += sp(i);
  return len < MIN_MOVE ? null : [a, b];
}

// 잔떨림을 없애는 이동 평균 (가까운 5프레임)
function smooth(pts) {
  return pts.map((p, i) => {
    if (!p) return null;
    const s = [0, 0, 0];
    let n = 0;
    for (let k = i - 2; k <= i + 2; k++) {
      const q = pts[k];
      if (!q) continue;
      s[0] += q[0]; s[1] += q[1]; s[2] += q[2]; n++;
    }
    return [s[0] / n, s[1] / n, s[2] / n];
  });
}

function onTop(obj, order) {
  obj.renderOrder = order;
  obj.frustumCulled = false;
  return obj;
}

function basic(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
}

const DOT_GEOM = new THREE.SphereGeometry(1, 20, 14);

function lineMat(opts) {
  return new LineMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...opts });
}

function setSegs(line, pos, col) {
  line.geometry.dispose();
  line.geometry = new LineSegmentsGeometry();
  line.geometry.setPositions(pos);
  if (col) line.geometry.setColors(col);
}

class SideTrail {
  constructor(color) {
    this.color = new THREE.Color(color);
    this.pale = this.color.clone().lerp(new THREE.Color(0xffffff), 0.7);
    this.group = new THREE.Group();
    this.mats = [
      lineMat({ color: 0xffffff, linewidth: PATH_OUT }),
      lineMat({ color: this.color.clone().lerp(new THREE.Color(0xffffff), 0.25), linewidth: PATH_W }),
      lineMat({ color: 0xffffff, linewidth: TAIL_OUT }),
      lineMat({ vertexColors: true, linewidth: TAIL_W }),
    ];
    const [pathOut, path, tailOut, tail] = this.mats.map((m, k) => onTop(new LineSegments2(new LineSegmentsGeometry(), m), TOP + k));
    Object.assign(this, { pathOut, path, tailOut, tail });
    // 지금 손의 위치 (흰 테두리 + 색)
    this.nowBack = onTop(new THREE.Mesh(DOT_GEOM, basic(0xffffff)), TOP + 4);
    this.nowBack.scale.setScalar(0.03);
    this.now = onTop(new THREE.Mesh(DOT_GEOM, basic(color)), TOP + 5);
    this.now.scale.setScalar(0.02);
    this.group.add(pathOut, path, tailOut, tail, this.nowBack, this.now);
    this.group.visible = false;
  }

  build(pts) {
    this.range = coreRange(pts);
    this.pts = smooth(pts);
    if (!this.range) { this.group.visible = false; return; }
    const [a, b] = this.range;
    const pos = [];
    for (let i = a; i < b; i++) {
      const p = this.pts[i], q = this.pts[i + 1];
      if (p && q) pos.push(...p, ...q);
    }
    if (!pos.length) { this.range = null; this.group.visible = false; return; }
    setSegs(this.pathOut, pos);
    setSegs(this.path, pos);
    this.group.visible = true;
    this.setNow(null, -1);
  }

  // 재생 위치(time, 소수 프레임)의 손 위치 p 까지 꼬리를 그린다 (수어 동작 구간에서만)
  setNow(p, time) {
    const r = this.range;
    const on = !!(r && p && time >= r[0] && time <= r[1]);
    for (const o of [this.tail, this.tailOut, this.now, this.nowBack]) o.visible = on;
    if (!on) return;
    this.now.position.set(...p);
    this.nowBack.position.set(...p);
    // 꼬리: 지금 위치 → 지나온 프레임들 (끝으로 갈수록 옅게)
    const chain = [p];
    for (let i = Math.floor(time); i >= Math.max(r[0], Math.floor(time) - TAIL); i--) if (this.pts[i]) chain.push(this.pts[i]);
    const pos = [], col = [];
    const c = new THREE.Color();
    for (let k = 0; k < chain.length - 1; k++) {
      pos.push(...chain[k], ...chain[k + 1]);
      c.copy(this.color).lerp(this.pale, k / TAIL); col.push(c.r, c.g, c.b);
      c.copy(this.color).lerp(this.pale, (k + 1) / TAIL); col.push(c.r, c.g, c.b);
    }
    if (!pos.length) { this.tail.visible = this.tailOut.visible = false; return; }
    setSegs(this.tailOut, pos);
    setSegs(this.tail, pos, col);
  }

  setResolution(w, h) {
    for (const m of this.mats) m.resolution.set(w, h);
  }

  dispose() {
    for (const l of [this.pathOut, this.path, this.tailOut, this.tail]) l.geometry.dispose();
    for (const m of this.mats) m.dispose();
    this.now.material.dispose();
    this.nowBack.material.dispose();
  }
}

export class Trail {
  constructor() {
    this.group = new THREE.Group();
    this.sides = { left: new SideTrail(COLOR.left), right: new SideTrail(COLOR.right) };
    this.group.add(this.sides.left.group, this.sides.right.group);
    this.mirror = false;
  }

  build(frames, mirror) {
    this.mirror = mirror;
    for (const side of ['left', 'right']) {
      const pts = frames.map((f) => {
        const p = palm(f, side);
        return p && mirror ? [-p[0], p[1], p[2]] : p;
      });
      this.sides[side].build(pts);
    }
  }

  // 재생 중인 프레임으로 "지금 손 위치" 점을 옮긴다
  update(frame, time) {
    if (!frame) return;
    for (const side of ['left', 'right']) {
      const p = palm(frame, side);
      this.sides[side].setNow(p && this.mirror ? [-p[0], p[1], p[2]] : p, time);
    }
  }

  setResolution(w, h) {
    for (const s of Object.values(this.sides)) s.setResolution(w, h);
  }

  dispose() {
    for (const s of Object.values(this.sides)) s.dispose();
  }
}
