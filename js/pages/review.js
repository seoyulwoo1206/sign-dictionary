// 복습: 간격 반복 (오늘 복습할 단어)
import { h, clear, shuffle, playSound } from '../ui.js';
import { loadWords, preloadSigns } from '../data.js';
import { runExercise, answerBar, pickOptions } from '../learn/exercises.js';
import { dueWords, recordReview, completeReviewSession, currentStreak, getState } from '../learn/progress.js';
import { INTERVALS } from '../learn/srs.js';
import { entrySignPaths, hasOwnSign } from '../sentence/clips.js';

const MAX = 15;
const TYPES = ['sign2word', 'type', 'word2sign'];

export async function render(root, ctx) {
  const words = await loadWords();
  const due = dueWords().map((w) => words.byWord.get(w)).filter(Boolean).slice(0, MAX);

  if (!due.length) {
    const learned = Object.keys(getState().words).length;
    root.append(h('div.result.card',
      h('div.emoji', '✅'),
      h('h1', '오늘 복습할 단어가 없어요'),
      h('p.muted', learned ? '복습 날짜가 된 단어가 생기면 여기에 나와요.' : '레슨을 끝내거나 사전에서 "학습 목록에 추가"를 누르면 복습할 단어가 생겨요.'),
      h('div.actions',
        h('a.btn.primary.big', { href: '#/learn' }, '학습 경로로'),
        h('a.btn.big', { href: '#/' }, '홈으로'),
      ),
    ));
    return;
  }

  await preloadSigns(due.flatMap(entrySignPaths));
  const learnedPool = Object.keys(getState().words).map((w) => words.byWord.get(w)).filter(Boolean);
  const queue = shuffle(due).map((entry, i) => ({ type: hasOwnSign(entry) ? TYPES[i % TYPES.length] : 'type', entry, options: pickOptions(entry, words.list, 4, learnedPool), graded: false }));

  const bar = h('div.progress.accent', h('i', { style: { width: '0%' } }));
  const exitBtn = h('button.icon-btn', { type: 'button', 'aria-label': '복습 그만하기', onclick: () => { location.hash = '#/'; } }, '✕');
  const body = h('div.lesson-body');
  const answer = answerBar();
  root.append(h('div', h('div.lesson-top', exitBtn, bar, h('span.small.muted', `복습 ${due.length}개`)), body), answer.el);
  ctx.onCleanup(() => answer.el.remove());

  let correctFirst = 0;
  let done = 0;
  let total = queue.length;
  for (let i = 0; i < queue.length; i++) {
    const ex = queue[i];
    clear(body);
    const r = await runExercise(body, ex, { ctx, list: words.list }, answer);
    if (!r || !ctx.isCurrent()) return;
    // 처음 푼 결과만 간격 반복에 반영
    if (!ex.graded) {
      recordReview(ex.entry.word, r.correct);
      if (r.correct) correctFirst++;
    }
    if (!r.correct) {
      queue.push({ ...ex, graded: true, options: shuffle(ex.options) });
      total++;
    }
    done++;
    bar.firstChild.style.width = Math.round((done / total) * 100) + '%';
  }

  const res = completeReviewSession();
  playSound('complete');
  answer.el.remove();
  const s = getState();
  clear(body).append(h('div.result.card.pop',
    h('div.emoji', '🔁'),
    h('h1', '복습 완료!'),
    h('p.xp-earned', `${correctFirst}/${due.length} 정답`),
    res.streakUp ? h('p', `🔥 스트릭 ${currentStreak()}일!`) : null,
    h('p.muted.small', `맞힌 단어는 다음 박스로 (간격 ${INTERVALS.join('→')}일), 틀린 단어는 내일 다시 나와요.`),
    h('ul.result-list',
      due.map((w) => h('li', `${w.word} — ${s.words[w.word]?.box || 1}번 박스, 다음 복습 ${s.words[w.word]?.due || ''}`))),
    h('div.actions',
      h('a.btn.primary.big', { href: '#/' }, '홈으로'),
      h('a.btn.big', { href: '#/learn' }, '학습 경로로'),
    ),
  ));
}
