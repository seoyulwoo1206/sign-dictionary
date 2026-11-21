// 문장 정리 · 어절 분리 · 조사 떼기 · 시제/의문 감지 — 순수 로직 (DOM 사용 안 함)
import { splitSyllable, isHangulSyllable } from './fingerspell.js';

// 받침 조건: 'C' 받침 있어야 함, 'V' 받침 없어야 함, 'VL' 받침 없거나 ㄹ, 'CX' 받침 있되 ㄹ 제외, '' 상관없음
const PARTICLE_RULES = {
  // 격조사 · 보조사
  '은': 'C', '는': 'V', '이': 'C', '가': 'V', '을': 'C', '를': 'V',
  '에': '', '에서': '', '에게': '', '한테': '', '께': '', '께서': '',
  '도': '', '만': '', '로': 'VL', '으로': 'CX', '와': 'V', '과': 'C',
  '랑': 'V', '이랑': 'C', '하고': '', '의': '', '부터': '', '까지': '',
  '처럼': '', '보다': '', '마다': '', '밖에': '', '에게서': '', '한테서': '',
  '이라고': 'C', '라고': 'V', '요': '',
  // 겹친 조사
  '에서는': '', '에서도': '', '에서만': '', '에서의': '', '에는': '', '에도': '', '에만': '',
  '에게는': '', '에게도': '', '한테는': '', '한테도': '', '께서는': '', '께서도': '', '께는': '',
  '으로는': 'CX', '으로도': 'CX', '으로의': 'CX', '로는': 'VL', '로도': 'VL', '로의': 'VL',
  '와는': 'V', '과는': 'C', '와도': 'V', '과도': 'C', '와의': 'V', '과의': 'C',
  '까지는': '', '까지도': '', '부터는': '', '만은': '', '만이': '', '만을': '', '만의': '',
  // 서술격 조사 '이다'의 활용
  '입니다': '', '입니까': '', '이에요': 'C', '예요': 'V', '이야': 'C', '야': 'V', '이다': '',
  '인가요': '', '이었어요': 'C', '였어요': 'V', '이었습니다': 'C', '였습니다': 'V',
  '이었다': 'C', '였다': 'V', '인데': '', '인데요': '', '이네요': 'C', '이죠': 'C', '이지요': 'C',
};
// 긴 것부터 맞춰 본다
const PARTICLES = Object.keys(PARTICLE_RULES).sort((a, b) => b.length - a.length);

// 조사처럼 끝나지만 한 단어인 낱말 (떼면 안 됨)
const NO_STRIP = new Set([
  '아이', '나이', '오이', '종이', '놀이', '고양이', '어린이', '호랑이', '거북이', '이야기', '차이', '사이', '높이', '길이', '같이', '많이', '깊이',
  '휴가', '화가', '국가', '작가', '평가', '추가', '물가', '증가', '누가', '뭔가', '누군가',
  '지도', '포도', '온도', '정도', '태도', '속도', '파도', '기도', '제주도', '독도', '아마도',
  '별로', '도로', '진로', '바로', '서로', '새로', '따로', '스스로', '대로',
  '회의', '주의', '강의', '거의', '예의', '동의', '사과', '결과', '효과', '치과', '교과', '학과',
  '사랑', '신랑', '자랑', '필요', '중요', '최고', '창고', '광고', '사고', '참고',
  '함께', '가을', '마을', '노을', '분야', '이만', '그만', '다만',
  '그런데', '그래도', '아직도', '또는', '혹은',
]);

// 의문사 (여러 글자: 앞부분 일치, 한 글자: 조사 뗀 결과가 일치)
const WH_PREFIX = ['무엇', '무슨', '어디', '언제', '누구', '누가', '어떻게', '어떤', '어느', '얼마', '어때', '몇'];
const WH_SINGLE = ['뭐', '뭘', '뭔', '왜'];
// 의문사처럼 시작하지만 의문이 아닌 낱말
const WH_EXCEPT = new Set(['언제나', '누구나', '어디나', '어디든', '언제든', '누구든', '어딘가', '언젠가', '누군가', '어느새', '뭔가']);
// '-니'로 끝나지만 의문이 아닌 낱말
const NI_EXCEPT = new Set(['아니', '어머니', '할머니', '언니', '주머니', '그러니', '아주머니', '머니']);

// 문장부호 제거, 공백 정리
export function normalize(sentence) {
  return String(sentence ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 어절 배열
export function splitEojeol(sentence) {
  const n = normalize(sentence);
  return n ? n.split(' ') : [];
}

// 받침 조건 검사
function fitsBatchim(stem, cond) {
  if (!cond) return true;
  const s = splitSyllable(stem[stem.length - 1]);
  if (!s) return true; // 숫자·영문 뒤에는 조건을 따지지 않는다
  const has = s.jong > 0;
  if (cond === 'C') return has;
  if (cond === 'V') return !has;
  if (cond === 'VL') return !has || s.jong === 8;
  if (cond === 'CX') return has && s.jong !== 8;
  return true;
}

// 어절 끝의 조사를 뗀다 (가장 긴 조사 우선, 한 번만).
// known(사전에 있는 낱말 Set)이 있으면 사전 지식을 우선한다.
export function stripParticle(eojeol, known) {
  const word = String(eojeol ?? '');
  const none = { stem: word, particle: '' };
  if (word.length < 2) return none;
  if (known && known.has(word)) return none; // 어절 자체가 사전에 있음 (네가, 학교에, 가는 …)
  if (NO_STRIP.has(word)) return none;

  let fallback = null;
  for (const p of PARTICLES) {
    if (word.length <= p.length || !word.endsWith(p)) continue;
    const stem = word.slice(0, -p.length);
    if (!fitsBatchim(stem, PARTICLE_RULES[p])) continue;
    if (!known) return { stem, particle: p };
    if (known.has(stem)) return { stem, particle: p }; // 사전에 있는 어간이면 바로 확정
    if (!fallback) fallback = { stem, particle: p }; // 아니면 가장 긴 조사를 기억
  }
  return fallback || none;
}

// 마지막 글자의 받침이 주어진 번호 중 하나인지
function lastJongIn(str, jongs) {
  const s = splitSyllable(str[str.length - 1]);
  return !!s && jongs.includes(s.jong);
}

// 어절이 의문사인지
function isWhWord(eojeol) {
  if (WH_EXCEPT.has(eojeol)) return false;
  if (WH_PREFIX.some((w) => eojeol.startsWith(w))) return true;
  if (WH_SINGLE.includes(eojeol)) return true;
  return WH_SINGLE.includes(stripParticle(eojeol).stem);
}

// 의문문 · 과거형 감지
export function detectFeatures(sentence) {
  const raw = String(sentence ?? '').trim();
  const eojeols = splitEojeol(raw);
  const endsDeclarative = /[.!。！]\s*$/.test(raw);

  // 과거: 받침이 ㅆ인 음절(았/었/였/했/갔 …). '있', '겠'은 제외
  let isPast = false;
  for (const ch of eojeols.join('')) {
    if (ch === '있' || ch === '겠') continue;
    const s = splitSyllable(ch);
    if (s && s.jong === 20) { isPast = true; break; }
  }

  let isQuestion = /[?？]/.test(raw);
  if (!isQuestion && eojeols.length) {
    const last = eojeols[eojeols.length - 1];
    const body = last.length > 1 && last.endsWith('요') ? last.slice(0, -1) : last;
    if (last.length >= 3 && last.endsWith('니까') && lastJongIn(last.slice(0, -2), [17])) {
      isQuestion = true; // -ㅂ니까 / -습니까 (이유를 나타내는 '-니까'는 제외)
    } else if (body.length >= 2 && body.endsWith('까') && lastJongIn(body.slice(0, -1), [8])) {
      isQuestion = true; // -ㄹ까(요)
    } else if (last.length >= 3 && last.endsWith('나요')) {
      // 만나요·끝나요 같은 '-나다' 동사와 구별한다
      const before = last.slice(0, -2);
      if (lastJongIn(before, [20, 18]) || '가오하되보주먹좋싫시'.includes(before[before.length - 1])) isQuestion = true;
    } else if (last.length >= 3 && last.endsWith('가요') && lastJongIn(last.slice(0, -2), [4])) {
      isQuestion = true; // -ㄴ가요 / 인가요
    } else if (last.length >= 2 && last.endsWith('니') && !NI_EXCEPT.has(last)) {
      isQuestion = true; // -니
    } else if (last.length >= 2 && last.endsWith('냐')) {
      isQuestion = true; // -냐
    }
    // 의문사가 있고 마침표·느낌표로 끝나지 않으면 의문문으로 본다
    if (!isQuestion && !endsDeclarative) isQuestion = eojeols.some(isWhWord);
  }
  return { isQuestion, isPast };
}

// 문장 → [{ surface, stem, particle }]
export function tokenize(sentence, known) {
  return splitEojeol(sentence).map((surface) => {
    const { stem, particle } = stripParticle(surface, known);
    return { surface, stem, particle };
  });
}

// 한글(음절 또는 낱자모 ㄱ~ㅣ)로만 이루어졌는지 (지문자로 표현 가능한지 판단용)
export function isAllHangul(text) {
  if (!text) return false;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (!isHangulSyllable(ch) && !(c >= 0x3131 && c <= 0x3163)) return false;
  }
  return true;
}
