// 화면 구성 도우미: 요소 만들기, 알림, 효과음, 공용 조각
import { getState } from './learn/progress.js';

// h('div.card#id', { onclick, 'aria-label': ... }, child1, child2...)
export function h(tag, attrs, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else if (part[0] === '#') el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// 화면 아래 짧은 알림
export function toast(message, { type = '', duration = 2600 } = {}) {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div.toast', { class: type }, message);
  box.append(t);
  setTimeout(() => t.classList.add('out'), duration);
  setTimeout(() => t.remove(), duration + 400);
}

// 효과음 (Web Audio로 짧게 합성 — 파일 없음)
let audioCtx = null;
export function playSound(kind) {
  if (getState().settings.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = {
      correct: [[660, 0], [880, 0.09]],
      wrong: [[220, 0], [180, 0.12]],
      complete: [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]],
    }[kind] || [[440, 0]];
    const now = audioCtx.currentTime;
    for (const [freq, at] of notes) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = kind === 'wrong' ? 'triangle' : 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + at);
      g.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + at);
      o.stop(now + at + 0.22);
    }
  } catch { /* 소리 실패는 무시 */ }
}

export function verifiedBadge(entry) {
  return entry.verified
    ? h('span.badge.ok', { title: '농인 또는 수어 통역사 검수 완료' }, '✓ 검수 완료')
    : h('span.badge.warn', { title: '아직 검수 전인 데이터입니다' }, '학습 참고용');
}

export function levelDots(level) {
  return h('span.level', { 'aria-label': `난이도 ${level}` },
    [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= level ? 'on' : '' })));
}

export function wordHref(word) {
  return '#/word/' + encodeURIComponent(word);
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function loadingView(text = '불러오는 중…') {
  return h('div.loading', { role: 'status' }, h('span.spinner', { 'aria-hidden': 'true' }), text);
}

export function errorView(err) {
  console.error(err);
  return h('div.error-box', { role: 'alert' },
    h('span.state-ico', { 'aria-hidden': 'true' }, '😥'),
    h('strong', '문제가 생겼어요'),
    h('p', String(err && err.message ? err.message : err)),
    location.protocol === 'file:'
      ? h('p.muted.small', '로컬에서 열었다면 python -m http.server 로 서버를 띄워서 열어주세요 (file:// 주소로는 데이터를 불러올 수 없어요).')
      : h('p.muted.small', '잠시 뒤 다시 시도하거나 홈에서 다시 시작해 보세요.'),
    h('a.btn.small', { href: '#/' }, '홈으로'),
  );
}

// 테마: auto / light / dark
export function applyTheme() {
  const t = getState().settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  document.dispatchEvent(new Event('themechange'));
}
