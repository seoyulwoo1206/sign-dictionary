// 지문자(자모) 분해 모듈 — 순수 로직 (DOM 사용 안 함)
// 한글 음절을 유니코드 계산으로 초성/중성/종성으로 나눈다.

// 초성 19개 (유니코드 순서)
export const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 중성 21개 (유니코드 순서)
export const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
// 종성 28개 (0번은 받침 없음)
export const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// 동작 데이터 파일이 있는 자음: 기본 14 + 쌍자음 5
export const CONSONANTS = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ', 'ㄲ', 'ㄸ', 'ㅃ', 'ㅆ', 'ㅉ'];
// 동작 데이터 파일이 있는 모음 21개
export const VOWELS = [...JUNG];

// 겹받침 → 자음 두 개로 풀기
const DOUBLE_FINAL = {
  'ㄳ': ['ㄱ', 'ㅅ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄶ': ['ㄴ', 'ㅎ'], 'ㄺ': ['ㄹ', 'ㄱ'],
  'ㄻ': ['ㄹ', 'ㅁ'], 'ㄼ': ['ㄹ', 'ㅂ'], 'ㄽ': ['ㄹ', 'ㅅ'], 'ㄾ': ['ㄹ', 'ㅌ'],
  'ㄿ': ['ㄹ', 'ㅍ'], 'ㅀ': ['ㄹ', 'ㅎ'], 'ㅄ': ['ㅂ', 'ㅅ'],
};

const BASE = 0xAC00;
const LAST = 0xD7A3;
const JAMO_SET = new Set([...CONSONANTS, ...VOWELS]);

// 완성형 한글 음절(가~힣)인지
export function isHangulSyllable(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= BASE && c <= LAST;
}

// 음절 → { cho, jung, jong } 번호. 한글 음절이 아니면 null
export function splitSyllable(ch) {
  if (!isHangulSyllable(ch)) return null;
  const n = ch.charCodeAt(0) - BASE;
  return { cho: Math.floor(n / 588), jung: Math.floor((n % 588) / 28), jong: n % 28 };
}

// 번호 → 음절
export function composeSyllable(cho, jung, jong = 0) {
  return String.fromCharCode(BASE + cho * 588 + jung * 28 + jong);
}

// '각' → ['ㄱ','ㅏ','ㄱ'], '닭' → ['ㄷ','ㅏ','ㄹ','ㄱ']
// 낱자모(ㄱ, ㅏ 등)가 그대로 들어오면 그대로 돌려주고, 한글이 아니면 빈 배열
export function decomposeSyllable(ch) {
  const s = splitSyllable(ch);
  if (!s) {
    if (JAMO_SET.has(ch)) return [ch];
    if (DOUBLE_FINAL[ch]) return [...DOUBLE_FINAL[ch]];
    return [];
  }
  const out = [CHO[s.cho], JUNG[s.jung]];
  if (s.jong > 0) {
    const j = JONG[s.jong];
    if (DOUBLE_FINAL[j]) out.push(...DOUBLE_FINAL[j]);
    else out.push(j);
  }
  return out;
}

// 문자열 전체 → 자모 배열 (한글이 아닌 글자는 건너뜀)
export function decompose(text) {
  const out = [];
  for (const ch of String(text ?? '')) out.push(...decomposeSyllable(ch));
  return out;
}

// 자모 → 동작 데이터 경로 (data/ 기준)
export function jamoSignPath(jamo) {
  return `fingerspelling/${jamo}.json`;
}
