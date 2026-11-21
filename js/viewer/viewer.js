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
const AVATAR_LIGHT = { hemi: 0.9, dir: 1.0 };

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
    const dt = Math.min(this.clock.getDelta(), 0.1);
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
    background: get('--stage-bg', '#eef1f6'),
    grid: get('--stage-grid', '#c9d0dc'),
    body: get('--stage-body', '#8a94a6'),
    face: get('--stage-face', '#64748b'),
  };
}

const manager = new ViewerManager();

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
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1.5, 3, 4);
    this.scene.add(dir);
    this.dirLight = dir;

    this.grid = new THREE.GridHelper(4, 16);
    this.grid.position.y = -1.6;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

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
    // 아바타는 툰 재질이라 조명을 조금 다르게, 바닥 격자는 발밑으로
    this.hemi.intensity = isAvatar ? AVATAR_LIGHT.hemi : 1.6;
    this.dirLight.intensity = isAvatar ? AVATAR_LIGHT.dir : 1.6;
    this.grid.position.y = isAvatar ? rig.floorY : -1.6;
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
    if (f) this.skeleton.update(f);
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
