// 단어 정보 → words.json 항목 / sign JSON 문자열 만들기

export const POS_LIST = ['명사', '동사', '형용사', '대명사', '수사', '감탄사', '부사'];

export const JAMO_GROUPS = [
  { label: '자음', items: [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'] },
  { label: '쌍자음', items: [...'ㄲㄸㅃㅆㅉ'] },
  { label: '모음', items: [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'] },
];

// --- 간단한 로마자 변환 (id용) ---
const INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIAL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// 받침 뒤에 모음이 오면 다음 글자의 첫소리로 넘어간다 (홑받침만 처리)
const LIAISON = { 1: 'g', 2: 'kk', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 24: 'k', 25: 't', 26: 'p' };
// ㄴ·ㅁ 앞에서 받침 소리가 바뀐다 (먹는 → meongneun, 합니다 → hamnida)
const NASAL = { k: 'ng', t: 'n', p: 'm' };

export function romanize(text) {
  const chars = [...String(text).trim()];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) {
      out += /[a-zA-Z0-9]/.test(chars[i]) ? chars[i].toLowerCase() : '-';
      continue;
    }
    const ini = Math.floor(code / 588);
    const med = Math.floor((code % 588) / 28);
    const fin = code % 28;
    out += INITIAL[ini] + MEDIAL[med];
    if (!fin) continue;
    const nextCode = i + 1 < chars.length ? chars[i + 1].charCodeAt(0) - 0xac00 : -1;
    const nextIni = nextCode >= 0 && nextCode <= 11171 ? Math.floor(nextCode / 588) : -1;
    if (nextIni === 11 && LIAISON[fin]) out += LIAISON[fin];
    else if ((nextIni === 2 || nextIni === 6) && NASAL[FINAL[fin]]) out += NASAL[FINAL[fin]];
    else out += FINAL[fin];
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const splitList = (s) => String(s ?? '').split(/[,，、\n]/).map((v) => v.trim()).filter(Boolean);

// words.json에 붙일 항목 (명세 4-1)
export function buildWordEntry(info) {
  const word = String(info.word ?? '').trim();
  return {
    id: romanize(word) || 'word',
    word,
    forms: splitList(info.forms),
    synonyms: splitList(info.synonyms),
    pos: info.pos || '명사',
    meaning: String(info.meaning ?? '').trim(),
    category: String(info.category ?? '').trim(),
    level: Math.max(1, Math.min(5, Number(info.level) || 1)),
    sign: `signs/${word}.json`,
    description: String(info.description ?? '').trim(),
    handshape: String(info.handshape ?? '').trim(),
    nonManual: String(info.nonManual ?? '').trim(),
    verified: false,
  };
}

// 동작 데이터 객체 (명세 4-2). frames는 이미 다듬은 프레임 배열.
export function buildSignData(word, fps, frames) {
  return {
    version: 1,
    word,
    fps,
    frameCount: frames.length,
    coordinate: 'normalized',
    source: 'self-recorded',
    frames: frames.map((f, i) => ({
      t: i,
      pose: f.pose,
      left: f.left ?? null,
      right: f.right ?? null,
      face: f.face ?? null,
    })),
  };
}

// 프레임 하나를 한 줄로 쓴다 (파일 크기를 줄이면서 줄 단위 비교는 가능하게)
export function stringifySign(sign) {
  const { frames, ...head } = sign;
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const lines = frames.map((f) => `    ${JSON.stringify(f)}`);
  return `${headText},\n  "frames": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

// 파일 이름에 쓸 수 없는 문자를 뺀다
export function safeFileName(name) {
  return String(name).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
}
