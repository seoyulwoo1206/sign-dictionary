// 마스코트 "수달이": 청록 목도리를 한 수달 (수어 + 수달). 이 앱만의 캐릭터.
//
//   mascot(mood, { size, label })  → <span class="mascot mood-…"> 안에 SVG
//   mascotSay(mood, text, opts)    → 마스코트 + 말풍선
//
// 기분(mood): wave(손 흔들기) · cheer(만세) · happy(웃음) · sad(시무룩) · think(갸웃) · sleep(졸림)
import { h } from './ui.js';

export const MASCOT_NAME = '수달이';

const C = {
  fur: '#a8723f', furDark: '#7a4f28', belly: '#f4e3c8', ink: '#2b1d12',
  nose: '#3a271a', cheek: '#f2a48c', scarf: '#0f766e', scarfDark: '#0a5f58', paw: '#8d5d32',
};

// 팔: 어깨(sx,sy)에서 손(hx,hy)까지 굵은 선 + 둥근 손
function arm(cls, sx, sy, hx, hy) {
  return `<g class="m-arm ${cls}" style="transform-origin:${sx}px ${sy}px">
    <path d="M${sx} ${sy}L${hx} ${hy}" stroke="${C.fur}" stroke-width="12" stroke-linecap="round"/>
    <circle cx="${hx}" cy="${hy}" r="7.5" fill="${C.paw}"/>
    <path d="M${hx - 3.5} ${hy - 5.5}v3M${hx} ${hy - 6.5}v3M${hx + 3.5} ${hy - 5.5}v3" stroke="${C.belly}" stroke-width="1.6" stroke-linecap="round" opacity=".8"/>
  </g>`;
}

const ARMS = {
  wave: arm('left', 38, 76, 28, 94) + arm('right wave', 82, 74, 100, 50),
  cheer: arm('left up', 38, 74, 18, 50) + arm('right up', 82, 74, 102, 50),
  happy: arm('left', 38, 76, 30, 95) + arm('right', 82, 76, 90, 95),
  sad: arm('left', 40, 78, 44, 98) + arm('right', 80, 78, 76, 98),
  think: arm('left', 38, 76, 30, 95) + arm('right', 82, 76, 70, 62),
  sleep: arm('left', 40, 78, 46, 97) + arm('right', 80, 78, 74, 97),
};

const EYES = {
  open: `<g class="m-eyes"><circle cx="48" cy="43" r="4.2" fill="${C.ink}"/><circle cx="72" cy="43" r="4.2" fill="${C.ink}"/>
    <circle cx="49.5" cy="41.5" r="1.5" fill="#fff"/><circle cx="73.5" cy="41.5" r="1.5" fill="#fff"/></g>`,
  smile: `<path d="M43.5 44.5q4.5-5.5 9 0M67.5 44.5q4.5-5.5 9 0" stroke="${C.ink}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  sad: `<g><circle cx="48" cy="45" r="3.8" fill="${C.ink}"/><circle cx="72" cy="45" r="3.8" fill="${C.ink}"/>
    <path d="M42 40l9-3.5M78 40l-9-3.5" stroke="${C.furDark}" stroke-width="2.4" stroke-linecap="round"/></g>`,
  closed: `<path d="M43.5 44q4.5 3.5 9 0M67.5 44q4.5 3.5 9 0" stroke="${C.ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
};

const MOUTH = {
  smile: `<path d="M54.5 58.5q5.5 5 11 0" stroke="${C.ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  open: `<path d="M53 57.5q7 11 14 0z" fill="${C.ink}"/><path d="M56.5 61.8q3.5-2.4 7 0q-3.5 3.2-7 0z" fill="#e8737a"/>`,
  sad: `<path d="M55 62q5-4.5 10 0" stroke="${C.ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  flat: `<path d="M56 60.5h8" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/>`,
  o: `<ellipse cx="60" cy="60.5" rx="2.6" ry="3" fill="${C.ink}"/>`,
};

const FACES = {
  wave: [EYES.open, MOUTH.smile],
  cheer: [EYES.smile, MOUTH.open],
  happy: [EYES.smile, MOUTH.smile],
  sad: [EYES.sad, MOUTH.sad],
  think: [EYES.open, MOUTH.flat],
  sleep: [EYES.closed, MOUTH.o],
};

function svg(mood) {
  const [eyes, mouth] = FACES[mood] || FACES.wave;
  const extra = mood === 'sleep'
    ? `<g class="m-zzz" fill="${C.scarf}" font-weight="800" font-family="sans-serif"><text x="88" y="26" font-size="13">z</text><text x="98" y="16" font-size="9">z</text></g>`
    : mood === 'think'
      ? `<g class="m-q" fill="${C.scarf}" font-weight="800" font-family="sans-serif"><text x="90" y="24" font-size="18">?</text></g>`
      : mood === 'cheer'
        ? `<g class="m-spark" fill="#e9b949"><path d="M14 30l2.5 5.5 5.5 2.5-5.5 2.5-2.5 5.5-2.5-5.5-5.5-2.5 5.5-2.5z"/><path d="M106 22l2 4 4 2-4 2-2 4-2-4-4-2 4-2z"/></g>`
        : mood === 'sad'
          ? `<path class="m-tear" d="M77 51q2.2 3.6 0 5.2q-2.2-1.6 0-5.2z" fill="#6cb4e4"/>`
          : '';
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <path d="M78 104q34 4 32-26q-1-7-7-4q1 18-27 18z" fill="${C.furDark}"/>
  <ellipse cx="60" cy="88" rx="27" ry="26" fill="${C.fur}"/>
  <ellipse cx="60" cy="93" rx="18" ry="16" fill="${C.belly}"/>
  <ellipse cx="46" cy="111" rx="9" ry="5" fill="${C.paw}"/><ellipse cx="74" cy="111" rx="9" ry="5" fill="${C.paw}"/>
  ${ARMS[mood] || ARMS.wave}
  <g class="m-head">
    <circle cx="33" cy="33" r="6" fill="${C.fur}"/><circle cx="33" cy="33" r="3" fill="${C.furDark}"/>
    <circle cx="87" cy="33" r="6" fill="${C.fur}"/><circle cx="87" cy="33" r="3" fill="${C.furDark}"/>
    <ellipse cx="60" cy="47" rx="31" ry="24" fill="${C.fur}"/>
    <path d="M40 42q-2 20 20 22q22-2 20-22q-6 6-20 6t-20-6z" fill="${C.belly}" opacity=".55"/>
    <ellipse cx="60" cy="56" rx="17" ry="11" fill="${C.belly}"/>
    <ellipse cx="38" cy="54" rx="4.6" ry="3" fill="${C.cheek}" opacity=".75"/><ellipse cx="82" cy="54" rx="4.6" ry="3" fill="${C.cheek}" opacity=".75"/>
    ${eyes}
    <ellipse cx="60" cy="51.5" rx="6.2" ry="4.2" fill="${C.nose}"/><ellipse cx="58" cy="50.2" rx="2" ry="1.1" fill="#fff" opacity=".35"/>
    <g fill="${C.furDark}" opacity=".5"><circle cx="51" cy="56" r=".9"/><circle cx="53" cy="59" r=".9"/><circle cx="69" cy="56" r=".9"/><circle cx="67" cy="59" r=".9"/></g>
    <path d="M45 56h-12M45 59l-11 3M75 56h12M75 59l11 3" stroke="${C.furDark}" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>
    ${mouth}
  </g>
  <path d="M33 68q27 12 54 0l1 7q-28 12-56 0z" fill="${C.scarf}"/>
  <path d="M74 74l6 16 8-3-5-15z" fill="${C.scarfDark}"/>
  ${extra}
</svg>`;
}

export function mascot(mood = 'wave', { size = 96, label = '' } = {}) {
  return h('span.mascot', {
    class: `mood-${mood}`,
    style: { width: size + 'px', height: size + 'px' },
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
    html: svg(mood),
  });
}

// 마스코트가 말풍선으로 말하기
export function mascotSay(mood, text, { size = 84, cls = '' } = {}) {
  return h('div.mascot-say', { class: cls },
    mascot(mood, { size }),
    h('p.bubble', text),
  );
}

// 알림 아이콘 같은 데 쓰려고 SVG 글자 그대로
export function mascotSVG(mood = 'wave') {
  return svg(mood);
}
