// 마스코트 "수달이": 청록 목도리를 한 아기 수달 (수어 + 수달). 이 앱만의 캐릭터.
//
//   mascot(mood, { size, label, stage })  → <span class="mascot mood-…"> (누르면 반응)
//   react(el, kind)                        → 움직이며 반응: love(쓰다듬기) · jump(정답) · shake(오답) · party(완료)
//   growTo(el, stage)                      → 다음 단계로 자라는 장면
//   petInfo(xp)                            → 지금 성장 단계와 다음 단계까지 남은 XP
//
// 기분(mood): wave(손 흔들기) · cheer(만세) · happy(웃음) · sad(시무룩) · think(갸웃) · sleep(졸림)
// 성장(stage): XP 가 쌓이면 아기 → 꼬마(목도리) → 학생(책가방) → 선생님(학사모) → 수어 달인(왕관)
import { h } from './ui.js';
import { getState } from './learn/progress.js';

export const MASCOT_NAME = '수달이';

export const STAGES = [
  { xp: 0, name: '아기 수달', desc: '이제 막 태어났어요. 같이 첫 수어를 배워요!' },
  { xp: 30, name: '꼬마 수달', desc: '청록 목도리를 받았어요! 쑥쑥 자라는 중이에요.' },
  { xp: 100, name: '학생 수달', desc: '책가방을 메고 수어 학교에 다녀요.' },
  { xp: 250, name: '선생님 수달', desc: '학사모를 썼어요. 친구들에게 수어를 알려 줄 수 있어요.' },
  { xp: 500, name: '수어 달인', desc: '왕관을 쓴 수어 달인! 정말 대단해요.' },
];

export function stageIndex(xp = 0) {
  let i = 0;
  while (i + 1 < STAGES.length && xp >= STAGES[i + 1].xp) i++;
  return i;
}

export function petInfo(xp = getState().xp) {
  const stage = stageIndex(xp);
  const next = STAGES[stage + 1] || null;
  const from = STAGES[stage].xp;
  return {
    stage, xp, ...STAGES[stage], next,
    toNext: next ? next.xp - xp : 0,
    pct: next ? Math.round(((xp - from) / (next.xp - from)) * 100) : 100,
  };
}

const currentStage = () => { try { return stageIndex(getState().xp); } catch { return 0; } };

const K = {
  fur: '#c98a52', furHi: '#e6b07a', furLo: '#a9703f', line: '#6e4527', cream: '#fff4e2',
  cheek: '#ff9c8c', ink: '#2d1d14', mouth: '#5a2a22', pad: '#f6a9a0', innerEar: '#e8a68a',
  scarf: '#17a596', scarfLo: '#0f766e', scarfLine: '#0a5f58', gold: '#f5c451', goldLine: '#b98a1c',
};

// ---------- 그림 조각 ----------
function arm(cls, sx, sy, hx, hy) {
  const d = `M${sx} ${sy}L${hx} ${hy}`;
  return `<g class="m-arm ${cls}" style="transform-origin:${sx}px ${sy}px">
    <path d="${d}" stroke="${K.line}" stroke-width="12.6" stroke-linecap="round"/>
    <path d="${d}" stroke="${K.fur}" stroke-width="8.2" stroke-linecap="round"/>
  </g>`;
}

const ARMS = {
  wave: arm('left', 45, 87, 40, 99) + arm('right wave', 75, 86, 89, 70),
  cheer: arm('left up', 45, 86, 32, 71) + arm('right up', 75, 86, 88, 71),
  happy: arm('left', 45, 87, 51, 98) + arm('right', 75, 87, 69, 98),
  sad: arm('left', 46, 88, 46, 101) + arm('right', 74, 88, 74, 101),
  think: arm('left', 45, 87, 51, 98) + arm('right', 75, 86, 81, 74),
  sleep: arm('left', 45, 88, 52, 99) + arm('right', 75, 88, 68, 99),
};

const eye = (cx, cy, r) => `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * 1.14).toFixed(2)}" fill="${K.ink}"/>
  <circle cx="${(cx + r * 0.33).toFixed(2)}" cy="${(cy - r * 0.4).toFixed(2)}" r="${(r * 0.42).toFixed(2)}" fill="#fff"/>
  <circle cx="${(cx - r * 0.34).toFixed(2)}" cy="${(cy + r * 0.42).toFixed(2)}" r="${(r * 0.19).toFixed(2)}" fill="#fff" opacity=".85"/>`;

const EYES = {
  open: `<g class="m-eyes">${eye(45, 53, 5.6)}${eye(75, 53, 5.6)}</g>`,
  smile: `<path d="M39.5 55q5.5-7.5 11 0M69.5 55q5.5-7.5 11 0" stroke="${K.ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  sad: `<g class="m-eyes">${eye(45, 54, 5)}${eye(75, 54, 5)}</g>
    <path d="M38.5 46.5l9-3M81.5 46.5l-9-3" stroke="${K.line}" stroke-width="2.2" stroke-linecap="round"/>`,
  closed: `<path d="M39.5 53q5.5 5.5 11 0M69.5 53q5.5 5.5 11 0" stroke="${K.ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`,
};

const NOSE = `<path d="M56 56.6q4-2 8 0q-.6 3.6-4 4.2q-3.4-.6-4-4.2z" fill="${K.ink}"/><ellipse cx="58.4" cy="57.1" rx="1.4" ry=".7" fill="#fff" opacity=".6"/>`;
const MOUTH = {
  smile: `<path d="M60 60.6v2.2M55.5 62.6q2.25 2.8 4.5 0q2.25 2.8 4.5 0" stroke="${K.ink}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  open: `<path d="M60 60.6v1.6" stroke="${K.ink}" stroke-width="1.8" stroke-linecap="round"/><path d="M54.5 62.4h11q-1 7.2-5.5 7.2t-5.5-7.2z" fill="${K.mouth}"/><path d="M57 67.4q3-2.6 6 0q-3 2.2-6 0z" fill="#ff8a8a"/>`,
  sad: `<path d="M60 60.6v1.8M56 66q4-3.4 8 0" stroke="${K.ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  flat: `<path d="M60 60.6v1.8M56.5 64.4q1.75-1.6 3.5 0q1.75 1.6 3.5 0" stroke="${K.ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  o: `<ellipse cx="60" cy="64.6" rx="2" ry="2.4" fill="${K.mouth}"/>`,
};

const FACES = {
  wave: [EYES.open, MOUTH.smile],
  cheer: [EYES.smile, MOUTH.open],
  happy: [EYES.smile, MOUTH.smile],
  sad: [EYES.sad, MOUTH.sad],
  think: [EYES.open, MOUTH.flat],
  sleep: [EYES.closed, MOUTH.o],
};

// 기분마다 덧붙이는 것 (머리 옆)
const EXTRA = {
  sleep: `<g class="m-zzz" fill="${K.scarfLo}" font-weight="800" font-family="sans-serif"><text x="88" y="30" font-size="12">z</text><text x="97" y="21" font-size="8.5">z</text></g>
    <circle class="m-bubble" cx="66.5" cy="59" r="3.6" fill="#cfeef7" fill-opacity=".55" stroke="#8fd0e3" stroke-width="1"/>`,
  think: `<g class="m-q" fill="${K.scarfLo}" font-weight="800" font-family="sans-serif"><text x="92" y="28" font-size="17">?</text></g>`,
  cheer: `<g class="m-spark" fill="${K.gold}"><path d="M14 38l2.4 5.2 5.2 2.4-5.2 2.4-2.4 5.2-2.4-5.2-5.2-2.4 5.2-2.4z"/><path d="M106 28l1.9 3.9 3.9 1.9-3.9 1.9-1.9 3.9-1.9-3.9-3.9-1.9 3.9-1.9z"/></g>`,
  sad: `<path class="m-tear" d="M81 57q2.4 3.8 0 5.6q-2.4-1.8 0-5.6z" fill="#6cb4e4"/>`,
};

// 단계별 몸 크기: 자랄수록 몸이 길어지고 머리 비율은 조금 작아진다 (그래도 늘 아기처럼 머리가 크다)
const BODY = [
  { rx: 21, ry: 17 }, { rx: 22, ry: 18.5 }, { rx: 23, ry: 20 }, { rx: 23.5, ry: 21 }, { rx: 24, ry: 22 },
];

function headGear(stage, top) {
  if (stage === 3) { // 학사모
    return `<g transform="rotate(-8 60 ${top})">
      <path d="M47 ${top + 4}q13 5 26 0v-7.5q-13-4-26 0z" fill="#33445c" stroke="#1c2633" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M60 ${top - 13}l24 7.5-24 7.5-24-7.5z" fill="#43587a" stroke="#1c2633" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M60 ${top - 5.5}q12 .5 15.5 8v6.5" stroke="${K.gold}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <rect x="73.6" y="${top + 8}" width="3.8" height="5" rx="1.2" fill="${K.gold}"/>
      <circle cx="60" cy="${top - 5.5}" r="1.7" fill="${K.gold}"/>
    </g>`;
  }
  if (stage === 4) { // 왕관
    return `<g class="m-crown">
      <path d="M45.5 ${top + 5}l-2.5-14 8.8 7 8.2-10.5 8.2 10.5 8.8-7-2.5 14q-14.5 4-29 0z" fill="${K.gold}" stroke="${K.goldLine}" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="60" cy="${top - 0.5}" r="2.2" fill="#e8546a"/><circle cx="50.5" cy="${top + 1.5}" r="1.5" fill="#3fb6e8"/><circle cx="69.5" cy="${top + 1.5}" r="1.5" fill="#3fb6e8"/>
      <path d="M48 ${top + 2}q12 3 24 0" stroke="#fff" stroke-width="1" fill="none" opacity=".5"/>
    </g>`;
  }
  return '';
}

function svg(mood = 'wave', stage = 0) {
  stage = Math.max(0, Math.min(STAGES.length - 1, stage | 0));
  const id = `ms${++uid}`;
  const [eyes, mouth] = FACES[mood] || FACES.wave;
  const B = BODY[stage];
  const dy = -stage * 1.5;               // 자랄수록 머리가 위로
  const hr = 34 - stage * 0.5, hv = 29 - stage * 0.5; // 머리 크기
  const top = 50 - hv;
  const bcy = 110 - B.ry;
  const backpack = stage === 2;
  // 머리 위 삐죽한 털 (수달이의 트레이드마크, 모자를 쓰면 가려진다)
  const tuft = stage < 3
    ? `<path class="m-tuft" d="M58 ${top + 3}c-2.5-6 1-10.5 6-9.5c-2.6 1.2-3.2 3.4-2.4 5.6c1.6-3.2 5-4.4 8-2.8c-3 .6-5 2.8-5.6 6z" fill="${K.fur}" stroke="${K.line}" stroke-width="1.8" stroke-linejoin="round"/>`
    : '';
  const scarf = stage >= 1
    ? `<g class="m-scarf" transform="translate(0 ${dy})">
      <path d="M68 82l3 12.5 7.5-2.2-4.2-11.8z" fill="${K.scarfLo}" stroke="${K.scarfLine}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M71.6 94.2l-.4 2.6M74.2 93.5l-.2 2.7M76.8 92.7l0 2.6" stroke="${K.scarfLine}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M37.5 75.5q22.5 9.5 45 0l1.6 6.6q-24 10.8-48.2 0z" fill="${K.scarf}" stroke="${K.scarfLine}" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M39.5 77.6q20.5 8.4 41 0" stroke="#8ee6da" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".7"/>
    </g>`
    : '';
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="${id}f" cx=".4" cy=".3" r=".78"><stop offset="0" stop-color="${K.furHi}"/><stop offset=".62" stop-color="${K.fur}"/><stop offset="1" stop-color="${K.furLo}"/></radialGradient>
    <radialGradient id="${id}s"><stop offset="0" stop-color="#3b2a1c" stop-opacity=".22"/><stop offset="1" stop-color="#3b2a1c" stop-opacity="0"/></radialGradient>
  </defs>
  <ellipse cx="60" cy="111" rx="34" ry="5" fill="url(#${id}s)"/>
  <g class="m-char">
    <g class="m-tail"><path d="M73 104c14 4 27-2 29.5-16.5c.7-4.2-4.6-5.8-6.3-1.6c-3 7.6-10.4 10-23.2 9z" fill="${K.furLo}" stroke="${K.line}" stroke-width="2" stroke-linejoin="round"/></g>
    ${backpack ? `<rect x="34" y="${bcy - 13}" width="52" height="27" rx="11" fill="${K.gold}" stroke="${K.goldLine}" stroke-width="1.8"/>` : ''}
    <ellipse cx="60" cy="${bcy}" rx="${B.rx}" ry="${B.ry}" fill="url(#${id}f)" stroke="${K.line}" stroke-width="2.2"/>
    <ellipse cx="60" cy="${bcy + 3}" rx="${(B.rx * 0.62).toFixed(1)}" ry="${(B.ry * 0.68).toFixed(1)}" fill="${K.cream}"/>
    <g class="m-feet">
      <ellipse cx="47.5" cy="107.5" rx="7.4" ry="5.6" fill="${K.fur}" stroke="${K.line}" stroke-width="2"/>
      <ellipse cx="72.5" cy="107.5" rx="7.4" ry="5.6" fill="${K.fur}" stroke="${K.line}" stroke-width="2"/>
      <ellipse cx="47.5" cy="108.6" rx="3.2" ry="2.5" fill="${K.pad}"/><ellipse cx="72.5" cy="108.6" rx="3.2" ry="2.5" fill="${K.pad}"/>
      <g fill="${K.pad}"><circle cx="44" cy="104.6" r="1.2"/><circle cx="47.5" cy="103.6" r="1.2"/><circle cx="51" cy="104.6" r="1.2"/><circle cx="69" cy="104.6" r="1.2"/><circle cx="72.5" cy="103.6" r="1.2"/><circle cx="76" cy="104.6" r="1.2"/></g>
    </g>
    <g transform="translate(0 ${dy})">
      <g class="m-head">
        ${tuft}
        <circle cx="${60 - hr * 0.8}" cy="${50 - hv * 0.6}" r="6.6" fill="${K.fur}" stroke="${K.line}" stroke-width="2"/>
        <circle cx="${60 + hr * 0.8}" cy="${50 - hv * 0.6}" r="6.6" fill="${K.fur}" stroke="${K.line}" stroke-width="2"/>
        <circle cx="${60 - hr * 0.8 + 0.6}" cy="${50 - hv * 0.6 + 0.6}" r="3.3" fill="${K.innerEar}"/>
        <circle cx="${60 + hr * 0.8 - 0.6}" cy="${50 - hv * 0.6 + 0.6}" r="3.3" fill="${K.innerEar}"/>
        <ellipse cx="60" cy="50" rx="${hr}" ry="${hv}" fill="url(#${id}f)" stroke="${K.line}" stroke-width="2.2"/>
        <ellipse cx="49" cy="${top + 10}" rx="12" ry="4.6" fill="#fff" opacity=".28" transform="rotate(-12 49 ${top + 10})"/>
        <ellipse cx="60" cy="61.5" rx="20.5" ry="13" fill="${K.cream}"/>
        <ellipse cx="35.5" cy="61.5" rx="5.6" ry="3.4" fill="${K.cheek}" opacity=".6"/>
        <ellipse cx="84.5" cy="61.5" rx="5.6" ry="3.4" fill="${K.cheek}" opacity=".6"/>
        ${eyes}${NOSE}${mouth}
        ${headGear(stage, top)}
      </g>
      ${EXTRA[mood] || ''}
    </g>
    ${scarf}
    ${backpack ? `<path d="M43.5 ${84 + dy}q-2.5 9 1 17M76.5 ${84 + dy}q2.5 9-1 17" stroke="${K.goldLine}" stroke-width="5.4" fill="none" stroke-linecap="round"/>
      <path d="M43.5 ${84 + dy}q-2.5 9 1 17M76.5 ${84 + dy}q2.5 9-1 17" stroke="${K.gold}" stroke-width="3.4" fill="none" stroke-linecap="round"/>` : ''}
    <g transform="translate(0 ${(dy * 0.8).toFixed(1)})">${ARMS[mood] || ARMS.wave}</g>
  </g>
</svg>`;
}
let uid = 0;

// ---------- 화면에 놓기 ----------
const PET_LINES = ['헤헤, 간지러워요!', '같이 공부해요! 🤟', '오늘도 최고예요!', '수어 하나 더 배워 볼까요?', '쓰담쓰담 좋아요~', '조개 하나 줄까요? 🐚'];

export function mascot(mood = 'wave', { size = 96, label = '', stage, pet = true } = {}) {
  const st = stage ?? currentStage();
  const inner = h('span.m-inner', { html: svg(mood, st) });
  const el = h('span.mascot', {
    class: `mood-${mood}`,
    style: { width: size + 'px', height: size + 'px' },
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
  }, inner);
  el.dataset.mood = mood;
  el.dataset.stage = st;
  if (pet) {
    el.classList.add('pettable');
    el.addEventListener('click', () => react(el, 'love'));
  }
  return el;
}

export function setMood(el, mood) {
  if (!el || el.dataset.mood === mood) return;
  el.classList.remove(`mood-${el.dataset.mood}`);
  el.classList.add(`mood-${mood}`);
  el.dataset.mood = mood;
  el.querySelector('.m-inner').innerHTML = svg(mood, +el.dataset.stage);
}

function setStage(el, stage) {
  el.dataset.stage = stage;
  el.querySelector('.m-inner').innerHTML = svg(el.dataset.mood, stage);
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const FX = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.2 0 3.6 1.3 5.3 3.3 1.7-2 3.1-3.3 5.3-3.3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" fill="#ff7b8e"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.3l7.1-.7z" fill="#f5c451"/></svg>',
  dot: (c) => `<svg viewBox="0 0 10 10"><rect width="10" height="6" rx="2" fill="${c}"/></svg>`,
  sweat: '<svg viewBox="0 0 24 24"><path d="M12 3q6 8.5 6 12a6 6 0 0 1-12 0q0-3.5 6-12z" fill="#7cc4ec"/></svg>',
};

function burst(el, kind) {
  if (reduced()) return;
  const size = el.offsetWidth || 96;
  const make = (html, { x = 0, y = 0, dx, dy, rot = 0, s = 0.22, delay = 0, dur = 900 }) => {
    const p = h('span.m-fx', { html });
    Object.assign(p.style, {
      width: size * s + 'px', height: size * s + 'px', left: 50 + x + '%', top: 40 + y + '%',
      animationDuration: dur + 'ms', animationDelay: delay + 'ms',
    });
    p.style.setProperty('--dx', dx * size + 'px');
    p.style.setProperty('--dy', dy * size + 'px');
    p.style.setProperty('--rot', rot + 'deg');
    el.append(p);
    setTimeout(() => p.remove(), dur + delay + 80);
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  if (kind === 'love') {
    for (let i = 0; i < 3; i++) make(FX.heart, { x: rnd(-18, 18), y: -10, dx: rnd(-0.15, 0.15), dy: rnd(-0.55, -0.4), rot: rnd(-20, 20), s: rnd(0.18, 0.26), delay: i * 140 });
  } else if (kind === 'jump') {
    for (let i = 0; i < 4; i++) make(FX.star, { dx: Math.cos(i * 1.57 + 0.6) * 0.55, dy: Math.sin(i * 1.57 + 0.6) * 0.5 - 0.15, rot: rnd(-90, 90), s: 0.18, delay: 120 });
  } else if (kind === 'shake') {
    make(FX.sweat, { x: 22, y: -18, dx: 0.08, dy: 0.12, s: 0.16, dur: 800 });
  } else if (kind === 'party' || kind === 'grow') {
    const colors = ['#17a596', '#f5c451', '#ff7b8e', '#7cc4ec', '#c98a52'];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r = rnd(0.55, 0.8);
      make(i % 3 === 0 ? FX.star : FX.dot(colors[i % colors.length]), {
        dx: Math.cos(a) * r, dy: Math.sin(a) * r - 0.2, rot: rnd(-200, 200), s: i % 3 === 0 ? 0.18 : 0.1, delay: (kind === 'grow' ? 500 : 200) + rnd(0, 120), dur: 1100,
      });
    }
  }
}

const REACT_MS = { love: 650, jump: 700, shake: 600, party: 1100, grow: 1300 };
const REACT_MOOD = { love: 'happy', jump: 'happy', party: 'cheer', grow: 'cheer' };

// 움직이며 반응하기
export function react(el, kind = 'love') {
  if (!el || !el.isConnected) return;
  const inner = el.querySelector('.m-inner');
  clearTimeout(el._reactTimer);
  const base = el._baseMood || el.dataset.mood;
  el._baseMood = base;
  if (REACT_MOOD[kind] && kind !== 'shake') setMood(el, REACT_MOOD[kind]);
  for (const k of Object.keys(REACT_MS)) inner.classList.remove('r-' + k);
  void inner.offsetWidth; // 애니메이션을 처음부터 다시
  inner.classList.add('r-' + kind);
  burst(el, kind);
  if (kind === 'love') {
    // "수달이 키우기" 카드에서는 쓰다듬을 때마다 한마디가 바뀐다
    const bubble = el.closest('.pet-card')?.querySelector('.bubble');
    if (bubble) bubble.textContent = PET_LINES[Math.floor(Math.random() * PET_LINES.length)];
  }
  const ms = REACT_MS[kind] || 700;
  el._reactTimer = setTimeout(() => {
    inner.classList.remove('r-' + kind);
    // 쓰다듬기·정답 반응이 끝나면 원래 기분으로 (완료 축하는 그대로 신난 채로)
    if (kind === 'love' || kind === 'jump') setMood(el, base);
    el._baseMood = null;
  }, kind === 'love' ? ms + 700 : ms);
}

// 다음 단계로 자라기: 반짝 → 새 모습 → 축하
export function growTo(el, stage) {
  if (!el) return;
  const inner = el.querySelector('.m-inner');
  inner.classList.remove('r-grow');
  void inner.offsetWidth;
  inner.classList.add('r-grow');
  setTimeout(() => { setStage(el, stage); setMood(el, 'cheer'); }, reduced() ? 0 : 520);
  burst(el, 'grow');
  setTimeout(() => inner.classList.remove('r-grow'), REACT_MS.grow);
}

// 결과 화면용: 이번에 XP 를 받아 다음 단계가 됐으면 자라는 장면, 아니면 신나게 축하
export function resultMascot(mood, xpBefore, { size = 140 } = {}) {
  const from = stageIndex(xpBefore);
  const to = currentStage();
  const el = mascot(mood, { size, stage: from });
  const grew = to > from ? STAGES[to] : null;
  setTimeout(() => (grew ? growTo(el, to) : react(el, 'party')), 350);
  const info = petInfo();
  const note = grew
    ? h('div.grow-note', h('strong', `🎉 수달이가 자랐어요! 이제 ${grew.name}이에요.`), h('span', grew.desc))
    : h('p.muted.small.pet-line', info.next ? `수달이: ${info.name} · ${info.next.name}까지 ${info.toNext} XP` : `수달이: ${info.name} · 최고 단계예요!`);
  return { el, grew, note };
}

// 마스코트가 말풍선으로 말하기
export function mascotSay(mood, text, { size = 84, cls = '', stage } = {}) {
  return h('div.mascot-say', { class: cls },
    mascot(mood, { size, stage }),
    h('p.bubble', text),
  );
}

// 아이콘 만들 때 쓰려고 SVG 글자 그대로
export function mascotSVG(mood = 'wave', stage = 1) {
  return svg(mood, stage);
}
