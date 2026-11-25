// 마스코트 "수달이": 청록 목도리를 한 수달 (수어 + 수달). 이 앱만의 캐릭터.
//
//   mascot(mood, { size, label })  → <span class="mascot mood-…"> 안에 SVG
//   mascotSay(mood, text, opts)    → 마스코트 + 말풍선
//
// 기분(mood): wave(손 흔들기) · cheer(만세) · happy(웃음) · sad(시무룩) · think(갸웃) · sleep(졸림)
import { h } from './ui.js';

export const MASCOT_NAME = '수달이';

const C = {
  fur: '#a8723f', furLight: '#d39a60', furDark: '#7a4f28', furDeep: '#6b4320', belly: '#f4e3c8', ink: '#2b1d12',
  nose: '#3a271a', cheek: '#f2a48c', scarf: '#0f766e', scarfDark: '#0a5f58', paw: '#8d5d32',
};

// 입체감: 왼쪽 위에서 빛이 온다고 보고, 둥근 면마다 밝은 곳→어두운 곳 그라데이션 + 반짝이 + 그림자.
// 그라데이션 id 는 마스코트마다 따로 (한 화면에 여러 마리가 있어도 서로 안 섞이게)
let uid = 0;
function defs(p) {
  const st = (o, c, a = 1) => `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`;
  const rad = (id, cx, cy, r, stops) => `<radialGradient id="${p}${id}" cx="${cx}" cy="${cy}" r="${r}">${stops}</radialGradient>`;
  return `<defs>
    ${rad('fur', '.38', '.28', '.8', st(0, C.furLight) + st(0.5, C.fur) + st(1, C.furDeep))}
    ${rad('belly', '.42', '.3', '.8', st(0, '#fffaf0') + st(0.55, C.belly) + st(1, '#d4b68c'))}
    ${rad('paw', '.35', '.3', '.8', st(0, '#b98450') + st(0.6, C.paw) + st(1, '#5a381a'))}
    ${rad('nose', '.35', '.3', '.75', st(0, '#7a5840') + st(0.6, C.nose) + st(1, '#1e130b'))}
    ${rad('eye', '.38', '.32', '.7', st(0, '#6b4a30') + st(0.7, '#241710') + st(1, '#120a05'))}
    ${rad('ear', '.5', '.6', '.6', st(0, '#4a2e16') + st(1, C.furDark))}
    ${rad('shadow', '.5', '.5', '.5', st(0, '#000', 0.3) + st(1, '#000', 0))}
    ${rad('ao', '.5', '.5', '.5', st(0, '#3b2210', 0.45) + st(1, '#3b2210', 0))}
    ${rad('gloss', '.5', '.5', '.5', st(0, '#fff', 0.6) + st(1, '#fff', 0))}
    ${rad('blush', '.5', '.5', '.5', st(0, '#f08a78', 0.85) + st(1, '#f08a78', 0))}
    <linearGradient id="${p}scarf" x1="0" y1="0" x2="0" y2="1">${st(0, '#22b3a3') + st(0.45, C.scarf) + st(1, '#084c46')}</linearGradient>
    <linearGradient id="${p}scarf2" x1="0" y1="0" x2="1" y2="1">${st(0, '#11887e') + st(1, '#063f3a')}</linearGradient>
    <linearGradient id="${p}tail" x1="0" y1="0" x2="1" y2="1">${st(0, '#a06a38') + st(1, '#553515')}</linearGradient>
  </defs>`;
}

// 팔: 어깨(sx,sy)에서 손(hx,hy)까지. 어두운 테두리 + 털색 + 빛 받는 줄로 둥근 원통처럼
function arm(cls, sx, sy, hx, hy) {
  return (p) => {
    const L = (t) => `${(sx + (hx - sx) * t).toFixed(1)} ${(sy + (hy - sy) * t).toFixed(1)}`;
    const d = `M${sx} ${sy}L${hx} ${hy}`;
    return `<g class="m-arm ${cls}" style="transform-origin:${sx}px ${sy}px">
    <path d="${d}" stroke="${C.furDeep}" stroke-width="12.5" stroke-linecap="round"/>
    <path d="${d}" stroke="${C.fur}" stroke-width="9" stroke-linecap="round" transform="translate(-1 -1)"/>
    <path d="M${L(0.3)}L${L(0.78)}" stroke="${C.furLight}" stroke-width="3" stroke-linecap="round" opacity=".75" transform="translate(-2.2 -2.2)"/>
    <circle cx="${hx}" cy="${hy}" r="7.5" fill="url(#${p}paw)"/>
    <ellipse cx="${hx - 2.6}" cy="${hy - 2.8}" rx="3.4" ry="2.4" fill="url(#${p}gloss)"/>
    <path d="M${hx - 3.5} ${hy - 5.5}v3M${hx} ${hy - 6.5}v3M${hx + 3.5} ${hy - 5.5}v3" stroke="${C.belly}" stroke-width="1.6" stroke-linecap="round" opacity=".8"/>
  </g>`;
  };
}

const ARMS = {
  wave: [arm('left', 38, 76, 28, 94), arm('right wave', 82, 74, 100, 50)],
  cheer: [arm('left up', 38, 74, 18, 50), arm('right up', 82, 74, 102, 50)],
  happy: [arm('left', 38, 76, 30, 95), arm('right', 82, 76, 90, 95)],
  sad: [arm('left', 40, 78, 44, 98), arm('right', 80, 78, 76, 98)],
  think: [arm('left', 38, 76, 30, 95), arm('right', 82, 76, 70, 62)],
  sleep: [arm('left', 40, 78, 46, 97), arm('right', 80, 78, 74, 97)],
};

// 동그란 눈: 그라데이션 눈동자 + 큰 반짝이 + 작은 반사광
const eye = (p, cx, cy, r) => `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * 1.12).toFixed(2)}" fill="url(#${p}eye)"/>
    <circle cx="${(cx + r * 0.32).toFixed(2)}" cy="${(cy - r * 0.4).toFixed(2)}" r="${(r * 0.4).toFixed(2)}" fill="#fff"/>
    <circle cx="${(cx - r * 0.35).toFixed(2)}" cy="${(cy + r * 0.45).toFixed(2)}" r="${(r * 0.18).toFixed(2)}" fill="#fff" opacity=".75"/>`;

const EYES = {
  open: (p) => `<g class="m-eyes">${eye(p, 48, 43, 4.6)}${eye(p, 72, 43, 4.6)}</g>`,
  smile: () => `<path d="M43.5 44.5q4.5-5.5 9 0M67.5 44.5q4.5-5.5 9 0" stroke="${C.ink}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
  sad: (p) => `<g>${eye(p, 48, 45, 4)}${eye(p, 72, 45, 4)}
    <path d="M42 40l9-3.5M78 40l-9-3.5" stroke="${C.furDark}" stroke-width="2.4" stroke-linecap="round"/></g>`,
  closed: () => `<path d="M43.5 44q4.5 3.5 9 0M67.5 44q4.5 3.5 9 0" stroke="${C.ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
};

const MOUTH = {
  smile: `<path d="M54.5 58.5q5.5 5 11 0" stroke="${C.ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  open: `<path d="M53 57.5q7 11 14 0z" fill="${C.ink}"/><path d="M56.5 61.8q3.5-2.4 7 0q-3.5 3.2-7 0z" fill="#e8737a"/><path d="M57.6 61.6q2.4-1.2 4.8 0" stroke="#f7a3a8" stroke-width="1" fill="none" stroke-linecap="round"/>`,
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

// 목도리 뜨개 무늬 (목도리 곡선을 따라)
const RIBS = (() => {
  let d = '';
  for (let x = 39; x <= 82; x += 6) {
    const t = (x - 33) / 54;
    d += `M${x} ${(68 + 24 * t * (1 - t) + 1.2).toFixed(1)}v5.2`;
  }
  return d;
})();

function svg(mood) {
  const p = `ms${++uid}-`;
  const u = (id) => `url(#${p}${id})`;
  const [eyes, mouth] = FACES[mood] || FACES.wave;
  const arms = (ARMS[mood] || ARMS.wave).map((f) => f(p)).join('');
  const extra = mood === 'sleep'
    ? `<g class="m-zzz" fill="${C.scarf}" font-weight="800" font-family="sans-serif"><text x="88" y="26" font-size="13">z</text><text x="98" y="16" font-size="9">z</text></g>`
    : mood === 'think'
      ? `<g class="m-q" fill="${C.scarf}" font-weight="800" font-family="sans-serif"><text x="90" y="24" font-size="18">?</text></g>`
      : mood === 'cheer'
        ? `<g class="m-spark" fill="#e9b949"><path d="M14 30l2.5 5.5 5.5 2.5-5.5 2.5-2.5 5.5-2.5-5.5-5.5-2.5 5.5-2.5z"/><path d="M106 22l2 4 4 2-4 2-2 4-2-4-4-2 4-2z"/></g>`
        : mood === 'sad'
          ? `<path class="m-tear" d="M77 51q2.2 3.6 0 5.2q-2.2-1.6 0-5.2z" fill="#6cb4e4"/><circle cx="76.4" cy="54.2" r=".7" fill="#fff" opacity=".8"/>`
          : '';
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  ${defs(p)}
  <ellipse cx="62" cy="114" rx="40" ry="6.5" fill="${u('shadow')}"/>
  <path d="M78 104q34 4 32-26q-1-7-7-4q1 18-27 18z" fill="${u('tail')}"/>
  <path d="M84 100q20 0 22-20" stroke="${C.furLight}" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".45"/>
  <ellipse cx="60" cy="88" rx="27" ry="26" fill="${u('fur')}"/>
  <ellipse cx="60" cy="93" rx="18" ry="16" fill="${u('belly')}"/>
  <ellipse cx="53" cy="90" rx="7" ry="5" fill="${u('gloss')}" opacity=".7"/>
  <ellipse cx="60" cy="80" rx="25" ry="6" fill="${u('ao')}"/>
  <ellipse cx="46" cy="111" rx="9" ry="5" fill="${u('paw')}"/><ellipse cx="74" cy="111" rx="9" ry="5" fill="${u('paw')}"/>
  <ellipse cx="43.5" cy="109.4" rx="3.6" ry="1.7" fill="${u('gloss')}"/><ellipse cx="71.5" cy="109.4" rx="3.6" ry="1.7" fill="${u('gloss')}"/>
  ${arms}
  <g class="m-head">
    <circle cx="33" cy="33" r="6.2" fill="${u('fur')}"/><circle cx="33.4" cy="33.6" r="3.1" fill="${u('ear')}"/>
    <circle cx="87" cy="33" r="6.2" fill="${u('fur')}"/><circle cx="86.6" cy="33.6" r="3.1" fill="${u('ear')}"/>
    <ellipse cx="60" cy="47" rx="31" ry="24" fill="${u('fur')}"/>
    <path d="M40 42q-2 20 20 22q22-2 20-22q-6 6-20 6t-20-6z" fill="${u('belly')}" opacity=".5"/>
    <ellipse cx="51" cy="30" rx="15" ry="6.5" fill="${u('gloss')}" opacity=".75" transform="rotate(-12 51 30)"/>
    <ellipse cx="60" cy="65" rx="15" ry="3.6" fill="${u('ao')}" opacity=".7"/>
    <ellipse cx="60" cy="56" rx="17" ry="11" fill="${u('belly')}"/>
    <ellipse cx="54" cy="53" rx="7" ry="3.4" fill="${u('gloss')}" opacity=".8"/>
    <ellipse cx="38" cy="54" rx="6.4" ry="4" fill="${u('blush')}"/><ellipse cx="82" cy="54" rx="6.4" ry="4" fill="${u('blush')}"/>
    ${eyes(p)}
    <ellipse cx="60" cy="53.2" rx="6" ry="2.6" fill="${u('ao')}" opacity=".6"/>
    <ellipse cx="60" cy="51.5" rx="6.2" ry="4.2" fill="${u('nose')}"/><ellipse cx="58" cy="49.9" rx="2.3" ry="1.2" fill="#fff" opacity=".55"/>
    <g fill="${C.furDark}" opacity=".5"><circle cx="51" cy="56" r=".9"/><circle cx="53" cy="59" r=".9"/><circle cx="69" cy="56" r=".9"/><circle cx="67" cy="59" r=".9"/></g>
    <path d="M45 56h-12M45 59l-11 3M75 56h12M75 59l11 3" stroke="${C.furDark}" stroke-width="1.2" stroke-linecap="round" opacity=".6"/>
    ${mouth}
  </g>
  <path d="M33 68q27 12 54 0l1 7q-28 12-56 0z" fill="${u('scarf')}"/>
  <path d="${RIBS}" stroke="#063f3a" stroke-width="1" stroke-linecap="round" opacity=".3"/>
  <path d="M34.5 68.8q25.5 11 51 0" stroke="#7fe0d3" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".55"/>
  <ellipse cx="80" cy="91" rx="7" ry="2.6" fill="${u('ao')}" opacity=".7"/>
  <path d="M74 74l6 16 8-3-5-15z" fill="${u('scarf2')}"/>
  <path d="M75.5 75.5l5 12.8" stroke="#5fd3c4" stroke-width="1" stroke-linecap="round" opacity=".45"/>
  <path d="M80.6 90.2l-.3 2.6M83.2 89.3l-.1 2.7M85.8 88.4l.1 2.6" stroke="${C.scarfDark}" stroke-width="1.4" stroke-linecap="round"/>
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
