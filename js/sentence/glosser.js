// 문장 → 수어 단어 나열(글로스) — 순수 로직 (DOM 사용 안 함)
// 순서: 정확 일치 → 활용형(forms) → 비슷한 말(synonyms) → 어미 규칙 → 가장 긴 일치로 쪼개기 → 지문자
import { tokenize, stripParticle, detectFeatures, normalize, isAllHangul } from './tokenizer.js';
import { decompose, splitSyllable, composeSyllable } from './fingerspell.js';

const MAX_CANDIDATES = 5;

// 종성 번호
const J_N = 4, J_D = 7, J_L = 8, J_M = 16, J_B = 17, J_SS = 20, J_H = 27;
// 중성 번호
const V_A = 0, V_AE = 1, V_EO = 4, V_E = 5, V_YEO = 6, V_O = 8, V_WA = 9, V_WAE = 10, V_OE = 11, V_U = 13, V_WO = 14, V_EU = 18, V_I = 20;
// 초성 번호
const C_L = 5, C_O = 11, C_H = 18;

// 어간에 바로 붙는 어미 (긴 것부터 검사)
const DIRECT_ENDINGS = [
  '습니다', '습니까', '지만', '는데요', '는데', '은데요', '은데', '으면', '면', '고요', '고', '는다', '는', '지요', '지', '죠', '다',
  '니', '냐', '나요', '네요', '네', '자', '거나', '던', '으러', '러', '으려고', '려고',
  '으세요', '세요', '으니까', '니까', '으니', '은', '을', '음',
  '까요', '까', '게요', '래요', '래', '거예요', '겁니다', '도록', '기',
].sort((a, b) => b.length - a.length);
// '-아/-어' 꼴 뒤에 붙는 것 ('' = 반말 종결)
const AEO_SUFFIXES = ['서요', '야지', '요', '서', '도', '야', '라', ''];
// 어미 규칙을 어간(조사 뗀 것)에 적용해도 되는 조사 — 용언 뒤에도 붙는 것만
const VERB_OK_PARTICLES = new Set(['', '요', '도', '만', '는', '야']);

// 문자열의 마지막 음절을 바꾼다
function replaceLast(str, fn) {
  const s = splitSyllable(str[str.length - 1]);
  if (!s) return null;
  const r = fn(s);
  return r ? str.slice(0, -1) + composeSyllable(r.cho, r.jung, r.jong) : null;
}

// 활용형 → 어간 후보 목록 ('다'를 붙이면 기본형). 사전에 있는 것만 채택되므로 넉넉하게 만든다.
export function stemCandidates(surface) {
  const results = [];
  const seen = new Set();
  const queue = [];
  const push = (str, mode) => {
    if (!str) return;
    const key = mode + ':' + str;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push([str, mode]);
  };
  const addResult = (str) => { if (str && !results.includes(str)) results.push(str); };

  // 1) 겉모습에서 어미 떼기
  for (const e of DIRECT_ENDINGS) {
    if (surface.length > e.length && surface.endsWith(e)) push(surface.slice(0, -e.length), 'stem');
  }
  // -ㅂ니다 / -ㅂ니까 / -ㅂ시다 (갑니다 → 가)
  for (const e of ['니다', '니까', '시다']) {
    if (surface.length > e.length && surface.endsWith(e)) {
      const rest = surface.slice(0, -e.length);
      const r = replaceLast(rest, (s) => (s.jong === J_B ? { ...s, jong: 0 } : null));
      if (r) push(r, 'stem');
    }
  }
  for (const a of AEO_SUFFIXES) {
    if (surface.length > a.length && surface.endsWith(a)) push(a ? surface.slice(0, -a.length) : surface, 'aeo');
  }

  // 2) 줄여 나가기
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const [str, mode] = queue.shift();
    const lastCh = str[str.length - 1];
    const s = splitSyllable(lastCh);
    if (!s) continue;
    const rest = str.slice(0, -1);

    if (mode === 'aeo') {
      // '-아/-어' 꼴 → 어간
      if (s.jong !== 0) continue;
      const prev = rest ? splitSyllable(rest[rest.length - 1]) : null;
      if (s.cho === C_O && (s.jung === V_A || s.jung === V_EO || s.jung === V_YEO) && rest) {
        push(rest, 'stem'); // 먹어 → 먹, 좋아 → 좋, 하여 → 하
        continue;
      }
      const withVowel = (jung) => rest + composeSyllable(s.cho, jung, 0);
      if (s.jung === V_A || s.jung === V_EO) {
        push(str, 'stem'); // 가 → 가, 만나 → 만나, 서 → 서
        push(withVowel(V_EU), 'stem'); // 기뻐 → 기쁘, 바빠 → 바쁘
        if (s.cho === C_L && prev && prev.jong === J_L) {
          // 르 불규칙: 몰라 → 모르
          addResult(rest.slice(0, -1) + composeSyllable(prev.cho, prev.jung, 0) + '르');
        }
      } else if (s.jung === V_YEO) {
        push(withVowel(V_I), 'stem'); // 마셔 → 마시
        push(str, 'stem'); // 펴 → 펴
      } else if (s.jung === V_WA) {
        push(withVowel(V_O), 'stem'); // 와 → 오, 봐 → 보
        if (s.cho === C_O && prev && prev.jong === 0) addResult(rest.slice(0, -1) + composeSyllable(prev.cho, prev.jung, J_B)); // 도와 → 돕
      } else if (s.jung === V_WO) {
        push(withVowel(V_U), 'stem'); // 배워 → 배우
        if (s.cho === C_O && prev && prev.jong === 0) addResult(rest.slice(0, -1) + composeSyllable(prev.cho, prev.jung, J_B)); // 반가워 → 반갑
      } else if (s.jung === V_AE) {
        if (s.cho === C_H) push(rest + '하', 'stem'); // 해 → 하
        push(str, 'stem'); // 보내 → 보내
        addResult(rest + composeSyllable(s.cho, V_EO, J_H)); // 그래 → 그렇
        addResult(rest + composeSyllable(s.cho, V_A, J_H)); // 빨개 → 빨갛
      } else if (s.jung === V_WAE) {
        push(withVowel(V_OE), 'stem'); // 돼 → 되
      } else if (s.jung === V_E) {
        push(str, 'stem'); // 세 → 세
      }
      continue;
    }

    // mode === 'stem': 어간일 수도 있고, 선어말어미(았/었/겠/시)가 남아 있을 수도 있다
    addResult(str);
    if (s.jong === J_SS) push(rest + composeSyllable(s.cho, s.jung, 0), 'aeo'); // 먹었 → 먹어, 갔 → 가, 했 → 해
    if ((lastCh === '겠' || lastCh === '시') && rest) push(rest, 'stem'); // 가겠 → 가, 가시 → 가
    if ((lastCh === '을' || lastCh === '은' || lastCh === '으' || lastCh === '음') && rest) push(rest, 'stem'); // 먹을 → 먹, 먹으 → 먹
    if (s.jong === J_N || s.jong === J_L || s.jong === J_M) push(rest + composeSyllable(s.cho, s.jung, 0), 'stem'); // 간 → 가, 갈 → 가
    if (lastCh === '우' && rest) {
      // ㅂ 불규칙: 반가우 → 반갑
      const r = replaceLast(rest, (p) => (p.jong === 0 ? { ...p, jong: J_B } : null));
      if (r) addResult(r);
    }
    if (s.jong === J_L) addResult(rest + composeSyllable(s.cho, s.jung, J_D)); // ㄷ 불규칙: 걸 → 걷
    if (s.jong === 0) {
      addResult(rest + composeSyllable(s.cho, s.jung, J_L)); // ㄹ 탈락: 사 → 살
      addResult(rest + composeSyllable(s.cho, s.jung, J_H)); // ㅎ 불규칙: 빨가 → 빨갛
    }
  }
  return results;
}

// 활용형 → 기본형 후보 목록 (어간 + '다')
export function lemmaCandidates(surface) {
  return stemCandidates(String(surface ?? '')).map((s) => s + '다');
}

// 사전 색인 만들기. words = words.json 배열 (또는 { words: [...] })
export function buildIndex(words) {
  const list = Array.isArray(words) ? words : (words && Array.isArray(words.words) ? words.words : []);
  const exact = new Map();
  const forms = new Map();
  const synonyms = new Map();
  const keys = new Map(); // 낱말 → [{ entry, type }] (후보 찾기용, 겹치는 것 모두)
  const addKey = (key, entry, type) => {
    if (!keys.has(key)) keys.set(key, []);
    if (!keys.get(key).some((k) => k.entry === entry)) keys.get(key).push({ entry, type });
  };
  const clean = (v) => (typeof v === 'string' ? v.trim() : '');

  for (const entry of list) {
    const w = clean(entry && entry.word);
    if (!w) continue;
    if (!exact.has(w)) exact.set(w, entry);
    addKey(w, entry, 'exact');
  }
  for (const entry of list) {
    for (const f of (entry && entry.forms) || []) {
      const k = clean(f);
      if (!k) continue;
      if (!forms.has(k)) forms.set(k, entry);
      addKey(k, entry, 'form');
    }
  }
  for (const entry of list) {
    for (const f of (entry && entry.synonyms) || []) {
      const k = clean(f);
      if (!k) continue;
      if (!synonyms.has(k)) synonyms.set(k, entry);
      addKey(k, entry, 'synonym');
    }
  }
  // 숫자·수 관형사는 수사 항목이 있을 때만 비슷한 말로 연결
  const extra = { '1': '하나', '한': '하나', '2': '둘', '두': '둘', '3': '셋', '세': '셋' };
  for (const [k, target] of Object.entries(extra)) {
    const entry = exact.get(target);
    if (entry && !keys.has(k)) {
      synonyms.set(k, entry);
      addKey(k, entry, 'synonym');
    }
  }

  return {
    words: list,
    exact,
    forms,
    synonyms,
    keys,
    known: new Set(keys.keys()),
    completion: exact.get('끝') || null,
  };
}

// 정확 → 활용형 → 비슷한 말 순서로 그대로 찾기
function directLookup(text, index) {
  if (!text) return null;
  if (index.exact.has(text)) return { entry: index.exact.get(text), type: 'exact' };
  if (index.forms.has(text)) return { entry: index.forms.get(text), type: 'form' };
  if (index.synonyms.has(text)) return { entry: index.synonyms.get(text), type: 'synonym' };
  return null;
}

// 어미 규칙으로 기본형을 만들어 찾기
function ruleLookup(text, index) {
  if (!text || !isAllHangul(text)) return null;
  for (const stem of stemCandidates(text)) {
    let hit = directLookup(stem + '다', index);
    // 명사 + 하다: 감사했어요 → 감사
    if (!hit && stem.length > 1 && stem.endsWith('하')) hit = directLookup(stem.slice(0, -1), index);
    if (hit) return { entry: hit.entry, type: 'rule' };
  }
  return null;
}

// 어절 하나를 통째로 찾기 (쪼개기·지문자 제외). → { entry, type, text } 또는 null
function lookupWhole(surface, index) {
  let hit = directLookup(surface, index);
  if (hit) return { ...hit, text: surface };
  const { stem, particle } = stripParticle(surface, index.known);
  if (particle) {
    hit = directLookup(stem, index);
    if (hit) return { ...hit, text: stem };
  }
  hit = ruleLookup(surface, index);
  if (hit) return { ...hit, text: surface };
  if (particle && VERB_OK_PARTICLES.has(particle)) {
    hit = ruleLookup(stem, index);
    if (hit) return { ...hit, text: stem };
  }
  return null;
}

// 낱말 하나 찾기 (카드 바꾸기 검색용) → { entry, type } 또는 null
export function lookupWord(text, index) {
  const t = normalize(text).replace(/\s+/g, '');
  if (!t || !index) return null;
  const hit = lookupWhole(t, index);
  return hit ? { entry: hit.entry, type: hit.type } : null;
}

// 쪼갤 때 한 글자 조각은 명사 표제어(밥, 물, 끝 …)만 허용
function pieceAllowed(piece, hit) {
  if (piece.length >= 2) return true;
  return hit.type === 'exact' && hit.entry.pos === '명사';
}

// 사전 낱말의 가장 긴 일치로 쪼개기 (학교친구 → 학교 + 친구). 전부 덮지 못하면 null
function splitLongest(text, index, depth = 0) {
  if (depth > 8) return null;
  for (let len = text.length - 1; len >= 1; len--) {
    const head = text.slice(0, len);
    const hit = directLookup(head, index);
    if (!hit || !pieceAllowed(head, hit)) continue;
    const tail = text.slice(len);
    const whole = lookupWhole(tail, index);
    if (whole && (tail.length >= 2 || pieceAllowed(tail, whole))) {
      return [{ text: head, entry: hit.entry }, { text: whole.text, entry: whole.entry }];
    }
    const more = splitLongest(tail, index, depth + 1);
    if (more) return [{ text: head, entry: hit.entry }, ...more];
  }
  return null;
}

// 다른 후보 찾기: 같은 낱말의 다른 뜻 → 부분 일치 → 첫 글자 일치 → 같은 분류
function findCandidates(text, entry, index) {
  const scores = new Map();
  const bump = (e, score) => {
    if (!e || e === entry) return;
    if ((scores.get(e) || 0) < score) scores.set(e, score);
  };
  const probes = [text];
  if (entry && entry.word && entry.word !== text) probes.push(entry.word);

  for (const probe of probes) {
    if (!probe) continue;
    const weight = probe === text ? 1 : 0.5;
    for (const [key, hits] of index.keys) {
      let score = 0;
      if (key === probe) score = 100;
      else if (probe.length >= 2 && key.length >= 2 && (key.startsWith(probe) || probe.startsWith(key))) score = 60 + Math.min(key.length, probe.length);
      else if (probe.length >= 2 && key.length >= 2 && (key.includes(probe) || probe.includes(key))) score = 40 + Math.min(key.length, probe.length);
      else if (probe.length === 1 && key.startsWith(probe) && key.length <= 3) score = 20;
      else if (probe.length >= 2 && key.length >= 2 && key[0] === probe[0]) score = 10;
      if (score) for (const h of hits) bump(h.entry, score * weight);
    }
  }
  if (entry && entry.category) {
    for (const e of index.words) if (e.category === entry.category) bump(e, 1);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || index.words.indexOf(a[0]) - index.words.indexOf(b[0]))
    .slice(0, MAX_CANDIDATES)
    .map(([e]) => e);
}

// '하다'의 활용형인지 (해요, 했어요, 합니다, 하고 …)
function isLightVerbHada(surface) {
  return isAllHangul(surface) && stemCandidates(surface).includes('하');
}

// 문장 → 글로스
export function gloss(sentence, index, { addCompletion = false } = {}) {
  const { isQuestion, isPast } = detectFeatures(sentence);
  const tokens = [];
  const notes = [];
  const make = (surface, text, entry, type, extra = {}) => ({
    surface, text, entry, type, candidates: findCandidates(text, entry, index), ...extra,
  });

  for (const tk of tokenize(sentence, index.known)) {
    const { surface, stem } = tk;

    // '공부를 했어요'처럼 명사 뒤에 '하다'가 따로 온 경우: 앞 낱말과 합친다
    // (사전에 '하다'가 있어도, 앞 명사에 'X하다' 표제어가 있으면 합치는 쪽을 먼저 본다)
    const prev = tokens[tokens.length - 1];
    if (prev && prev.entry && prev.type !== 'split' && isLightVerbHada(surface)) {
      const joined = directLookup(prev.text + '하다', index);
      const prevIsHada = /하다$|합니다$/.test(prev.entry.word);
      if (joined || prevIsHada) {
        const entry = joined ? joined.entry : prev.entry;
        const text = prev.text + ' ' + surface;
        tokens[tokens.length - 1] = make(prev.surface + ' ' + surface, text, entry, 'rule');
        tokens[tokens.length - 1].candidates = findCandidates(prev.text, entry, index);
        continue;
      }
    }

    // 1~4) 통째로 찾기
    const whole = lookupWhole(surface, index);
    if (whole) {
      tokens.push(make(surface, whole.text, whole.entry, whole.type));
      continue;
    }

    // 5) 가장 긴 일치로 쪼개기 (어절 그대로 → 조사 뗀 것)
    const pieces = (isAllHangul(surface) && splitLongest(surface, index))
      || (stem !== surface && isAllHangul(stem) && splitLongest(stem, index));
    if (pieces) {
      for (const p of pieces) tokens.push(make(surface, p.text, p.entry, 'split'));
      continue;
    }

    // 6) 지문자 — 한글로만 된 낱말만 가능
    const target = isAllHangul(stem) ? stem : (isAllHangul(surface) ? surface : '');
    const jamo = target ? decompose(target) : [];
    if (jamo.length) {
      tokens.push(make(surface, target, null, 'fingerspell', { jamo }));
    } else {
      // 숫자·영문 등은 표현할 수 없다 — 빼지 않고 '못 찾음'으로 남긴다
      tokens.push(make(surface, stem || surface, null, 'none'));
    }
  }

  // 과거형이면 문장 끝에 '끝(완료)' 붙이기 (옵션)
  const completion = index.completion;
  let completionAdded = false;
  if (isPast && addCompletion && completion) {
    const last = tokens[tokens.length - 1];
    if (!last || last.entry !== completion) {
      tokens.push({ surface: '', text: '끝', entry: completion, type: 'marker', candidates: [] });
      completionAdded = true;
    }
  }

  // 안내 문구
  if (isQuestion) notes.push('의문문입니다. 눈썹을 올리고 고개를 약간 앞으로 내밀어 의문을 표시하세요.');
  if (isPast) {
    if (completionAdded) notes.push('과거 표현이 감지되어 문장 끝에 "끝(완료)" 수어를 붙였습니다.');
    else if (completion && !addCompletion) notes.push('과거 표현이 감지되었습니다. 옵션을 켜면 문장 끝에 "끝(완료)" 수어를 붙일 수 있습니다.');
    else notes.push('과거 표현이 감지되었습니다.');
  }
  if (tokens.some((t) => t.type === 'fingerspell')) notes.push('사전에 없는 낱말은 지문자(자모)로 표현했습니다.');
  if (tokens.some((t) => t.type === 'none')) notes.push('숫자·영문 등 표현할 수 없는 낱말이 있습니다. 카드를 눌러 다른 낱말로 바꾸거나 삭제하세요.');

  return { tokens, isPast, isQuestion, notes };
}
