// 문장 분석 테스트 — 브라우저(tokenizer.test.html)와 Node 양쪽에서 쓸 수 있는 순수 로직
import { normalize, splitEojeol, stripParticle, detectFeatures, tokenize } from '../js/sentence/tokenizer.js';
import { buildIndex, gloss, lookupWord, lemmaCandidates } from '../js/sentence/glosser.js';
import { CONSONANTS, VOWELS, decomposeSyllable, decompose, jamoSignPath } from '../js/sentence/fingerspell.js';

// 문장 → 글로스 기대값. 낱말은 entry.word, 지문자는 '#fs:글자', 못 찾음은 '#none'
// past / question 은 적혀 있을 때만 검사한다.
export const SENTENCE_CASES = [
  { s: '나는 학교에 갔어요', g: ['나', '학교', '가다'], past: true, question: false },
  { s: '만나서 반갑습니다', g: ['만나다', '반갑다'], past: false, question: false },
  { s: '엄마가 밥을 먹었어요?', g: ['엄마', '밥', '먹다'], past: true, question: true },
  { s: '학교친구를 만났다', g: ['학교', '친구', '만나다'], past: true },
  { s: '철수는 물을 마셔요', g: ['#fs:철수', '물', '마시다'], past: false, question: false },
  { s: '안녕하세요', g: ['안녕하세요'] },
  { s: '제 이름은 철수입니다', g: ['나', '이름', '#fs:철수'], question: false },
  { s: '이름이 뭐예요?', g: ['이름', '무엇'], question: true },
  { s: '어디에 가요?', g: ['어디', '가다'], question: true, past: false },
  { s: '오늘 학교에서 친구를 만났어요', g: ['오늘', '학교', '친구', '만나다'], past: true },
  { s: '내일 선생님과 공부합니다', g: ['내일', '선생님', '공부하다'], past: false },
  { s: '저는 물을 마시고 밥을 먹었습니다.', g: ['나', '물', '마시다', '밥', '먹다'], past: true, question: false },
  { s: '어머니와 아버지는 가족입니다', g: ['엄마', '아빠', '가족'] },
  { s: '하나 둘 셋', g: ['하나', '둘', '셋'] },
  { s: '밥먹었어요', g: ['밥', '먹다'], past: true },
  { s: '고마워요 친구', g: ['감사합니다', '친구'] },
  { s: '아니요, 괜찮아요.', g: ['아니요', '괜찮다'], question: false },
  { s: '슬프지만 괜찮습니다', g: ['슬프다', '괜찮다'] },
  { s: '어제 뭐 먹었니', g: ['어제', '무엇', '먹다'], past: true, question: true },
  { s: '공부를 했어요', g: ['공부하다'], past: true },
  { s: '식사했어요?', g: ['먹다'], past: true, question: true },
  { s: '선생님이 오셨어요', g: ['선생님', '오다'], past: true },
  { s: '친구가 반가웠어요', g: ['친구', '반갑다'], past: true },
  { s: '엄마는 기뻤다', g: ['엄마', '기쁘다'], past: true },
  { s: 'TV 좋아요', g: ['#none', '좋다'] },
  { s: '나는 친구를 좋아합니다', g: ['나', '친구', '좋다'] },
  { s: '아빠가 학교에 옵니다', g: ['아빠', '학교', '오다'], past: false },
  { s: '너는 어디서 왔니?', g: ['너', '어디', '오다'], past: true, question: true },
  { s: '내일 갑니까', g: ['내일', '가다'], question: true },
  { s: '물을 마시면 좋습니다', g: ['물', '마시다', '좋다'], question: false },
  { s: '죄송합니다 선생님', g: ['미안합니다', '선생님'] },
  { s: '친구들과 밥을 먹고 학교에 갔다', g: ['친구', '밥', '먹다', '학교', '가다'], past: true },
  { s: '영희가 왔어요', g: ['#fs:영희', '오다'], past: true },
  { s: '오늘은 싫어요', g: ['오늘', '싫다'], past: false },
  { s: '나는 학교에 갔어요', opt: { addCompletion: true }, g: ['나', '학교', '가다', '끝'], past: true },
  { s: '나는 학교에 가요', opt: { addCompletion: true }, g: ['나', '학교', '가다'], past: false },
  { s: '저는 물을 마셨습니다', g: ['나', '물', '마시다'], past: true },
  { s: '무엇을 먹을까요', g: ['무엇', '먹다'], question: true },
  { s: '선생님께 감사했습니다', g: ['선생님', '감사합니다'], past: true },
  { s: '친구 2명이 왔다', g: ['친구', '#none', '오다'], past: true },
  { s: '안녕히 가세요', g: ['안녕하세요', '가다'] },
  { s: '우리 가족은 셋입니다', g: ['우리', '가족', '셋'] },
  { s: '반가운 친구를 만나고 싶어요', g: ['반갑다', '친구', '만나다', '원하다'] },
  { s: '엄마랑 아빠도 학교에서 공부했다', g: ['엄마', '아빠', '학교', '공부하다'], past: true },
  { s: '친구를 만나요', g: ['친구', '만나다'], question: false, past: false },
  { s: '어머니는 선생님입니다', g: ['엄마', '선생님'], question: false },
  { s: '물 마셨어?', g: ['물', '마시다'], past: true, question: true },
  { s: '내가 갈게요', g: ['나', '가다'] },
  { s: '지금 뭘 배워요?', g: ['오늘', '무엇', '공부하다'], question: true },
  { s: '', g: [] },
];

// 토큰 → 비교용 문자열
export function tokenLabel(t) {
  if (t.type === 'fingerspell') return '#fs:' + t.text;
  if (t.type === 'none' || !t.entry) return '#none';
  return t.entry.word;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 모든 테스트 실행 → [{ group, name, pass, expected, actual }]
export function runTests(words) {
  const index = buildIndex(words);
  const results = [];
  const check = (group, name, actual, expected) => {
    results.push({ group, name, pass: same(actual, expected), expected: JSON.stringify(expected), actual: JSON.stringify(actual) });
  };

  // 1) 문장 → 글로스
  for (const c of SENTENCE_CASES) {
    const r = gloss(c.s, index, c.opt);
    const actual = { g: r.tokens.map(tokenLabel) };
    const expected = { g: c.g };
    if (c.past !== undefined) { actual.past = r.isPast; expected.past = c.past; }
    if (c.question !== undefined) { actual.question = r.isQuestion; expected.question = c.question; }
    const name = `"${c.s}"` + (c.opt && c.opt.addCompletion ? ' (끝 붙이기)' : '');
    check('문장', name, actual, expected);
  }

  // 2) 글로스 결과 형식
  {
    const r = gloss('철수는 학교친구를 만났어요?', index, { addCompletion: true });
    check('형식', '토큰 type 순서', r.tokens.map((t) => t.type), ['fingerspell', 'split', 'split', 'form', 'marker']);
    check('형식', '지문자 자모', r.tokens[0].jamo, ['ㅊ', 'ㅓ', 'ㄹ', 'ㅅ', 'ㅜ']);
    check('형식', '쪼갠 토큰은 같은 어절(surface)을 공유', [r.tokens[1].surface, r.tokens[2].surface, r.tokens[1].text, r.tokens[2].text], ['학교친구를', '학교친구를', '학교', '친구']);
    check('형식', '후보는 배열, 최대 5개, 자기 자신 제외', r.tokens.every((t) => Array.isArray(t.candidates) && t.candidates.length <= 5 && !t.candidates.includes(t.entry)), true);
    check('형식', '의문문·과거 안내 문구가 있음', [r.notes.some((n) => n.includes('눈썹')), r.notes.some((n) => n.includes('끝(완료)'))], [true, true]);
    check('형식', "매칭 방식: 나→exact, 저→form, 죄송하다→synonym, 좋았다→rule", ['나', '저', '죄송하다', '좋았다'].map((w) => gloss(w, index).tokens[0].type), ['exact', 'form', 'synonym', 'rule']);
    check('형식', '못 찾음(type none)은 entry가 null', (() => { const t = gloss('ABC', index).tokens[0]; return [t.type, t.entry]; })(), ['none', null]);
  }

  // 3) lookupWord
  const lw = (t) => { const h = lookupWord(t, index); return h ? h.entry.word + '/' + h.type : null; };
  check('낱말 찾기', 'lookupWord 여러 꼴', ['학교', '먹었어요', '벗', '갔습니다', '친구를', '스마트워치'].map(lw), ['학교/exact', '먹다/form', '친구/form', '가다/rule', '친구/exact', null]);

  // 4) 어미 규칙 (기본형 후보)
  const lemmaCases = [
    ['반가워요', '반갑다'], ['마셔', '마시다'], ['와요', '오다'], ['가요', '가다'], ['했어요', '하다'], ['해요', '하다'],
    ['먹었습니다', '먹다'], ['갑니다', '가다'], ['슬펐다', '슬프다'], ['몰라요', '모르다'], ['걸어요', '걷다'],
    ['그래요', '그렇다'], ['삽니다', '살다'], ['먹으면', '먹다'], ['좋지만', '좋다'], ['오셨어요', '오다'], ['도와서', '돕다'], ['배웠어요', '배우다'],
  ];
  for (const [form, lemma] of lemmaCases) {
    check('어미 규칙', `${form} → ${lemma}`, lemmaCandidates(form).includes(lemma), true);
  }

  // 5) 조사 떼기
  const sp = (w, known) => { const r = stripParticle(w, known); return r.stem + '|' + r.particle; };
  const particleCases = [
    ['나는', '나|는'], ['학교에서', '학교|에서'], ['친구를', '친구|를'], ['밥을', '밥|을'], ['엄마한테', '엄마|한테'],
    ['선생님께', '선생님|께'], ['집으로', '집|으로'], ['학교로', '학교|로'], ['친구랑', '친구|랑'], ['동생이랑', '동생|이랑'],
    ['내일부터', '내일|부터'], ['오늘까지', '오늘|까지'], ['엄마의', '엄마|의'], ['학교에서는', '학교|에서는'], ['철수입니다', '철수|입니다'],
    ['아이', '아이|'], ['나이', '나이|'], ['고양이', '고양이|'], ['고양이가', '고양이|가'], ['가', '가|'], ['이', '이|'], ['사과', '사과|'],
  ];
  for (const [w, exp] of particleCases) check('조사 떼기', w, sp(w), exp);
  check('조사 떼기', '사전 지식 우선: 네가 (known)', sp('네가', index.known), '네가|');
  check('조사 떼기', '사전 지식 우선: 가는 (known)', sp('가는', index.known), '가는|');
  check('조사 떼기', '사전 지식 우선: 친구들과 (known)', sp('친구들과', index.known), '친구들|과');

  // 6) 정리 · 어절 · 토큰
  check('정리', 'normalize', normalize('  안녕하세요!  만나서,   반갑습니다. '), '안녕하세요 만나서 반갑습니다');
  check('정리', 'splitEojeol', splitEojeol('나는 학교에 "갔어요"?'), ['나는', '학교에', '갔어요']);
  check('정리', 'splitEojeol 빈 문장', splitEojeol('  ?! '), []);
  check('정리', 'tokenize', tokenize('나는 물을 마셔요'), [
    { surface: '나는', stem: '나', particle: '는' },
    { surface: '물을', stem: '물', particle: '을' },
    { surface: '마셔요', stem: '마셔', particle: '요' },
  ]);

  // 7) 의문 · 과거 감지
  const featureCases = [
    ['밥 먹었어요?', true, true], ['학교에 갑니까', true, false], ['같이 갈까요', true, false], ['어디 가니', true, false],
    ['뭐 먹어', true, false], ['밥을 먹나요', true, false], ['선생님인가요', true, false], ['이름이 뭐예요', true, false],
    ['학교에 가요', false, false], ['친구를 만나요', false, false], ['아니', false, false], ['우리 어머니', false, false],
    ['비가 오니까', false, false], ['재미있어요', false, false], ['가겠습니다', false, false], ['재미있었어요', false, true],
    ['어제 학교에 갔다', false, true], ['공부했습니다', false, true], ['무엇을 먹을지 모르겠어요.', false, false], ['언제나 좋아요', false, false],
  ];
  for (const [s, q, p] of featureCases) check('의문·과거', s, detectFeatures(s), { isQuestion: q, isPast: p });

  // 8) 지문자 분해
  check('지문자', "decomposeSyllable('각')", decomposeSyllable('각'), ['ㄱ', 'ㅏ', 'ㄱ']);
  check('지문자', "decomposeSyllable('가')", decomposeSyllable('가'), ['ㄱ', 'ㅏ']);
  check('지문자', '겹받침 나누기: 닭', decompose('닭'), ['ㄷ', 'ㅏ', 'ㄹ', 'ㄱ']);
  check('지문자', '겹받침 나누기: 값 없음', decompose('값 없음'), ['ㄱ', 'ㅏ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅓ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅡ', 'ㅁ']);
  check('지문자', '쌍자음·겹모음은 그대로: 꽈배기', decompose('꽈배기'), ['ㄲ', 'ㅘ', 'ㅂ', 'ㅐ', 'ㄱ', 'ㅣ']);
  check('지문자', '쌍받침은 그대로: 갔 밖', decompose('갔밖'), ['ㄱ', 'ㅏ', 'ㅆ', 'ㅂ', 'ㅏ', 'ㄲ']);
  check('지문자', '한글 아닌 글자 건너뛰기', decompose('A철1수!'), ['ㅊ', 'ㅓ', 'ㄹ', 'ㅅ', 'ㅜ']);
  check('지문자', '자음 19개 · 모음 21개', [CONSONANTS.length, VOWELS.length], [19, 21]);
  check('지문자', '모든 한글 음절이 데이터 있는 자모로만 분해됨', (() => {
    const ok = new Set([...CONSONANTS, ...VOWELS]);
    for (let c = 0xAC00; c <= 0xD7A3; c++) for (const j of decomposeSyllable(String.fromCharCode(c))) if (!ok.has(j)) return false;
    return true;
  })(), true);
  check('지문자', 'jamoSignPath', jamoSignPath('ㄱ'), 'fingerspelling/ㄱ.json');

  return results;
}

// 요약
export function summarize(results) {
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed };
}
