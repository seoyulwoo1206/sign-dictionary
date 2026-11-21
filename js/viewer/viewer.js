// three.js 씬·카메라·조명·OrbitControls
// WebGL 컨텍스트는 페이지 전체에서 하나만 쓰고, 뷰어마다 화면 영역(scissor)을 나눠 그린다.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Skeleton, Trail } from './skeleton.js';
import { Player } from './player.js';
import { loadAvatar, takePooledAvatar, avatarUnavailable } from './avatar.js';
import { getState } from '../learn/progress.js';

const VIEWS = {
  front: { pos: [0, 0.0, 5.0], target: [0, -0.15, 0.2] },
  side:  { pos: [4.8, 0.0, 0.6], target: [0, -0.15, 0.2] },
  top:   { pos: [0, 4.6, 1.8], target: [0, -0.3, 0.3] },
};
const HAND_DISTANCE = 1.35;
// 조명: 주광(앞 위 왼쪽, 그림자) + 보조광(반대쪽, 차가운 색) + 윤곽광(뒤). 아바타는 툰 재질이라 값이 다르다.
const LIGHTS = {
  avatar:    { hemi: 0.62, key: 1.25, fill: 0.28, rim: 0.5 },
  mannequin: { hemi: 1.6, key: 1.6, fill: 0, rim: 0 },
};
const KEY_DIR = new THREE.Vector3(-1.6, 2.6, 4.2);     // 주광이 오는 방향 (보는 사람 기준 왼쪽 위 앞)
const KEY_DIR_MANNEQUIN = new THREE.Vector3(1.5, 3, 4);
const SHADOW_SIZE = 1024;

// ---------- 배경·바닥 (모든 뷰어가 같은 도형·무늬를 쓴다) ----------
const BACKDROP_GEOM = new THREE.PlaneGeometry(2, 2);
const FLOOR_GEOM = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
let blobTexture = null;
// 가운데가 진하고 가장자리로 갈수록 옅어지는 둥근 무늬 (발밑 그림자·바닥 가장자리 흐림)
function radialTexture() {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  // alphaMap은 초록 채널을 읽으므로 밝기로 그린다 (흰색 = 불투명, 검정 = 투명)
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.45, '#8c8c8c');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}
// 화면 전체를 덮는 배경: 가운데가 밝고 가장자리가 조금 어두운 스튜디오 배경지
function makeBackdrop() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { cCenter: { value: new THREE.Color() }, cEdge: { value: new THREE.Color() } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: `
      uniform vec3 cCenter; uniform vec3 cEdge; varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5, 0.62));
        vec3 col = mix(cCenter, cEdge, smoothstep(0.1, 0.8, d));
        // 띠가 생기지 않게 아주 약한 잡음을 섞는다 (시간에 따라 변하지 않는다)
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(col + n / 255.0, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(BACKDROP_GEOM, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

// 설정에서 마네킹을 고르지 않았으면 아바타(VRM)를 쓴다
function avatarWanted() {
  try { return getState().settings.avatar !== 'mannequin'; } catch { return true; }
}

// ---------- 공용 렌더러 ----------
class ViewerManager {
  constructor() {
    this.viewers = new Set();
    this.renderer = null;
    this.clock = new THREE.Clock();
    this.running = false;
    this.colors = readThemeColors();
    this.loop = this.loop.bind(this);
  }

  init() {
    if (this.renderer) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'viewer-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 색 관리: sRGB 출력 + 색이 바래지 않는 톤 매핑, 부드러운 그림자
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 테마(다크/라이트) 변경 시 배경색 다시 읽기
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', () => this.refreshTheme());
    document.addEventListener('themechange', () => this.refreshTheme());
  }

  refreshTheme() {
    this.colors = readThemeColors();
    for (const v of this.viewers) v.applyTheme(this.colors);
  }

  refreshAvatar() {
    for (const v of this.viewers) v.applyAvatarSetting();
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  add(v) {
    this.init();
    this.viewers.add(v);
    if (!this.running) {
      this.running = true;
      this.clock.getDelta();
      requestAnimationFrame(this.loop);
    }
  }

  remove(v) {
    this.viewers.delete(v);
  }

  loop() {
    if (!this.viewers.size) {
      this.running = false;
      // 마지막 화면 지우기
      this.renderer.setScissorTest(false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      return;
    }
    requestAnimationFrame(this.loop);
    this.frame(Math.min(this.clock.getDelta(), 0.1));
  }

  // 한 프레임: 모든 뷰어를 dt만큼 진행시키고 그린다
  frame(dt) {
    const r = this.renderer;
    const H = window.innerHeight;
    const W = window.innerWidth;

    r.setScissorTest(false);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.setScissorTest(true);

    for (const v of this.viewers) {
      v.tick(dt);
      const rect = v.el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.bottom < 0 || rect.top > H || rect.right < 0 || rect.left > W) continue;
      if (v.el.offsetParent === null && getComputedStyle(v.el).position !== 'fixed') continue;
      const x = rect.left;
      const y = H - rect.bottom;
      r.setViewport(x, y, rect.width, rect.height);
      r.setScissor(x, y, rect.width, rect.height);
      r.setClearColor(v.background, 1);
      v.render(r, rect.width / rect.height);
    }
  }
}

function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    background: get('--stage-bg', '#d9dfeb'),
    backgroundEdge: get('--stage-bg-edge', ''),
    floor: get('--stage-floor', ''),
    grid: get('--stage-grid', '#c9d0dc'),
    body: get('--stage-body', '#8a94a6'),
    face: get('--stage-face', '#64748b'),
  };
}

const manager = new ViewerManager();
// 개발용: 콘솔에서 뷰어 상태를 들여다볼 수 있게 한다
if (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) {
  window.__signViewers = manager.viewers;
  window.__signManager = manager;
}

// ---------- 뷰어 ----------
export class SignViewer {
  // el: 뷰어가 그려질 DOM 요소 (CSS로 크기 지정)
  constructor(el, { interactive = true, mirror = false, view = 'front', handZoom = false, trail = false } = {}) {
    this.el = el;
    el.classList.add('viewer-stage');
    this.player = new Player();
    this.mirror = mirror;
    this.view = view;
    this.handZoom = handZoom;
    this.trailVisible = trail;
    this.interactive = interactive;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
    this.scene.add(this.hemi);
    // 주광: 몸에 팔·손·머리카락의 그림자를 드리운다 (입체감·무게감)
    const key = new THREE.DirectionalLight(0xfff4e8, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    this.dirLight = key;
    // 보조광: 그늘진 쪽이 까맣게 죽지 않게 반대쪽에서 약하게
    this.fillLight = new THREE.DirectionalLight(0xdfe8ff, 0);
    this.fillLight.position.set(3.2, 0.8, 3);
    this.scene.add(this.fillLight);
    // 윤곽광: 뒤에서 비춰 배경과 떨어져 보이게
    this.rimLight = new THREE.DirectionalLight(0xffffff, 0);
    this.rimLight.position.set(1.2, 2.6, -4);
    this.scene.add(this.rimLight);

    this.backdrop = makeBackdrop();
    this.scene.add(this.backdrop);

    this.grid = new THREE.GridHelper(4, 16);
    this.grid.position.y = -1.6;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

    // 바닥(아바타용): 은은한 원판 + 실제 그림자 + 발밑의 부드러운 접지 그림자
    this.floor = new THREE.Group();
    this.floorDisc = new THREE.Mesh(FLOOR_GEOM, new THREE.MeshBasicMaterial({
      color: 0xffffff, alphaMap: radialTexture(), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false,
    }));
    this.floorDisc.scale.setScalar(4.2);
    this.floorShadow = new THREE.Mesh(FLOOR_GEOM, new THREE.ShadowMaterial({ opacity: 0.22, depthWrite: false }));
    this.floorShadow.scale.setScalar(4.2);
    this.floorShadow.position.y = 0.002;
    this.floorShadow.receiveShadow = true;
    this.contact = new THREE.Mesh(FLOOR_GEOM, new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: radialTexture(), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false,
    }));
    this.contact.scale.set(0.95, 1, 0.6);
    this.contact.position.y = 0.004;
    this.floorDisc.renderOrder = -3; this.floorShadow.renderOrder = -2; this.contact.renderOrder = -1;
    this.floor.add(this.floorDisc, this.floorShadow, this.contact);
    this.floor.visible = false;
    this.scene.add(this.floor);

    // 몸: 아바타(VRM)가 준비돼 있으면 바로 쓰고, 아니면 마네킹을 먼저 보여 준 뒤 바꾼다
    this.disposed = false;
    this.skeleton = null;
    this._avatarLoading = false;
    const pooled = avatarWanted() ? takePooledAvatar() : null;
    this.setRig(pooled || new Skeleton());
    if (!pooled) this.applyAvatarSetting();

    this.trail = new Trail();
    this.trail.group.visible = trail;
    this.scene.add(this.trail.group);

    this.controls = null;
    if (interactive) {
      this.controls = new OrbitControls(this.camera, el);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
      this.controls.enablePan = false;
      this.controls.minDistance = 0.6;
      this.controls.maxDistance = 9;
    }
    this._target = new THREE.Vector3();
    this._handTarget = new THREE.Vector3();
    this.setView(view, true);
    this.applyTheme(manager.colors);

    this.player.on((type) => { if (type === 'clip') this.onClip(); });
    manager.add(this);
  }

  // 몸(마네킹 또는 아바타)을 바꿔 끼운다
  setRig(rig) {
    const old = this.skeleton;
    if (old === rig) return;
    if (old) {
      this.scene.remove(old.group);
      old.dispose();
    }
    this.skeleton = rig;
    rig.mirror = this.mirror;
    this.scene.add(rig.group);
    const isAvatar = !!rig.isAvatar;
    // 아바타는 툰 재질이라 조명을 다르게 하고, 격자 대신 발밑 바닥과 그림자를 보여 준다
    const L = isAvatar ? LIGHTS.avatar : LIGHTS.mannequin;
    this.hemi.intensity = L.hemi;
    this.dirLight.intensity = L.key;
    this.fillLight.intensity = L.fill;
    this.rimLight.intensity = L.rim;
    this.dirLight.castShadow = isAvatar;
    const dirv = isAvatar ? KEY_DIR : KEY_DIR_MANNEQUIN;
    if (isAvatar) {
      // 그림자 범위: 머리 위에서 발밑까지
      const top = 1.6, bottom = rig.floorY - 0.2, mid = (top + bottom) / 2;
      this.dirLight.target.position.set(0, mid, 0);
      this.dirLight.position.copy(dirv).normalize().multiplyScalar(12).add(this.dirLight.target.position);
      const cam = this.dirLight.shadow.camera;
      const half = (top - bottom) / 2 + 0.6;
      cam.left = -2.4; cam.right = 2.4; cam.top = half; cam.bottom = -half; cam.near = 4; cam.far = 22;
      cam.updateProjectionMatrix();
      this.floor.position.y = rig.floorY;
    } else {
      this.dirLight.target.position.set(0, 0, 0);
      this.dirLight.position.copy(dirv);
    }
    this.floor.visible = isAvatar;
    this.grid.visible = !isAvatar;
    this.grid.position.y = -1.6;
    if (manager.colors) rig.setColors({ body: manager.colors.body, face: manager.colors.face });
    const clip = this.player.clip;
    if (clip) rig.setClip?.(clip);
    const f = this.player.currentFrame();
    if (f) rig.update(f);
  }

  // 설정(아바타/마네킹)에 맞춰 몸을 고른다. 아바타는 다 읽은 뒤에 바꾼다.
  applyAvatarSetting() {
    if (this.disposed) return;
    const want = avatarWanted() && !avatarUnavailable();
    const isAvatar = !!this.skeleton?.isAvatar;
    if (!want) {
      if (isAvatar) this.setRig(new Skeleton());
      return;
    }
    if (isAvatar || this._avatarLoading) return;
    this._avatarLoading = true;
    loadAvatar().then((avatar) => {
      this._avatarLoading = false;
      if (!avatar) return;
      if (this.disposed || !avatarWanted() || this.skeleton?.isAvatar) { avatar.dispose(); return; }
      this.setRig(avatar);
    });
  }

  applyTheme(colors) {
    this.background = new THREE.Color(colors.background);
    // 배경: 가운데는 무대 색, 가장자리는 조금 더 어둡게 (테마 변수에 값이 있으면 그것을 쓴다)
    const u = this.backdrop.material.uniforms;
    u.cCenter.value.set(colors.background);
    if (colors.backgroundEdge) u.cEdge.value.set(colors.backgroundEdge);
    else u.cEdge.value.set(colors.background).multiplyScalar(0.8);
    const hsl = { h: 0, s: 0, l: 0 };
    this.background.getHSL(hsl);
    const dark = hsl.l < 0.4;
    // 바닥: 밝은 테마에서는 배경보다 조금 밝게, 어두운 테마에서는 조금 밝은 띠로
    if (colors.floor) this.floorDisc.material.color.set(colors.floor);
    else this.floorDisc.material.color.set(colors.background).lerp(new THREE.Color(0xffffff), dark ? 0.12 : 0.5);
    this.floorShadow.material.opacity = dark ? 0.4 : 0.22;
    this.contact.material.opacity = dark ? 0.5 : 0.3;
    this.grid.material.color = new THREE.Color(colors.grid);
    this.skeleton.setColors({ body: colors.body, face: colors.face });
  }

  setClip(clip, opts) {
    this.player.setClip(clip, opts);
  }

  onClip() {
    const clip = this.player.clip;
    if (clip) this.trail.build(clip.frames, this.mirror);
    this.skeleton.setClip?.(clip);
    const f = this.player.currentFrame();
    if (f) this.skeleton.update(f);
  }

  setView(key, instant = false) {
    const v = VIEWS[key] || VIEWS.front;
    this.view = key;
    this.camera.position.set(...v.pos);
    this._target.set(...v.target);
    if (this.handZoom) this.applyHandZoomDistance();
    if (this.controls) {
      this.controls.target.copy(this._target);
      this.controls.update();
    } else {
      this.camera.lookAt(this._target);
    }
    void instant;
  }

  setMirror(on) {
    this.mirror = on;
    this.skeleton.mirror = on;
    if (this.player.clip) this.trail.build(this.player.clip.frames, on);
  }

  setTrail(on) {
    this.trailVisible = on;
    this.trail.group.visible = on;
  }

  setHandZoom(on) {
    this.handZoom = on;
    if (on) {
      const hand = this.currentHandPosition();
      if (hand) this._handTarget.copy(hand);
      this.applyHandZoomDistance();
    } else {
      this.setView(this.view);
    }
  }

  applyHandZoomDistance() {
    const target = this.controls ? this.controls.target : this._target;
    const hand = this.currentHandPosition() || target;
    const dirv = this.camera.position.clone().sub(target).normalize();
    target.copy(hand);
    this._handTarget.copy(hand);
    this.camera.position.copy(hand).addScaledVector(dirv, HAND_DISTANCE);
    if (this.controls) this.controls.update(); else this.camera.lookAt(target);
  }

  // 주로 쓰는 손(오른손, 없으면 왼손)의 손바닥 중심
  currentHandPosition() {
    const f = this.player.currentFrame();
    if (!f) return null;
    const avatar = this.skeleton.isAvatar ? this.skeleton : null;
    // 아바타는 체형 보정 때문에 손이 좌표와 조금 다른 자리에 올 수 있어 실제 손 위치를 쓴다
    const onAvatar = (side) => avatar.handCenter((side === 'left') !== this.mirror ? 'left' : 'right', new THREE.Vector3());
    const pick = (pts, side) => {
      if (avatar) return onAvatar(side);
      const w = pts[0], m = pts[9];
      const x = (w[0] + m[0]) / 2;
      return new THREE.Vector3(this.mirror ? -x : x, (w[1] + m[1]) / 2, (w[2] + m[2]) / 2);
    };
    if (f.right && f.left) {
      // 더 높이 든 손을 따라간다
      return f.right[0][1] >= f.left[0][1] - 0.15 ? pick(f.right, 'right') : pick(f.left, 'left');
    }
    if (f.right) return pick(f.right, 'right');
    if (f.left) return pick(f.left, 'left');
    if (avatar) return onAvatar('right');
    const w = f.pose[16];
    return new THREE.Vector3(this.mirror ? -w[0] : w[0], w[1], w[2]);
  }

  tick(dt) {
    this.player.update(dt);
    const f = this.player.currentFrame();
    if (f) this.skeleton.update(f, dt);
    if (this.handZoom && f) {
      const hand = this.currentHandPosition();
      if (hand) {
        const target = this.controls ? this.controls.target : this._target;
        const before = target.clone();
        this._handTarget.lerp(hand, Math.min(1, dt * 6));
        target.copy(this._handTarget);
        this.camera.position.add(target.clone().sub(before));
        if (!this.controls) this.camera.lookAt(target);
      }
    }
    if (this.controls) this.controls.update();
  }

  render(renderer, aspect) {
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    manager.remove(this);
    this.controls?.dispose();
    this.skeleton.dispose();
    this.trail.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.backdrop.material.dispose();
    this.floorDisc.material.dispose();
    this.floorShadow.material.dispose();
    this.contact.material.dispose();
    this.dirLight.shadow.map?.dispose();
    this.dirLight.shadow.dispose?.();
    this.player.listeners.clear();
  }
}

export function refreshViewerTheme() {
  manager.refreshTheme();
}

// 설정에서 아바타/마네킹을 바꾼 뒤 부르면 열려 있는 뷰어에 바로 반영된다
export function refreshViewerAvatar() {
  manager.refreshAvatar();
}
