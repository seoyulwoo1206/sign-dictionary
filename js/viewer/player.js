// 재생 시간 관리 (재생/일시정지/속도/반복/위치) + 재생 컨트롤 UI
import { lerpFrame } from './smoothing.js';

export const SPEEDS = [0.25, 0.5, 1];

// clip: { fps, frames: [...] } — 동작 JSON 그대로 또는 sequencer가 만든 이어 붙인 클립
export class Player {
  constructor() {
    this.clip = null;
    this.time = 0;         // 프레임 단위 (소수 가능)
    this.speed = 1;
    this.playing = false;
    this.loop = true;
    this.listeners = new Set();
  }

  get frameCount() { return this.clip ? this.clip.frames.length : 0; }
  get fps() { return this.clip?.fps || 30; }
  get duration() { return this.frameCount / this.fps; }

  setClip(clip, { autoplay = true } = {}) {
    this.clip = clip;
    this.time = 0;
    this.playing = autoplay && !!clip;
    this.emit('clip');
  }

  play() {
    if (!this.clip) return;
    if (this.time >= this.frameCount - 1) this.time = 0;
    this.playing = true;
    this.emit('state');
  }
  pause() { this.playing = false; this.emit('state'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  restart() { this.time = 0; this.emit('time'); this.play(); }
  setSpeed(s) { this.speed = s; this.emit('state'); }
  setLoop(v) { this.loop = v; this.emit('state'); }
  seek(frame) {
    this.time = Math.max(0, Math.min(this.frameCount - 1, frame));
    this.emit('time');
  }

  // dt: 초
  update(dt) {
    if (!this.playing || !this.clip) return;
    const last = this.frameCount - 1;
    this.time += dt * this.fps * this.speed;
    if (this.time >= last) {
      if (this.loop) {
        this.time = this.time % Math.max(1, last);
        this.emit('loop');
      } else {
        this.time = last;
        this.playing = false;
        this.emit('end');
        this.emit('state');
      }
    }
    this.emit('time');
  }

  // 현재 시간의 보간된 프레임
  currentFrame() {
    if (!this.clip || !this.frameCount) return null;
    const f = this.clip.frames;
    const i = Math.floor(this.time);
    const t = this.time - i;
    if (t < 1e-3 || i >= f.length - 1) return f[Math.min(i, f.length - 1)];
    return lerpFrame(f[i], f[i + 1], t);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type) { for (const fn of this.listeners) fn(type, this); }
}

// ---------- 컨트롤 UI ----------
// viewer: SignViewer, options: { compact, keyboard, showViewTools }
export function createPlayerControls(viewer, { compact = false, keyboard = false, showViewTools = true } = {}) {
  const p = viewer.player;
  const root = document.createElement('div');
  root.className = 'player-controls' + (compact ? ' compact' : '');

  const btn = (label, aria, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pc-btn ' + cls;
    b.innerHTML = label;
    b.setAttribute('aria-label', aria);
    b.title = aria;
    return b;
  };

  const row1 = document.createElement('div');
  row1.className = 'pc-row';
  const playBtn = btn('', '재생 / 일시정지 (스페이스)', 'pc-play');
  const restartBtn = btn(ICON.restart, '처음으로');
  const loopBtn = btn(ICON.loop, '반복 재생', 'toggle');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.step = 0.01;
  slider.className = 'pc-slider';
  slider.setAttribute('aria-label', '재생 위치');
  row1.append(restartBtn, playBtn, slider, loopBtn);

  const row2 = document.createElement('div');
  row2.className = 'pc-row pc-row2';
  const speedGroup = document.createElement('div');
  speedGroup.className = 'seg';
  speedGroup.setAttribute('role', 'group');
  speedGroup.setAttribute('aria-label', '재생 속도');
  const speedBtns = SPEEDS.map((s) => {
    const b = btn(`${s}x`, `속도 ${s}배`, 'seg-btn');
    b.addEventListener('click', () => p.setSpeed(s));
    speedGroup.append(b);
    return { s, b };
  });
  row2.append(speedGroup);

  let viewBtns = [];
  let mirrorBtn, handBtn, trailBtn;
  if (showViewTools) {
    const viewGroup = document.createElement('div');
    viewGroup.className = 'seg';
    viewGroup.setAttribute('role', 'group');
    viewGroup.setAttribute('aria-label', '시점');
    viewBtns = [['front', '정면'], ['side', '측면'], ['top', '위']].map(([key, label]) => {
      const b = btn(label, `${label} 시점`, 'seg-btn');
      b.addEventListener('click', () => { viewer.setView(key); sync(); });
      viewGroup.append(b);
      return { key, b };
    });
    mirrorBtn = btn(ICON.mirror + '<span>거울</span>', '거울 모드 (좌우 반전)', 'toggle pc-text');
    handBtn = btn(ICON.hand + '<span>손 확대</span>', '손 확대 모드', 'toggle pc-text');
    trailBtn = btn(ICON.trail + '<span>궤적</span>', '손목 궤적 표시', 'toggle pc-text');
    mirrorBtn.addEventListener('click', () => { viewer.setMirror(!viewer.mirror); sync(); });
    handBtn.addEventListener('click', () => { viewer.setHandZoom(!viewer.handZoom); sync(); });
    trailBtn.addEventListener('click', () => { viewer.setTrail(!viewer.trailVisible); sync(); });
    const tools = document.createElement('div');
    tools.className = 'pc-tools';
    tools.append(mirrorBtn, handBtn, trailBtn);
    row2.append(viewGroup);
    root.append(row1, row2, tools);
  } else {
    root.append(row1, row2);
  }

  playBtn.addEventListener('click', () => p.toggle());
  restartBtn.addEventListener('click', () => p.restart());
  loopBtn.addEventListener('click', () => p.setLoop(!p.loop));
  let dragging = false;
  slider.addEventListener('input', () => { dragging = true; p.pause(); p.seek(Number(slider.value)); });
  slider.addEventListener('change', () => { dragging = false; });

  function sync() {
    playBtn.innerHTML = p.playing ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-pressed', String(p.playing));
    loopBtn.classList.toggle('on', p.loop);
    loopBtn.setAttribute('aria-pressed', String(p.loop));
    for (const { s, b } of speedBtns) b.classList.toggle('on', s === p.speed);
    for (const { key, b } of viewBtns) b.classList.toggle('on', key === viewer.view);
    if (mirrorBtn) {
      mirrorBtn.classList.toggle('on', viewer.mirror);
      mirrorBtn.setAttribute('aria-pressed', String(viewer.mirror));
      handBtn.classList.toggle('on', viewer.handZoom);
      handBtn.setAttribute('aria-pressed', String(viewer.handZoom));
      trailBtn.classList.toggle('on', viewer.trailVisible);
      trailBtn.setAttribute('aria-pressed', String(viewer.trailVisible));
    }
    slider.max = Math.max(0, p.frameCount - 1);
  }
  const off = p.on((type) => {
    if (type === 'time') { if (!dragging) slider.value = p.time; }
    else sync();
  });
  sync();

  let onKey = null;
  if (keyboard) {
    onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.code === 'Space') { e.preventDefault(); p.toggle(); }
    };
    document.addEventListener('keydown', onKey);
  }

  return {
    el: root,
    sync,
    dispose() {
      off();
      if (onKey) document.removeEventListener('keydown', onKey);
    },
  };
}

export const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5.5v13L9.5 12z" fill="currentColor"/></svg>',
  loop: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
  mirror: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7l-4 5 4 5z"/><path d="M16 7l4 5-4 5z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>',
  trail: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-6 6 2 9-4s6-6 9-2"/><circle cx="21" cy="11" r="1.5" fill="currentColor"/></svg>',
};
