// 한국수어 동작 저작 어휘
// 국립국어원 한국수어사전의 "수형 설명" 문장을 거의 낱말 그대로 옮겨 적을 수 있게 만든 이름들이다.
// 자세한 설명과 예시는 tools/ksl/README.md 를 본다.
//
// 좌표: 어깨 너비 = 1, x+ = 수어하는 사람의 왼쪽(보는 사람의 오른쪽), y+ = 위, z+ = 밖(보는 사람 쪽)
// 손가락 번호(사전 표기): 1지 = 검지, 2지 = 중지, 3지 = 약지, 4지 = 새끼(소지), 5지 = 엄지

import {
  DEG, add, sub, mul, dot, cross, len, norm, mix,
  buildHand, solveShape, SHAPE_DEFS, FIST_F, HAND_MARGIN, bodyDist, NEUTRAL, estimateElbow,
} from './engine.mjs';

// ====================================================================
// 1. 방향
// ====================================================================
// '중앙' = 몸 가운데 쪽(오른손이면 왼쪽), '바깥' = 그 반대. 두 손 대칭 동작에 쓴다.
const 방향표 = {
  위: [0, 1, 0], 아래: [0, -1, 0],
  밖: [0, 0, 1], 앞: [0, 0, 1],          // 상대(보는 사람) 쪽
  안: [0, 0, -1], 몸쪽: [0, 0, -1], 뒤: [0, 0, -1],
  왼: [1, 0, 0], 왼쪽: [1, 0, 0],        // 수어하는 사람의 왼쪽
  오른: [-1, 0, 0], 오른쪽: [-1, 0, 0],
};
// '밖', '밖+위', '밖+0.5위', [x, y, z] → 단위 벡터
export function 방향(spec, side = 'R') {
  if (Array.isArray(spec)) return norm(spec);
  let v = [0, 0, 0];
  for (const tok of String(spec).split('+')) {
    const m = /^\s*(-?[\d.]+)?\s*(\S+)\s*$/.exec(tok);
    if (!m) throw new Error(`방향을 알 수 없음: ${spec}`);
    const w = m[1] ? Number(m[1]) : 1;
    let d;
    if (m[2] === '중앙') d = side === 'R' ? [1, 0, 0] : [-1, 0, 0];
    else if (m[2] === '바깥') d = side === 'R' ? [-1, 0, 0] : [1, 0, 0];
    else d = 방향표[m[2]];
    if (!d) throw new Error(`방향을 알 수 없음: ${spec}`);
    v = add(v, mul(d, w));
  }
  return norm(v);
}
// 옮김: { 위: 0.1, 밖: 0.2 } 또는 [x, y, z] → 벡터 (어깨 너비 단위)
function 옮김벡터(o, side) {
  if (!o) return [0, 0, 0];
  if (Array.isArray(o)) return o;
  let v = [0, 0, 0];
  for (const [k, w] of Object.entries(o)) v = add(v, mul(방향(k, side), w));
  return v;
}

// ====================================================================
// 2. 손 모양
// ====================================================================
const 폄 = [[3, 4], [2, 3], [3, 4], [4, 5]];
const 네손가락 = (a, b, step = 2) => [0, 1, 2, 3].map((i) => [a + i * step, b]);
// 이름 붙은 손 모양
const 이름모양 = {
  쉬는손: SHAPE_DEFS.relaxed,
  편손: { th: [8, 18, 4, 6], fg: 폄, sp: 0 },                 // 손가락을 붙여 편 손 ("손을 펴서")
  편손벌림: SHAPE_DEFS.open,                                  // 다섯 손가락을 벌려 편 손 ("손가락을 활짝 펴서")
  주먹: SHAPE_DEFS.fist,
  가볍게쥔주먹: { th: [45, 25, 30, 45], fg: [[68, 82], [70, 84], [70, 82], [68, 80]], sp: 0, wrap: [0, 1] },
  약간구부린손: { th: [25, 35, 8, 12], fg: 네손가락(16, 23), sp: 0.15 },   // "손을 약간 구부려"
  반구부린손: { th: [35, 40, 12, 20], fg: 네손가락(40, 52), sp: 0.3 },     // "반쯤 구부린 손"
  구부린손: SHAPE_DEFS.claw,                                  // "손가락을 펴서 구부려" (갈퀴 모양)
  오므린손: SHAPE_DEFS.bunch,                                 // 다섯 손끝을 한데 모은 손
  둥근손: { th: [42, 36, 10, 20], fg: 네손가락(38, 44), sp: 0.1 },         // C 모양
  둥글게쥔손: { th: [46, 30, 12, 26], fg: 네손가락(55, 61), sp: 0 },       // 컵을 쥔 듯 둥글게 쥔 손
  꺾은손: { th: [8, 18, 4, 6], fg: 네손가락(80, 5, 0), sp: 0 },            // 손가락 뿌리만 꺾은 손 (ㄱ자)
  동그라미: SHAPE_DEFS.ok,                                    // 편 손의 1·5지 끝을 맞대 만든 동그라미 (지문자 ㅇ)
};
// 손가락 한 개의 굽힘 [뿌리(MCP), 가운데 마디(PIP)]
const 굽힘 = { 세움: [3, 4], 약간구부림: [15, 25], 둥글게: [30, 38], 구부림: [25, 65], 반구부림: [45, 55], 꺾음: [80, 6] };
// 엄지: [맞섬, 벌림, MCP, IP]
// 세움 = 엄지를 손끝 방향으로 곧게 세움(엄지 척), 둥글게 = 작은 컵을 쥔 듯 둥글게
const 엄지굽힘 = { 폄: [5, 62, 0, 0], 세움: [3, 22, 0, 0], 약간구부림: [22, 48, 8, 12], 둥글게: [40, 36, 10, 18], 구부림: [38, 38, 10, 18], 반구부림: [40, 34, 15, 25], 꺾음: [8, 18, 4, 6] };
const 수식어 = new Set(['벌림', '약간벌림', '붙임', '맞댐', ...Object.keys(굽힘)]);

// 지문자 손 모양 ("'ㅅ' 손 모양" → '지문자ㅅ'). 손의 방향은 포함하지 않는다.
export const 지문자모양 = {
  ㄱ: '1·5지', ㄴ: '1·5지', ㄷ: '1·2지 벌림', ㄹ: '1·2·3지 벌림', ㅁ: '1·2지 구부림', ㅂ: '1·2·3·4지 붙임',
  ㅅ: '1·2지 벌림', ㅇ: '동그라미', ㅈ: '1·2·5지 벌림', ㅊ: '1·2·3·5지 벌림', ㅋ: '2·5지 1지 반구부림',
  ㅌ: '1·2·3지 벌림', ㅍ: '1·2·3·4·5지 반구부림', ㅎ: '5지',
  ㅏ: '1지', ㅑ: '1·2지 벌림', ㅓ: '1지', ㅕ: '1·2지 벌림', ㅗ: '1지', ㅛ: '1·2지 벌림', ㅜ: '1지', ㅠ: '1·2지 약간벌림',
  ㅡ: '1지', ㅣ: '4지', ㅐ: '1·4지', ㅒ: '1·2·4지 벌림', ㅔ: '1·4지', ㅖ: '1·2·4지 벌림', ㅚ: '1·4지', ㅟ: '1·4지', ㅢ: '1·4지',
};

// "1·5지", "1·2지 벌림", "1·5지 구부림", "1·5지 맞댐", "2·5지 1지 반구부림" 같은 표기를 손 모양 정의로 바꾼다.
//   숫자 묶음 = 펴는 손가락(적지 않은 손가락은 주먹처럼 접는다), 뒤에 붙는 수식어는 바로 앞 묶음에 적용
//   벌림/약간벌림/붙임 = 편 손가락 사이, 맞댐 = 그 묶음의 손가락 끝과 엄지 끝을 맞댄다
function 표기풀이(name) {
  const toks = name.trim().split(/\s+/);
  const fg = FIST_F.map((v) => [...v]);
  let thumb = null; // 엄지: null = 접음
  let sp = 0.25;
  let tips = null;
  let group = null;
  for (const tok of toks) {
    const m = /^([1-5](?:[·,.][1-5])*)지$/.exec(tok);
    if (m) {
      group = m[1].split(/[·,.]/).map(Number);
      for (const g of group) { if (g === 5) thumb = 엄지굽힘.폄; else fg[g - 1] = [...폄[g - 1]]; }
      continue;
    }
    if (!수식어.has(tok) || !group) throw new Error(`손 모양을 알 수 없음: "${name}" (${tok})`);
    if (tok === '벌림') sp = 1;
    else if (tok === '약간벌림') sp = 0.5;
    else if (tok === '붙임') sp = 0;
    else if (tok === '맞댐') {
      tips = group.filter((g) => g !== 5).map((g) => g - 1);
      const many = tips.length > 1;
      for (const fi of tips) fg[fi] = many ? [72, 45] : [52, 72];
      thumb = many ? [50, 25, 10, 20] : [45, 30, 15, 30];
      if (many) sp = -0.7;
    } else {
      for (const g of group) { if (g === 5) thumb = 엄지굽힘[tok]; else fg[g - 1] = [...굽힘[tok]]; }
    }
  }
  if (!group) throw new Error(`손 모양을 알 수 없음: "${name}"`);
  const def = { fg, sp };
  if (tips) { def.th = thumb; def.tips = tips; return def; }
  if (thumb) { def.th = thumb; return def; }
  // 엄지를 접는다: 접힌 손가락 위에 얹거나(주먹), 접힌 손가락이 없으면 손바닥 안으로 넣는다
  const folded = [0, 1, 2, 3].filter((i) => fg[i][0] > 60 && fg[i][1] > 80);
  if (!folded.length) { def.th = [55, -5, 30, 45]; return def; }
  def.th = [48, 18, 30, 45];
  def.wrap = folded[0] === 0 && folded.includes(1) ? [0, 1] : [folded[0]];
  return def;
}

const 모양캐시 = new Map();
// 손 모양 이름 → 관절 각도 13개
export function 손모양(name) {
  if (Array.isArray(name)) return name;
  if (모양캐시.has(name)) return 모양캐시.get(name);
  let def;
  if (이름모양[name]) def = 이름모양[name];
  else if (name.startsWith('지문자')) {
    const j = 지문자모양[name.slice(3)];
    if (!j) throw new Error(`지문자 손 모양이 없음: ${name}`);
    return 손모양(j);
  } else def = 표기풀이(name);
  const h = solveShape(def);
  모양캐시.set(name, h);
  return h;
}
export const 손모양이름 = Object.keys(이름모양);

// ====================================================================
// 3. 위치
// ====================================================================
// 몸 표면 위의 점: 어림한 점에서 가장 가까운 표면으로 내려 붙이고, 바깥 방향(법선)을 함께 돌려준다.
function 표면(guess) {
  let p = guess;
  for (let i = 0; i < 12; i++) { const { d, g } = bodyDist(p); p = sub(p, mul(g, d)); }
  return { p, n: bodyDist(p).g, r: 0, body: true };
}
// 얼굴·몸의 위치. x는 "손과 같은 쪽"이 +1 이 되도록 sgn(오른쪽 = -1)을 곱해 쓴다.
// 좌우가 있는 이름은 앞에 '왼'/'오른'을 붙여 쪽을 정할 수 있고, 안 붙이면 그 손과 같은 쪽이다.
const 몸위치 = {
  // --- 얼굴 (닿는 곳) ---
  정수리: () => [0, 1.05, -0.08],
  이마: () => [0, 0.8, 0.3],
  미간: () => [0, 0.73, 0.3],
  눈: (s) => [s * 0.086, 0.7, 0.3],
  눈밑: (s) => [s * 0.09, 0.63, 0.3],
  눈옆: (s) => [s * 0.3, 0.7, 0.14],
  관자놀이: (s) => [s * 0.33, 0.75, 0.04],
  코: () => [0, 0.62, 0.3],
  코옆: (s) => [s * 0.07, 0.61, 0.3],
  인중: () => [0, 0.56, 0.3],
  입: () => [0, 0.5, 0.3],
  입옆: (s) => [s * 0.1, 0.5, 0.3],
  아랫입술: () => [0, 0.47, 0.3],
  턱: () => [0, 0.37, 0.3],
  턱밑: () => [0, 0.2, 0.1],
  볼: (s) => [s * 0.24, 0.52, 0.2],
  귀: (s) => [s * 0.35, 0.66, -0.06],
  머리옆: (s) => [s * 0.35, 0.82, -0.06],
  // --- 목·몸통 (닿는 곳) ---
  목: () => [0, 0.22, 0.3],
  목옆: (s) => [s * 0.25, 0.24, 0.02],
  어깨: (s) => [s * 0.5, 0.3, 0.02],          // 어깨 위
  어깨앞: (s) => [s * 0.48, -0.02, 0.4],
  가슴: () => [0, -0.3, 0.6],                 // 가슴 중앙
  옆가슴: (s) => [s * 0.22, -0.3, 0.6],       // 손과 같은 쪽 가슴 ('왼가슴'·'오른가슴'으로 쪽 지정)
  명치: () => [0, -0.55, 0.6],
  배: () => [0, -0.85, 0.6],
  옆구리: (s) => [s * 0.7, -0.8, 0],
};
몸위치.왼가슴 = () => 몸위치.옆가슴(1);
몸위치.오른가슴 = () => 몸위치.옆가슴(-1);
// 몸 앞 공간 (닿지 않는 곳). 손바닥 중심(또는 '닿음'으로 고른 부위)이 이 점에 온다.
const 공간위치 = {
  몸앞: () => [0, -0.4, 0.42],                // 가슴 앞 중립 공간 (가운데)
  가슴앞: () => [0, -0.3, 0.42],
  옆몸앞: (s) => [s * 0.28, -0.4, 0.42],      // 손과 같은 쪽 가슴 앞
  배앞: () => [0, -0.75, 0.4],
  옆배앞: (s) => [s * 0.28, -0.75, 0.4],
  목앞: () => [0, 0.15, 0.42],
  어깨높이: (s) => [s * 0.36, -0.05, 0.45],   // 손과 같은 쪽 어깨 앞 (지문자·숫자를 보이는 자리)
  얼굴앞: () => [0, 0.55, 0.48],
  옆얼굴앞: (s) => [s * 0.3, 0.55, 0.4],
  입앞: () => [0, 0.5, 0.4],
  눈앞: (s) => [s * 0.086, 0.7, 0.42],
  이마앞: () => [0, 0.8, 0.42],
  귀옆: (s) => [s * 0.48, 0.62, 0.02],        // 귀 옆 공간
  머리위: () => [0, 1.2, 0.05],
  어깨위: (s) => [s * 0.48, 0.42, 0.02],
  어깨너머: (s) => [s * 0.5, 0.5, -0.3],      // 어깨 뒤쪽 (과거를 가리킬 때)
};
export const 몸위치이름 = Object.keys(몸위치);
export const 공간위치이름 = Object.keys(공간위치);

// ====================================================================
// 4. 손의 부위 (닿는 부분)
// ====================================================================
const 살 = { 끝: 0.012, 바닥: 0.018, 옆: 0.018, 손바닥: 0.03, 손날: 0.022, 손목: 0.035, 팔: 0.045 };
const 지번호 = { 1: 5, 2: 9, 3: 13, 4: 17 }; // 사전 번호 → 손 21점에서 그 손가락 뿌리 번호
// pts: 손 21점(세계 좌표), B: { n, f, s, h, side } → { o: 점, r: 살 두께, nrm: 그 부위가 바라보는 방향 }
function 부위(pts, B, name) {
  const { n, f, s } = B;
  const c = add(pts[0], mul(f, 0.13)); // 손바닥 중심
  const m = /^([1-5])지(끝|바닥|옆|등|뿌리)?$/.exec(name);
  if (m) {
    const g = Number(m[1]);
    const base = g === 5 ? 1 : 지번호[g];
    const tip = pts[base + 3], dip = pts[base + 2], pip = pts[base + 1];
    const dir = norm(sub(tip, dip));
    const kind = m[2] || '끝';
    if (kind === '끝') return { o: tip, r: 살.끝, nrm: dir };
    if (kind === '바닥') return { o: mix(dip, tip, 0.6), r: 살.바닥, nrm: g === 5 ? mul(s, -1) : norm(sub(n, mul(dir, dot(n, dir)))) };
    if (kind === '등') return { o: mix(pip, tip, 0.5), r: 살.바닥, nrm: mul(n, -1) };
    if (kind === '뿌리') return { o: pts[base], r: 살.바닥, nrm: mul(n, -1) };
    // 옆: 검지·엄지는 엄지 쪽, 나머지는 새끼 쪽 옆면
    return { o: mix(pip, tip, 0.5), r: 살.옆, nrm: g === 1 || g === 5 ? s : mul(s, -1) };
  }
  const pm = /^팔([\d.]+)?$/.exec(name);
  if (pm || name === '팔꿈치') {
    // 아래팔: 0 = 손목 쪽, 1 = 팔꿈치 쪽 (기본 0.5). 팔꿈치 자리는 어림값이다.
    const el = estimateElbow(B.side, pts[0], f);
    const t = name === '팔꿈치' ? 1 : pm[1] ? Number(pm[1]) : 0.5;
    return { o: mix(pts[0], el, t), r: 살.팔, nrm: [0, 1, 0] };
  }
  switch (name) {
    case '중심': return { o: c, r: 0, nrm: null };
    case '손바닥': return { o: c, r: 살.손바닥, nrm: n };
    case '손등': return { o: c, r: 살.손바닥, nrm: mul(n, -1) };
    case '손날': return { o: add(c, mul(s, -0.08)), r: 살.손날, nrm: mul(s, -1) };       // 새끼 쪽 옆면 ("4지 옆면")
    case '엄지쪽': return { o: add(c, add(mul(s, 0.085), mul(f, 0.05))), r: 살.손날, nrm: s }; // 검지·엄지 쪽 옆면 ("1·5지 옆면")
    case '손목': return { o: pts[0], r: 살.손목, nrm: mul(n, -1) };                      // 손목 등 쪽
    case '손목안': return { o: pts[0], r: 살.손목, nrm: n };
    case '손바닥뿌리': return { o: add(pts[0], mul(f, 0.04)), r: 살.손바닥, nrm: n };    // 손바닥 아래쪽(손목 가까이)
    case '주먹앞': return { o: mix(pts[6], pts[14], 0.5), r: 살.바닥, nrm: f };           // 주먹의 정면(첫 마디 등)
    case '손가락바닥': return { o: mul(add(add(pts[6], pts[10]), add(pts[14], pts[18])), 0.25), r: 살.바닥, nrm: n };
    case '손가락등': return { o: mul(add(add(pts[6], pts[10]), add(pts[14], pts[18])), 0.25), r: 살.바닥, nrm: mul(n, -1) };
    case '손끝': {
      // 편 손가락들의 끝(없으면 네 손가락 모두)의 가운데
      let ids = [0, 1, 2, 3].filter((i) => B.h[4 + i * 2] + B.h[5 + i * 2] < 1.4);
      if (!ids.length) ids = [0, 1, 2, 3];
      let o = [0, 0, 0];
      for (const i of ids) o = add(o, pts[8 + i * 4]);
      o = mul(o, 1 / ids.length);
      return { o, r: 살.끝, nrm: norm(sub(o, c)) };
    }
  }
  throw new Error(`손의 부위를 알 수 없음: ${name}`);
}
export const 부위이름 = ['중심', '손바닥', '손등', '손날', '엄지쪽', '손끝', '손가락바닥', '손가락등', '손목', '손목안', '손바닥뿌리', '주먹앞',
  'N지끝', 'N지바닥', 'N지옆', 'N지등', 'N지뿌리', '팔', '팔0.3', '팔꿈치'];

// ====================================================================
// 5. 손 한 개의 자세 풀기
// ====================================================================
const 손이름 = { 오른: 'R', 왼: 'L' };
const 손목한계 = 80; // 이보다 더 꺾이는 자세는 경고한다 (사람 손목은 70~80°쯤이 한계)
const 기본자세 = { 모양: '편손', 바닥: '중앙', 끝: '밖', 위치: '옆몸앞' };
const 좌우바꿈 = (v) => (typeof v === 'string' ? v.replace(/왼|오른/g, (m) => (m === '왼' ? '오른' : '왼')) : v);
// 오른손 기준으로 적은 자세를 왼손용으로 뒤집는다 (두 손 대칭 동작)
function 뒤집기(spec) {
  if (typeof spec !== 'object' || !spec) return spec;
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === '옮김' && v && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([d, w]) => [좌우바꿈(d), w]));
    else if (k === '옮김' && Array.isArray(v)) out[k] = [-v[0], v[1], v[2]];
    else if (['바닥', '등', '끝', '쪽', '위치'].includes(k)) out[k] = Array.isArray(v) ? [-v[0], v[1], v[2]] : 좌우바꿈(v);
    else out[k] = v;
  }
  return out;
}

// 위치 이름 → { p, n(없으면 공간), r, body }
function 위치찾기(name, side, states, ctx) {
  if (Array.isArray(name)) return { p: name, n: null, r: 0 };
  const sgnOf = (pre) => (pre === '왼' ? 1 : pre === '오른' ? -1 : side === 'R' ? -1 : 1);
  if (몸위치[name]) return 표면(몸위치[name](sgnOf('')));
  if (공간위치[name]) return { p: 공간위치[name](sgnOf('')), n: null, r: 0 };
  const m = /^(왼|오른)(.+)$/.exec(name);
  if (m) {
    const rest = m[2];
    if (몸위치[rest]) return 표면(몸위치[rest](sgnOf(m[1])));
    if (공간위치[rest]) return { p: 공간위치[rest](sgnOf(m[1])), n: null, r: 0 };
    // 반대쪽 손(팔)의 부위: '왼손등', '왼손바닥', '왼1지끝', '왼팔', '왼손목' …
    const oside = 손이름[m[1]];
    const o = states[oside];
    if (!o || oside === side) throw new Error(`${ctx}: 위치 "${name}" — 기준이 되는 ${m[1]}손 자세가 먼저 있어야 함`);
    const part = 부위(o.pts, o, rest.replace(/^손(?=\d지)/, ''));
    return { p: part.o, n: part.nrm, r: part.r, body: false, hand: true };
  }
  throw new Error(`${ctx}: 위치를 알 수 없음 "${name}"`);
}

// 자세 한 개(모든 항목이 채워진 spec) → 엔진이 쓰는 손 상태
function 손풀기(side, spec, states, ctx) {
  const h = 손모양(spec.모양);
  let n = spec.등 != null ? mul(방향(spec.등, side), -1) : 방향(spec.바닥, side);
  let f = 방향(spec.끝, side);
  f = sub(f, mul(n, dot(f, n)));
  if (len(f) < 0.05) throw new Error(`${ctx}: 손바닥 방향과 손끝 방향이 같은 축임 (바닥 ${spec.바닥 ?? spec.등}, 끝 ${spec.끝})`);
  f = norm(f);
  const thumbSide = (ff, nn) => (side === 'R' ? cross(ff, nn) : mul(cross(ff, nn), -1));
  const f0 = f;
  let s = thumbSide(f, n);
  const rot = (a, b, deg) => { const c = Math.cos(deg * DEG), sn = Math.sin(deg * DEG); return [add(mul(a, c), mul(b, sn)), sub(mul(b, c), mul(a, sn))]; };
  if (spec.기울임) [f, s] = rot(f, s, spec.기울임);   // + = 엄지 쪽으로 기울임
  if (spec.꺾음) [f, n] = rot(f, n, spec.꺾음);       // + = 손바닥 쪽으로 꺾음
  if (spec.비틂) [n, s] = rot(n, s, spec.비틂);       // + = 손바닥이 엄지 쪽으로 돌아감(바깥으로 비틂)
  const pts0 = buildHand(side, [0, 0, 0], n, f, h);
  const B = { n, f, s, h, side };
  const T = 위치찾기(spec.위치, side, states, ctx);
  const partName = spec.닿음 ?? (T.n ? '손끝' : '중심');
  const part = 부위(pts0, B, partName);
  const N = spec.쪽 != null ? 방향(spec.쪽, side) : T.n;
  const gap = spec.띄움 ?? 0;
  let p;
  if (N) {
    p = sub(add(T.p, mul(N, T.r + part.r + gap)), part.o);
    if (part.nrm && gap < 0.1 && dot(part.nrm, N) > 0.35) console.warn(`  [주의] ${ctx}: ${side === 'R' ? '오른' : '왼'}손의 '${partName}'이(가) '${spec.위치}' 쪽을 향하지 않음 (손 방향을 확인)`);
  } else {
    p = sub(T.p, part.o);
    // 공간에서 손목을 꺾거나 기울이면 손목이 제자리에 있고 손이 돈다
    if (partName === '중심') p = add(p, mul(sub(f, f0), 0.13));
  }
  p = add(p, 옮김벡터(spec.옮김, side));
  // 손목이 사람이 꺾을 수 있는 범위를 넘으면 엔진이 손을 돌려 버려 적은 방향과 달라진다 → 얼마나 꺾이는지 적어 둔다
  const wrist0 = add(pts0[0], p);
  const bend = Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(wrist0, estimateElbow(side, wrist0, f))), f)))) / DEG;
  const touching = T.body && gap < 0.03;
  const pv = partName === '중심' ? [0, 0, 0] : [dot(part.o, f), dot(part.o, s), dot(part.o, n)];
  return {
    eng: { p, n, f, s: h, name: spec.모양, m: touching ? 0.006 : HAND_MARGIN, pv },
    state: { ...B, pts: pts0.map((q) => add(q, p)) },
    bend,
  };
}

// ====================================================================
// 6. 표정·머리
// ====================================================================
// 표정은 한 번 적으면 다음에 바꿀 때까지 이어지고, 머리 움직임은 적은 키에서만 적용된다.
export const 표정표 = {
  보통: { brow: 0, smile: 0, mouthOpen: 0 },
  밝음: { brow: 0.005, smile: 0.015, mouthOpen: 0 },
  기쁨: { brow: 0.008, smile: 0.02, mouthOpen: 0.008 },
  찡그림: { brow: -0.02, smile: -0.01, mouthOpen: 0 },
  슬픔: { brow: 0.018, smile: -0.012, mouthOpen: 0 },
  미안: { brow: 0.022, smile: -0.004, mouthOpen: 0 },
  물음: { brow: 0.035, smile: 0, mouthOpen: 0 },
  놀람: { brow: 0.04, smile: 0, mouthOpen: 0.02 },
  입벌림: { mouthOpen: 0.016 },
  입다묾: { mouthOpen: 0 },
};
function 표정풀기(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') { if (!표정표[v]) throw new Error(`표정을 알 수 없음: ${v}`); return 표정표[v]; }
  const out = {};
  if (v.눈썹 != null) out.brow = v.눈썹;
  if (v.웃음 != null) out.smile = v.웃음;
  if (v.입 != null) out.mouthOpen = v.입;
  return out;
}
// 머리: { 끄덕: 도(+ 숙임), 젓기: 도(+ 수어자의 왼쪽으로 돌림), 갸웃: 도(+ 수어자의 왼쪽으로 기울임) }
function 머리풀기(v) {
  if (!v) return undefined;
  return { nod: (v.끄덕 || 0) * DEG, shake: (v.젓기 || 0) * DEG, tilt: -(v.갸웃 || 0) * DEG };
}

// ====================================================================
// 7. 동작(키 목록) 풀기
// ====================================================================
// 키 한 개: { 오른?, 왼?, 양손?, 시간?, 멈춤?, 지나감?, 표정?, 머리? }
//   오른/왼: 자세 { 모양, 바닥(또는 등), 끝, 위치, 닿음, 띄움, 옮김, 쪽, 기울임, 꺾음, 비틂 } 또는 '내림'(쉬는 자세로)
//   양손: 오른손 기준으로 적으면 왼손은 좌우를 뒤집어 똑같이 한다
//   적지 않은 항목은 그 손의 앞 키 값을 그대로 쓴다.
//     단, 위치를 새로 적으면 닿음·띄움·옮김·쪽은 처음 값으로, 바닥/등/끝을 새로 적으면 기울임·꺾음·비틂은 0으로 돌아간다.
export function 동작풀기(keys, word = '') {
  const specs = { R: null, L: null };
  const states = { R: null, L: null };
  const out = [];
  const worst = { R: [0, 0], L: [0, 0] }; // 손목 꺾임이 가장 큰 키
  const note = (side, r, ki) => { if (r.bend > worst[side][0]) worst[side] = [r.bend, ki + 1]; };
  keys.forEach((k, ki) => {
    const ctx = `${word} 키${ki + 1}`;
    const unknown = Object.keys(k).filter((x) => !['오른', '왼', '양손', '시간', '멈춤', '지나감', '표정', '머리'].includes(x));
    if (unknown.length) throw new Error(`${ctx}: 모르는 항목 ${unknown.join(', ')}`);
    const given = { R: k.오른, L: k.왼 };
    if (k.양손) {
      given.R = typeof k.양손 === 'string' ? k.양손 : { ...k.양손, ...(typeof k.오른 === 'object' ? k.오른 : {}) };
      given.L = typeof k.양손 === 'string' ? k.양손 : { ...뒤집기(k.양손), ...(typeof k.왼 === 'object' ? k.왼 : {}) };
    }
    const e = { d: k.시간 ?? 8, hold: k.멈춤 ?? 0, via: !!k.지나감 };
    const face = 표정풀기(k.표정);
    if (face) e.face = face;
    const head = 머리풀기(k.머리);
    if (head) e.head = head;
    // 반대쪽 손을 기준으로 삼는 손은 나중에 푼다
    const refsOther = (side) => {
      const g = given[side];
      const loc = g && typeof g === 'object' ? g.위치 ?? specs[side]?.위치 : specs[side]?.위치;
      return typeof loc === 'string' && /^(왼|오른)/.test(loc) && !몸위치[loc] && !몸위치[loc.replace(/^(왼|오른)/, '')] && !공간위치[loc.replace(/^(왼|오른)/, '')];
    };
    const order = refsOther('R') && !refsOther('L') ? ['L', 'R'] : ['R', 'L'];
    for (const side of order) {
      const g = given[side];
      const key = side === 'R' ? 'r' : 'l';
      if (g === '내림') { specs[side] = null; states[side] = null; e[key] = NEUTRAL[side]; continue; }
      if (g == null) {
        // 이 손은 그대로. 다만 반대쪽 손을 기준으로 붙어 있는 손은 그 손을 따라간다.
        if (specs[side] && refsOther(side) && given[side === 'R' ? 'L' : 'R'] != null) {
          const r = 손풀기(side, specs[side], states, ctx);
          states[side] = r.state; e[key] = r.eng; note(side, r, ki);
        }
        continue;
      }
      if (typeof g !== 'object') throw new Error(`${ctx}: 손 자세는 객체 또는 '내림'`);
      const bad = Object.keys(g).filter((x) => !['모양', '바닥', '등', '끝', '위치', '닿음', '띄움', '옮김', '쪽', '기울임', '꺾음', '비틂'].includes(x));
      if (bad.length) throw new Error(`${ctx}: 모르는 자세 항목 ${bad.join(', ')}`);
      const prev = specs[side] ?? 기본자세;
      const spec = { ...prev, ...g };
      if (g.위치 != null) for (const f of ['닿음', '띄움', '옮김', '쪽']) if (g[f] == null) delete spec[f];
      if (g.바닥 != null || g.등 != null || g.끝 != null) for (const f of ['기울임', '꺾음', '비틂']) if (g[f] == null) delete spec[f];
      if (g.바닥 != null && g.등 == null) delete spec.등;
      if (g.등 != null && g.바닥 == null) delete spec.바닥;
      specs[side] = spec;
      const r = 손풀기(side, spec, states, ctx);
      states[side] = r.state;
      e[key] = r.eng;
      note(side, r, ki);
    }
    out.push(e);
  });
  for (const side of ['R', 'L']) {
    if (worst[side][0] > 손목한계) console.warn(`  [주의] ${word}: ${side === 'R' ? '오른' : '왼'}손 손목이 키${worst[side][1]}에서 ${Math.round(worst[side][0])}° 꺾임 → 엔진이 손을 돌려 적은 방향과 달라진다. 끝(손끝 방향)을 팔이 뻗어 오는 쪽에 가깝게 고치거나 위치를 옮길 것`);
  }
  return out;
}

// ====================================================================
// 8. 움직임 도우미 — 모두 "키 배열"을 돌려주므로 동작 목록 안에 ...로 펼쳐 넣는다
// ====================================================================
// 손: '오른' | '왼' | '양손'
const 키 = (손, spec, rest = {}) => ({ [손]: spec, ...rest });

// 같은 키 묶음을 n번 되풀이
export function 반복(n, ...keys) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...keys.flat());
  return out;
}
// 댄다: 지금 위치(표면)에 띄움 0으로 붙인다
export function 댄다(손, { 시간 = 6, 멈춤 = 3, ...rest } = {}) {
  return [키(손, { 띄움: 0 }, { 시간, 멈춤, ...rest })];
}
// 두 번 댄다(두드린다): 댔다 → 뗐다 → 댔다 → 뗀다
export function 두번댄다(손, { 떼기 = 0.09, 시간 = 5, 횟수 = 2, 끝에떼기 = true, ...rest } = {}) {
  const out = [];
  for (let i = 0; i < 횟수; i++) {
    out.push(키(손, { 띄움: 0 }, { 시간, 멈춤: 1, ...rest }));
    if (i < 횟수 - 1 || 끝에떼기) out.push(키(손, { 띄움: 떼기 }, { 시간 }));
  }
  return out;
}
// 지금 자리에서 어느 쪽으로 옮긴다 (내민다·당긴다·올린다·내린다·쓸어내린다)
export function 옮긴다(손, 옮김, { 시간 = 8, 멈춤 = 2, ...rest } = {}) {
  return [키(손, { 옮김 }, { 시간, 멈춤, ...rest })];
}
// 지금 자리에서 좌우(또는 다른 축)로 흔든다: 폭만큼 갔다가 돌아오기를 되풀이
export function 흔든다(손, { 쪽 = '왼', 폭 = 0.08, 횟수 = 2, 시간 = 4, 양쪽 = true, 기준 = {}, ...rest } = {}) {
  const at = (w) => ({ ...기준, [쪽]: (기준[쪽] || 0) + w });
  const out = [];
  for (let i = 0; i < 횟수; i++) {
    out.push(키(손, { 옮김: at(폭) }, { 시간, ...rest }));
    out.push(키(손, { 옮김: at(양쪽 ? -폭 : 0) }, { 시간, ...rest }));
  }
  if (양쪽) out.push(키(손, { 옮김: at(0) }, { 시간: Math.max(3, 시간 - 1), ...rest }));
  return out;
}
// 손목만 움직인다: 종류 = '기울임'(좌우로 까딱) | '꺾음'(앞뒤로 까딱) | '비틂'(손목 돌림)
export function 손목흔든다(손, { 종류 = '기울임', 각 = 20, 횟수 = 2, 시간 = 4, 양쪽 = true, ...rest } = {}) {
  const out = [];
  for (let i = 0; i < 횟수; i++) {
    out.push(키(손, { [종류]: 각 }, { 시간, ...rest }));
    out.push(키(손, { [종류]: 양쪽 ? -각 : 0 }, { 시간, ...rest }));
  }
  if (양쪽) out.push(키(손, { [종류]: 0 }, { 시간: Math.max(3, 시간 - 1), ...rest }));
  return out;
}
// 원을 그린다. 지금 자리에서 시작해 한 바퀴(또는 여러 바퀴) 돌아 제자리로 온다.
//   면: '정면'(보는 사람이 보는 면, 좌우·상하) | '수평'(바닥과 나란한 면, 좌우·앞뒤) | '측면'(옆에서 보는 면, 앞뒤·상하)
//   방향: 1 또는 -1 (도는 쪽), 시작각: 원 위에서 지금 자리가 놓인 각도(도)
//   양손이면 왼손은 좌우가 뒤집힌 원을 그린다.
export function 원그린다(손, { 반지름 = 0.1, 면 = '정면', 바퀴 = 1, 방향 = 1, 시작각 = 90, 걸음 = 8, 시간 = 3, 기준 = {}, ...rest } = {}) {
  const axes = { 정면: ['왼', '위'], 수평: ['왼', '밖'], 측면: ['밖', '위'] }[면];
  if (!axes) throw new Error(`원그린다: 면을 알 수 없음 ${면}`);
  const a0 = 시작각 * DEG;
  const n = 걸음 * 바퀴;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + (방향 * Math.PI * 2 * i) / 걸음;
    const o = { ...기준 };
    o[axes[0]] = (o[axes[0]] || 0) + 반지름 * (Math.cos(a) - Math.cos(a0));
    o[axes[1]] = (o[axes[1]] || 0) + 반지름 * (Math.sin(a) - Math.sin(a0));
    out.push(키(손, { 옮김: o }, { 시간, 지나감: i < n, ...rest }));
  }
  return out;
}
// 손 모양만 바꾼다 (오므린다·편다·접는다)
export function 모양바꾼다(손, 모양, { 시간 = 6, 멈춤 = 2, ...rest } = {}) {
  return [키(손, { 모양 }, { 시간, 멈춤, ...rest })];
}
// 쉬는 자세로 내린다
export function 내린다(손, { 시간 = 10 } = {}) {
  return [손 === '양손' ? { 오른: '내림', 왼: '내림', 시간 } : { [손]: '내림', 시간 }];
}
