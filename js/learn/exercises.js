// 문제 유형별 UI
//  sign2word : 동작 보고 단어 고르기 (4지선다)
//  word2sign : 단어 보고 동작 고르기 (작은 뷰어 4개)
//  type      : 동작 보고 단어 직접 입력
//  orderSign : 문장 동작 보고 단어 카드 순서 맞추기
//  orderKo   : 한국어 문장 보고 수어 단어 카드 순서대로 배열하기
import { h, clear, shuffle, playSound } from '../ui.js';
import { mascot } from '../mascot.js';
import { createViewerBlock } from '../viewer/widget.js';
import { sentenceClip, tokenLabel, entryClip, hasOwnSign } from '../sentence/clips.js';

// 화면 하나 동안만 살아 있는 정리 목록
export function makeScope(parent) {
  const fns = [];
  const scope = {
    onCleanup: (fn) => fns.push(fn),
    dispose: () => { for (const fn of fns.splice(0)) { try { fn(); } catch (e) { console.error(e); } } },
  };
  parent?.onCleanup(scope.dispose);
  return scope;
}

// 보기 고르기: 같은 카테고리 단어를 우선해서 오답 섞기
export function pickOptions(entry, list, n = 4, pool = null) {
  const own = hasOwnSign(entry);
  const others = list.filter((w) => w.word !== entry.word && hasOwnSign(w) === own);
  const preferred = shuffle((pool || others).filter((w) => w.word !== entry.word && hasOwnSign(w) === own));
  const sameCat = shuffle(others.filter((w) => w.category === entry.category));
  const picked = [];
  for (const w of [...preferred, ...sameCat, ...shuffle(others)]) {
    if (picked.length >= n - 1) break;
    if (!picked.includes(w)) picked.push(w);
  }
  return shuffle([entry, ...picked]);
}

// ---------- 아래쪽 확인 바 ----------
export function answerBar() {
  const btn = h('button.btn.primary', { type: 'button', disabled: true }, '확인');
  const msg = h('div.msg');
  const el = h('div.feedback', { role: 'region', 'aria-label': '답 확인' }, h('div.feedback-inner', msg, btn));
  let resolve = null;
  btn.addEventListener('click', () => { if (resolve) { const r = resolve; resolve = null; r(); } });
  return {
    el,
    btn,
    setReady(ready) { btn.disabled = !ready; },
    // 확인 버튼 누를 때까지 대기
    waitCheck(label = '확인') {
      el.className = 'feedback';
      clear(msg);
      btn.textContent = label;
      btn.className = 'btn primary';
      return new Promise((r) => { resolve = r; });
    },
    // 결과 보여주고 '계속' 누를 때까지 대기
    showResult(correct, title, detail) {
      el.className = 'feedback ' + (correct ? 'good' : 'bad');
      clear(msg).append(h('div.fb-row',
        mascot(correct ? 'happy' : 'sad', { size: 54 }),
        h('div', h('strong', title), detail ? h('p', detail) : null)));
      msg.setAttribute('role', 'alert');
      btn.disabled = false;
      btn.textContent = '계속';
      btn.className = 'btn ' + (correct ? 'good' : 'bad');
      btn.focus({ preventScroll: true });
      return new Promise((r) => { resolve = r; });
    },
    // 결과 없이 버튼만 (학습 단계용)
    waitContinue(label = '계속', note = '') {
      el.className = 'feedback';
      clear(msg).append(note ? h('p.muted', note) : '');
      btn.disabled = false;
      btn.textContent = label;
      btn.className = 'btn primary';
      return new Promise((r) => { resolve = r; });
    },
    click() { if (!btn.disabled) btn.click(); },
  };
}

// ---------- 문제 실행 ----------
// env: { ctx, list }  반환: { correct, answer }
export async function runExercise(container, ex, env, bar) {
  const scope = makeScope(env.ctx);
  let ui;
  const onChange = () => bar.setReady(ui ? ui.ready() : false);
  ui = await BUILDERS[ex.type](ex, env, scope, onChange);
  if (!env.ctx.isCurrent()) { scope.dispose(); return null; }
  container.append(ui.el);
  ui.focus?.();

  const onKey = (e) => {
    if (e.target.closest('textarea')) return;
    if (/^Digit[1-9]$/.test(e.code) && ui.pick && !e.target.closest('input')) {
      ui.pick(Number(e.code.slice(5)) - 1);
    } else if (e.key === 'Enter' && !e.target.closest('button')) {
      e.preventDefault();
      bar.click();
    }
  };
  document.addEventListener('keydown', onKey);
  scope.onCleanup(() => document.removeEventListener('keydown', onKey));

  bar.setReady(false);
  await bar.waitCheck();
  const result = ui.check();
  ui.reveal(result);
  playSound(result.correct ? 'correct' : 'wrong');
  await bar.showResult(
    result.correct,
    result.correct ? pickPraise() : '아쉬워요!',
    result.correct ? result.detail || '' : `정답: ${result.answer}`,
  );
  scope.dispose();
  return result;
}

const PRAISES = ['정답이에요!', '잘했어요!', '훌륭해요!', '완벽해요!', '맞아요!'];
function pickPraise() { return PRAISES[Math.floor(Math.random() * PRAISES.length)]; }

function choiceButton(i, content, onClick, extraClass = '') {
  return h('button.choice', { type: 'button', class: extraClass, onclick: onClick, 'aria-pressed': 'false' },
    h('span.key', { 'aria-hidden': 'true' }, String(i + 1)), content);
}

// ---------- 유형별 ----------
const BUILDERS = {
  async sign2word(ex, env, scope, onChange) {
    const vb = createViewerBlock(scope, { compact: true, showViewTools: false, legend: false, speed: 0.75, keyboard: true });
    const clip = await entryClip(ex.entry);
    vb.viewer.setClip(clip);
    let sel = -1;
    const buttons = ex.options.map((w, i) => choiceButton(i, w.word, () => pick(i)));
    function pick(i) {
      if (i < 0 || i >= buttons.length || buttons[i].disabled) return;
      sel = i;
      buttons.forEach((b, k) => { b.classList.toggle('selected', k === i); b.setAttribute('aria-pressed', String(k === i)); });
      onChange();
    }
    const el = h('div.lesson-layout',
      h('div', vb.el),
      h('div',
        h('span.step-tag', '문제'),
        h('h2', '이 동작은 어떤 단어일까요?'),
        h('div.choices', { role: 'group', 'aria-label': '보기' }, buttons),
      ),
    );
    return {
      el, pick,
      ready: () => sel >= 0,
      check: () => ({ correct: ex.options[sel].word === ex.entry.word, answer: ex.entry.word }),
      reveal: (r) => {
        buttons.forEach((b, k) => {
          b.disabled = true;
          if (ex.options[k].word === ex.entry.word) b.classList.add('correct', 'pop');
          else if (k === sel && !r.correct) b.classList.add('wrong', 'shake');
        });
      },
    };
  },

  async word2sign(ex, env, scope, onChange) {
    let sel = -1;
    const buttons = [];
    const blocks = [];
    ex.options.forEach((w, i) => {
      const vb = createViewerBlock(scope, { controls: false, small: true, interactive: false, legend: false });
      blocks.push({ vb, w });
      buttons.push(h('button.choice.sign-choice', {
        type: 'button', 'aria-label': `보기 ${i + 1}`, 'aria-pressed': 'false', onclick: () => pick(i),
      }, h('span.key', { 'aria-hidden': 'true' }, String(i + 1)), vb.el));
    });
    await Promise.all(blocks.map(async ({ vb, w }) => vb.viewer.setClip(await entryClip(w))));
    function pick(i) {
      if (i < 0 || i >= buttons.length || buttons[i].disabled) return;
      sel = i;
      buttons.forEach((b, k) => { b.classList.toggle('selected', k === i); b.setAttribute('aria-pressed', String(k === i)); });
      onChange();
    }
    const el = h('div',
      h('span.step-tag', '문제'),
      h('h2', '이 단어의 동작을 고르세요'),
      h('p.big-word', { style: { marginBottom: '12px' } }, ex.entry.word),
      h('div.choices.cols-2', { role: 'group', 'aria-label': '보기' }, buttons),
    );
    return {
      el, pick,
      ready: () => sel >= 0,
      check: () => ({ correct: ex.options[sel].word === ex.entry.word, answer: `${ex.options.findIndex((w) => w.word === ex.entry.word) + 1}번 동작` }),
      reveal: (r) => {
        buttons.forEach((b, k) => {
          b.disabled = true;
          if (ex.options[k].word === ex.entry.word) b.classList.add('correct');
          else if (k === sel && !r.correct) b.classList.add('wrong', 'shake');
        });
        // 오답 보기 아래에 단어 이름 보여주기
        buttons.forEach((b, k) => b.append(h('span.small', ex.options[k].word)));
      },
    };
  },

  async type(ex, env, scope, onChange) {
    const vb = createViewerBlock(scope, { compact: true, showViewTools: false, legend: false, speed: 0.75, keyboard: false });
    vb.viewer.setClip(await entryClip(ex.entry));
    const input = h('input.input', { type: 'text', placeholder: '단어를 입력하세요', 'aria-label': '정답 입력', autocomplete: 'off', enterkeyhint: 'done' });
    input.addEventListener('input', onChange);
    const el = h('div.lesson-layout',
      h('div', vb.el),
      h('div',
        h('span.step-tag', '문제'),
        h('h2', '이 동작의 단어를 직접 써 보세요'),
        input,
        h('p.muted.small', { style: { marginTop: '8px' } }, `힌트: ${ex.entry.word.length}글자 · ${ex.entry.category}`),
      ),
    );
    const accept = new Set([ex.entry.word, ...(ex.entry.forms || []), ...(ex.entry.synonyms || [])].map((s) => s.replace(/\s/g, '')));
    return {
      el,
      focus: () => setTimeout(() => input.focus({ preventScroll: true }), 50),
      ready: () => input.value.trim().length > 0,
      check: () => {
        const v = input.value.replace(/\s/g, '');
        const correct = accept.has(v);
        return { correct, answer: ex.entry.word, detail: correct && v !== ex.entry.word ? `기본형: ${ex.entry.word}` : '' };
      },
      reveal: (r) => {
        input.disabled = true;
        input.style.borderColor = r.correct ? 'var(--good)' : 'var(--bad)';
        input.classList.add(r.correct ? 'pop' : 'shake');
      },
    };
  },

  orderSign: (ex, env, scope, onChange) => buildOrder(ex, env, scope, onChange, true),
  orderKo: (ex, env, scope, onChange) => buildOrder(ex, env, scope, onChange, false),
};

// 카드 순서 맞추기 (두 유형 공용)
async function buildOrder(ex, env, scope, onChange, showSign) {
  const target = ex.tokens.map(tokenLabel);
  const labels = shuffle([...target, ...(ex.distractors || [])]);
  const answer = [];
  const answerLine = h('div.answer-line', { 'aria-label': '내 답', role: 'list' });
  const bank = h('div.word-bank', { 'aria-label': '단어 카드' });
  const tiles = labels.map((label, i) => {
    const t = h('button.tile', { type: 'button', onclick: () => place(i) }, label);
    bank.append(t);
    return t;
  });
  function place(i) {
    if (answer.includes(i) || tiles[i].disabled) return;
    answer.push(i);
    tiles[i].classList.add('used');
    redraw();
  }
  function unplace(k) {
    const i = answer.splice(k, 1)[0];
    tiles[i].classList.remove('used');
    redraw();
  }
  function redraw() {
    clear(answerLine);
    answer.forEach((i, k) => answerLine.append(h('button.tile', { type: 'button', role: 'listitem', 'aria-label': `${labels[i]} 빼기`, onclick: () => unplace(k) }, labels[i])));
    onChange();
  }

  let viewerEl = null;
  if (showSign) {
    const vb = createViewerBlock(scope, { compact: true, showViewTools: false, legend: false, keyboard: false });
    const seq = await sentenceClip(ex.tokens);
    vb.viewer.setClip({ fps: seq.fps, frames: seq.frames });
    viewerEl = vb.el;
  }
  const question = showSign
    ? [h('h2', '문장 동작을 보고 단어 카드를 순서대로 놓으세요')]
    : [h('h2', '이 문장을 수어 단어 순서대로 놓으세요'), h('p.big-word.quote', `“${ex.sentence}”`)];

  const el = showSign
    ? h('div.lesson-layout', h('div', viewerEl), h('div', h('span.step-tag', '문장 문제'), question, answerLine, bank))
    : h('div', h('span.step-tag', '문장 문제'), question, answerLine, bank);

  return {
    el,
    pick: (i) => { const free = tiles.map((t, k) => k).filter((k) => !answer.includes(k)); if (free[i] !== undefined) place(free[i]); },
    ready: () => answer.length > 0,
    check: () => {
      const got = answer.map((i) => labels[i]);
      return { correct: got.join('|') === target.join('|'), answer: target.join(' → ') };
    },
    reveal: (r) => {
      tiles.forEach((t) => { t.disabled = true; });
      answerLine.querySelectorAll('.tile').forEach((t) => { t.disabled = true; });
      answerLine.style.borderColor = r.correct ? 'var(--good)' : 'var(--bad)';
      answerLine.classList.add(r.correct ? 'pop' : 'shake');
    },
  };
}
