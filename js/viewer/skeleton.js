// 관절 좌표 → 3D 마네킹 (몸통·팔·손바닥·손가락·머리·얼굴)
// 좌표 데이터는 그대로 두고, 그 위에 살을 붙여 그린다.
import * as THREE from 'three';
import { HAND_CONNECTIONS, HAND_COUNT, FACE_GROUP_RANGES } from './landmarks.js';

export const COLORS = {
  shirt: 0x5a6f96,
  skin: 0xf0c4a0,
  hair: 0x3a2a22,
  feature: 0x3b2f2f,
  lips: 0xc0605a,
  left: 0x3b82f6,   // 수어하는 사람의 왼손: 파랑
  right: 0xf97316,  // 수어하는 사람의 오른손: 주황
};

// 손바닥 안쪽 연결선은 손바닥 면으로 대신 그린다
const PALM_EDGES = new Set(['0-5', '5-9', '9-13', '13-17', '0-17']);
const FINGER_BONES = HAND_CONNECTIONS.filter(([a, b]) => !PALM_EDGES.has(`${a}-${b}`));
const PALM_RING = [0, 1, 5, 9, 13, 17];

// 손 관절별 굵기 (어깨 너비 = 1 기준)
const HAND_R = (() => {
  const r = new Array(21);
  r[0] = 0.042;
  r[1] = 0.032; r[2] = 0.028; r[3] = 0.025; r[4] = 0.022;
  for (let f = 0; f < 4; f++) {
    const s = f === 3 ? 0.003 : 0;
    r[5 + f * 4] = 0.026 - s;
    r[6 + f * 4] = 0.024 - s;
    r[7 + f * 4] = 0.021 - s;
    r[8 + f * 4] = 0.019 - s;
  }
  return r;
})();

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// 원기둥을 두 점 사이에 맞추는 행렬 (geometry의 +y 쪽이 b)
function boneMatrix(a, b, radius, out) {
  _d.subVectors(b, a);
  const length = _d.length();
  if (length < 1e-6) return out.copy(ZERO);
  _q.setFromUnitVectors(UP, _d.divideScalar(length));
  _s.set(radius, length, radius);
  _a.addVectors(a, b).multiplyScalar(0.5);
  return out.compose(_a, _q, _s);
}

function jointMatrix(p, radius, out) {
  _s.set(radius, radius, radius);
  _q.identity();
  return out.compose(p, _q, _s);
}

// 몸통 옆모습 단면 (r: 어깨 너비 절반 기준, y: 0 = 엉덩이, 1 = 어깨)
const TORSO_PROFILE = [
  [0, 0], [0.62, 0], [0.66, 0.08], [0.6, 0.32], [0.64, 0.5], [0.76, 0.72],
  [0.85, 0.88], [0.84, 0.97], [0.7, 1.04], [0.42, 1.09], [0.16, 1.11], [0, 1.11],
].map(([r, y]) => new THREE.Vector2(r, y));

export class Skeleton {
  constructor() {
    this.group = new THREE.Group();
    this.mirror = false;

    const sphere = new THREE.SphereGeometry(1, 20, 14);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    const limb = new THREE.CylinderGeometry(0.8, 1, 1, 16, 1, true); // 아래(a)가 굵고 위(b)가 가늘다
    this.geoms = [sphere, cyl, limb];
    const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02, ...extra });
    const handColor = (c) => new THREE.Color(COLORS.skin).lerp(new THREE.Color(c), 0.55);

    this.m = {
      shirt: mat(COLORS.shirt, { roughness: 0.8 }),
      skin: mat(COLORS.skin, { roughness: 0.55 }),
      hair: mat(COLORS.hair, { roughness: 0.9 }),
      feature: new THREE.MeshBasicMaterial({ color: COLORS.feature }),
      lips: mat(COLORS.lips, { roughness: 0.5 }),
      left: mat(handColor(COLORS.left), { side: THREE.DoubleSide }),
      right: mat(handColor(COLORS.right), { side: THREE.DoubleSide }),
    };
    const inst = (geom, material, count) => {
      const m = new THREE.InstancedMesh(geom, material, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };

    // 몸통
    this.torso = new THREE.Mesh(new THREE.LatheGeometry(TORSO_PROFILE, 36), this.m.shirt);
    this.torso.matrixAutoUpdate = false;
    this.group.add(this.torso);

    // 팔: 위팔(소매) / 아래팔(피부)
    this.upperArms = inst(limb, this.m.shirt, 2);
    this.foreArms = inst(limb, this.m.skin, 2);
    this.shirtJoints = inst(sphere, this.m.shirt, 4); // 어깨 2, 팔꿈치 2
    this.wrists = inst(sphere, this.m.skin, 2);
    // 손 데이터가 없을 때 포즈의 손 점으로 대충 그리는 손
    this.poseHands = inst(cyl, this.m.skin, 8);

    // 손
    this.hands = {};
    for (const side of ['left', 'right']) {
      const palm = new THREE.Mesh(new THREE.BufferGeometry(), this.m[side]);
      palm.frustumCulled = false;
      this.group.add(palm);
      this.hands[side] = {
        bones: inst(cyl, this.m[side], FINGER_BONES.length),
        joints: inst(sphere, this.m[side], HAND_COUNT),
        palm,
      };
    }

    // 목·머리·머리카락
    this.neck = new THREE.Mesh(limb, this.m.skin);
    this.neck.matrixAutoUpdate = false;
    this.head = new THREE.Mesh(sphere, this.m.skin);
    this.head.matrixAutoUpdate = false;
    this.hair = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.46), this.m.hair);
    this.hair.matrixAutoUpdate = false;
    this.ears = inst(sphere, this.m.skin, 2);
    this.group.add(this.neck, this.head, this.hair);

    // 얼굴: 눈썹·눈(선), 눈동자, 입술, 코
    const featureRanges = FACE_GROUP_RANGES.filter((g) => /Brow|Eye/.test(g.name));
    const lipRanges = FACE_GROUP_RANGES.filter((g) => /Lips/.test(g.name));
    const segCount = (rs) => rs.reduce((n, g) => n + (g.closed ? g.end - g.start : g.end - g.start - 1), 0);
    this.featureRanges = featureRanges;
    this.lipRanges = lipRanges;
    this.features = inst(cyl, this.m.feature, segCount(featureRanges));
    this.pupils = inst(sphere, this.m.feature, 2);
    this.lipSegs = inst(cyl, this.m.lips, segCount(lipRanges));
    this.noseTip = new THREE.Mesh(sphere, this.m.skin);
    this.noseTip.matrixAutoUpdate = false;
    this.group.add(this.noseTip);

    this._p = Array.from({ length: 8 }, () => new THREE.Vector3());
  }

  // [x,y,z] → Vector3 (거울 모드면 x 반전)
  vec(p, out) {
    return out.set(this.mirror ? -p[0] : p[0], p[1], p[2]);
  }

  // 원본 좌표계의 방향 벡터를 거울 모드에 맞게 바꾼다
  mdir(v) {
    if (this.mirror) v.x = -v.x;
    return v;
  }

  update(frame) {
    if (!frame) return;
    const pose = frame.pose;
    const P = (i, out) => this.vec(pose[i], out);
    const [lsh, rsh, lel, rel, lwr, rwr, lhip, rhip] = this._p;
    P(11, lsh); P(12, rsh); P(13, lel); P(14, rel);
    P(23, lhip); P(24, rhip);
    // 손 데이터가 있으면 손의 손목점을 쓴다 (팔과 손이 이어지게)
    if (frame.left) this.vec(frame.left[0], lwr); else P(15, lwr);
    if (frame.right) this.vec(frame.right[0], rwr); else P(16, rwr);

    this.updateTorso(pose, lsh, rsh, lhip, rhip);

    // 팔
    this.upperArms.setMatrixAt(0, boneMatrix(lsh, lel, 0.105, _m));
    this.upperArms.setMatrixAt(1, boneMatrix(rsh, rel, 0.105, _m));
    this.foreArms.setMatrixAt(0, boneMatrix(lel, lwr, 0.08, _m));
    this.foreArms.setMatrixAt(1, boneMatrix(rel, rwr, 0.08, _m));
    this.shirtJoints.setMatrixAt(0, jointMatrix(lsh, 0.125, _m));
    this.shirtJoints.setMatrixAt(1, jointMatrix(rsh, 0.125, _m));
    this.shirtJoints.setMatrixAt(2, jointMatrix(lel, 0.088, _m));
    this.shirtJoints.setMatrixAt(3, jointMatrix(rel, 0.088, _m));
    this.wrists.setMatrixAt(0, jointMatrix(lwr, 0.062, _m));
    this.wrists.setMatrixAt(1, jointMatrix(rwr, 0.062, _m));
    for (const m of [this.upperArms, this.foreArms, this.shirtJoints, this.wrists]) m.instanceMatrix.needsUpdate = true;

    // 손
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    let k = 0;
    for (const [side, wristIdx, pts] of [['left', 15, [17, 19, 21]], ['right', 16, [18, 20, 22]]]) {
      const h = this.hands[side];
      const data = frame[side];
      h.bones.visible = h.joints.visible = h.palm.visible = !!data;
      if (data) {
        FINGER_BONES.forEach(([a, b], i) => {
          h.bones.setMatrixAt(i, boneMatrix(this.vec(data[a], va), this.vec(data[b], vb), Math.min(HAND_R[a], HAND_R[b]), _m));
        });
        for (let i = 0; i < HAND_COUNT; i++) h.joints.setMatrixAt(i, jointMatrix(this.vec(data[i], va), HAND_R[i], _m));
        h.bones.instanceMatrix.needsUpdate = true;
        h.joints.instanceMatrix.needsUpdate = true;
        this.updatePalm(h.palm.geometry, data);
        for (let i = 0; i < 3; i++) this.poseHands.setMatrixAt(k++, ZERO);
        this.poseHands.setMatrixAt(k++, ZERO);
      } else {
        // 손이 안 보이는 프레임: 포즈의 손 점으로 간단한 손
        P(wristIdx, va);
        for (const j of pts) this.poseHands.setMatrixAt(k++, boneMatrix(va, P(j, vb), 0.03, _m));
        this.poseHands.setMatrixAt(k++, ZERO);
      }
    }
    this.poseHands.instanceMatrix.needsUpdate = true;

    this.updateHead(frame, lsh, rsh);
  }

  updateTorso(pose, lsh, rsh, lhip, rhip) {
    const shMid = new THREE.Vector3().addVectors(lsh, rsh).multiplyScalar(0.5);
    const hipMid = new THREE.Vector3().addVectors(lhip, rhip).multiplyScalar(0.5);
    const width = lsh.distanceTo(rsh);
    const upv = new THREE.Vector3().subVectors(shMid, hipMid);
    const height = upv.length();
    upv.normalize();
    // 방향은 원본 좌표로 계산한 뒤 거울 반영 (좌우가 뒤집혀도 오른손 좌표계 유지)
    const rawSide = new THREE.Vector3(pose[11][0] - pose[12][0], pose[11][1] - pose[12][1], pose[11][2] - pose[12][2]);
    const rawUp = new THREE.Vector3(
      (pose[11][0] + pose[12][0] - pose[23][0] - pose[24][0]) / 2,
      (pose[11][1] + pose[12][1] - pose[23][1] - pose[24][1]) / 2,
      (pose[11][2] + pose[12][2] - pose[23][2] - pose[24][2]) / 2,
    );
    const fwd = this.mdir(new THREE.Vector3().crossVectors(rawSide, rawUp).normalize());
    const side = new THREE.Vector3().crossVectors(upv, fwd).normalize();
    fwd.crossVectors(side, upv).normalize();
    const sx = width * 0.5;
    const m = this.torso.matrix;
    m.makeBasis(side.multiplyScalar(sx), upv.clone().multiplyScalar(height), fwd.multiplyScalar(width * 0.27));
    m.setPosition(hipMid);
  }

  updatePalm(geom, data) {
    const t = 0.024;
    const pts = PALM_RING.map((i) => this.vec(data[i], new THREE.Vector3()));
    const n = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(pts[2], pts[0]),
      new THREE.Vector3().subVectors(pts[5], pts[0]),
    ).normalize().multiplyScalar(t);
    const c = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const N = pts.length;
    const pos = [];
    const push = (v) => pos.push(v.x, v.y, v.z);
    const top = pts.map((p) => p.clone().add(n));
    const bot = pts.map((p) => p.clone().sub(n));
    const cTop = c.clone().add(n);
    const cBot = c.clone().sub(n);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      push(cTop); push(top[i]); push(top[j]);
      push(cBot); push(bot[j]); push(bot[i]);
      push(top[i]); push(bot[i]); push(bot[j]);
      push(top[i]); push(bot[j]); push(top[j]);
    }
    const arr = new Float32Array(pos);
    const attr = geom.getAttribute('position');
    if (attr && attr.array.length === arr.length) { attr.array.set(arr); attr.needsUpdate = true; }
    else geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
  }

  updateHead(frame, lsh, rsh) {
    const face = frame.face;
    const pose = frame.pose;
    const shMid = new THREE.Vector3().addVectors(lsh, rsh).multiplyScalar(0.5);
    const center = new THREE.Vector3();
    const side = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    let rx = 0.3, ry = 0.4;
    const rz = () => rx * 0.95;

    const rangeOf = (name) => FACE_GROUP_RANGES.find((g) => g.name === name);
    const meanRaw = (g) => {
      const v = new THREE.Vector3();
      for (let i = g.start; i < g.end; i++) v.add(new THREE.Vector3(...face[i]));
      return v.divideScalar(g.end - g.start);
    };

    if (face && face.length) {
      const le = meanRaw(rangeOf('leftEye'));
      const re = meanRaw(rangeOf('rightEye'));
      const lips = meanRaw(rangeOf('outerLips'));
      const oval = rangeOf('oval');
      const ovalC = meanRaw(oval);
      const eyeMid = le.clone().add(re).multiplyScalar(0.5);
      // 원본 좌표로 머리 방향 계산
      const rSide = le.clone().sub(re).normalize();
      const rUp = eyeMid.clone().sub(lips);
      const rFwd = new THREE.Vector3().crossVectors(rSide, rUp).normalize();
      const rUpN = new THREE.Vector3().crossVectors(rFwd, rSide).normalize();
      // 얼굴 테두리 크기 (머리 축 기준)
      let maxS = 0, maxU = 0;
      for (let i = oval.start; i < oval.end; i++) {
        const d = new THREE.Vector3(...face[i]).sub(ovalC);
        maxS = Math.max(maxS, Math.abs(d.dot(rSide)));
        maxU = Math.max(maxU, Math.abs(d.dot(rUpN)));
      }
      rx = THREE.MathUtils.clamp(maxS * 1.02, 0.18, 0.45);
      ry = THREE.MathUtils.clamp(maxU * 1.05, 0.26, 0.6);
      // 눈 위치에서 머리 표면이 눈 바로 뒤에 오도록 중심을 뒤로
      const eyeX = le.clone().sub(re).length() / 2;
      const surf = rz() * Math.sqrt(Math.max(0.05, 1 - (eyeX / rx) ** 2));
      const rawCenter = ovalC.clone().addScaledVector(rFwd, -surf + (eyeMid.clone().sub(ovalC).dot(rFwd)) - 0.006);
      this.vec([rawCenter.x, rawCenter.y, rawCenter.z], center);
      fwd.copy(this.mdir(rFwd.clone()));
      up.copy(this.mdir(rUpN.clone()));
    } else {
      const nose = this.vec(pose[0], new THREE.Vector3());
      center.set(nose.x, nose.y + 0.02, nose.z - 0.26);
      fwd.set(0, 0, 1);
      up.set(0, 1, 0);
    }
    side.crossVectors(up, fwd).normalize();
    fwd.crossVectors(side, up).normalize();

    // 머리
    const hm = this.head.matrix;
    hm.makeBasis(side.clone().multiplyScalar(rx), up.clone().multiplyScalar(ry), fwd.clone().multiplyScalar(rz()));
    hm.setPosition(center);
    // 머리카락: 머리 위쪽을 덮는 반구, 살짝 뒤로
    const hairM = this.hair.matrix;
    const tilt = new THREE.Vector3().copy(up).multiplyScalar(Math.cos(0.35)).addScaledVector(fwd, -Math.sin(0.35)).normalize();
    const tiltF = new THREE.Vector3().crossVectors(side, tilt).normalize();
    hairM.makeBasis(side.clone().multiplyScalar(rx * 1.06), tilt.clone().multiplyScalar(ry * 1.04), tiltF.multiplyScalar(rz() * 1.08));
    hairM.setPosition(center.clone().addScaledVector(up, ry * 0.02));
    // 귀
    for (const [i, s] of [[0, 1], [1, -1]]) {
      const p = center.clone().addScaledVector(side, s * rx * 0.97).addScaledVector(up, ry * 0.05);
      _s.set(0.035, 0.07, 0.05);
      this.ears.setMatrixAt(i, _m.compose(p, _q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd)), _s));
    }
    this.ears.instanceMatrix.needsUpdate = true;
    // 목: 어깨 중점 → 머리 아래
    const neckTop = center.clone().addScaledVector(up, -ry * 0.55).addScaledVector(fwd, -rz() * 0.2);
    boneMatrix(shMid.clone().add(new THREE.Vector3(0, -0.05, -0.02)), neckTop, 0.085, this.neck.matrix);

    // 얼굴 특징
    const visible = !!(face && face.length);
    this.features.visible = this.pupils.visible = this.lipSegs.visible = this.noseTip.visible = visible;
    if (!visible) return;
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const drawLines = (mesh, ranges, radius) => {
      let i = 0;
      for (const g of ranges) {
        const n = g.end - g.start;
        const count = g.closed ? n : n - 1;
        for (let k = 0; k < count; k++) {
          const a = g.start + k;
          const b = g.start + ((k + 1) % n);
          mesh.setMatrixAt(i++, boneMatrix(this.vec(face[a], va), this.vec(face[b], vb), radius, _m));
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    drawLines(this.features, this.featureRanges, 0.0075);
    drawLines(this.lipSegs, this.lipRanges, 0.011);
    ['leftEye', 'rightEye'].forEach((name, i) => {
      const g = rangeOf(name);
      const c = new THREE.Vector3();
      for (let k = g.start; k < g.end; k++) c.add(this.vec(face[k], va));
      c.divideScalar(g.end - g.start);
      this.pupils.setMatrixAt(i, jointMatrix(c, 0.019, _m));
    });
    this.pupils.instanceMatrix.needsUpdate = true;
    const nose = rangeOf('nose');
    this.noseTip.matrix.copy(jointMatrix(this.vec(face[nose.end - 1], va), 0.032, _m));
  }

  setColors(colors) {
    if (colors.body !== undefined) this.m.shirt.color.set(colors.body);
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const g of this.geoms) g.dispose();
    for (const m of Object.values(this.m)) m.dispose();
  }
}

function setPositions(geom, arr) {
  const attr = geom.getAttribute('position');
  if (attr && attr.array.length === arr.length) {
    attr.array.set(arr);
    attr.needsUpdate = true;
  } else {
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  }
  geom.computeBoundingSphere();
}
