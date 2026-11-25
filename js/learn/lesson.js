// 레슨 진행: 새 단어마다 보기 → 따라 하기, 끝에 문제를 섞어서 출제
import { h, clear, shuffle, playSound, errorView } from '../ui.js';
import { loadCurriculum, loadWords, preloadSigns } from '../data.js';
import { createViewerBlock } from '../viewer/widget.js';
import { runExercise, answerBar, makeScope, pickOptions } from './exercises.js';
import { completeLesson, currentStreak, getState } from './progress.js';
import { isUnlocked, lessonAfter } from './path.js';
import { gloss } from '../sentence/glosser.js';
import { getGlossIndex, sentenceClip, tokenLabel, TYPE_LABELS, entryClip, entrySignPaths } from '../sentence/clips.js';
import { jamoSignPath } from '../sentence/fingerspell.js';
import { mascot, resultMascot } from '../mascot.js';

const WORD_TYPES = ['sign2word', 'word2sign', 'type'];

export async function render(root, ctx) {
  const [c, words] = await Promise.all([loadCurriculum(), loadWords()]);
  const lesson = c.lessonById.get(ctx.params.id);
  if (!lesson) { root.append(errorView('레슨을 찾을 수 없어요.')); return; }
  if (!isUnlocked(c, lesson)) {
    root.append(h('div.empty', mascot('think', { size: 110 }), h('strong', '아직 잠겨 있어요'), h('p.muted', '앞 레슨을 먼저 끝내 주세요.'), h('a.btn.primary', { href: '#/learn' }, '학습 경로로')));
    return;
  }

  // ---------- 단계 만들기 ----------
  const steps = [];
  const quiz = [];
  let lessonWords = [];
  if (lesson.words) {
    lessonWords = lesson.words.map((w) => words.byWord.get(w)).filter(Boolean);
    // 지난 레슨에서 배운 단어를 보기 후보로 우선
    const learnedPool = c.lessons.slice(0, lesson.order + 1).flatMap((l) => l.words || []).map((w) => words.byWord.get(w)).filter(Boolean);
    lessonWords.forEach((entry) => {
      steps.push({ kind: 'learn', mode: 'watch', entry });
      steps.push({ kind: 'learn', mode: 'follow', entry });
    });
    const types = shuffle(lessonWords.map((_, i) => WORD_TYPES[i % WORD_TYPES.length]));
    lessonWords.forEach((entry, i) => {
      quiz.push({ type: types[i], entry, options: pickOptions(entry, words.list, 4, learnedPool) });
    });
    // 단어가 적으면 동작→단어 문제를 하나 더
    if (lessonWords.length <= 3) {
      const entry = lessonWords[Math.floor(Math.random() * lessonWords.length)];
      quiz.push({ type: 'sign2word', entry, options: pickOptions(entry, words.list, 4, learnedPool) });
    }
    await preloadSigns(lessonWords.flatMap(entrySignPaths));
  } else if (lesson.sentences) {
    const index = await getGlossIndex();
    const pastWords = c.lessons.slice(0, lesson.order).flatMap((l) => l.words || []);
    for (const sentence of lesson.sentences) {
      const g = gloss(sentence, index);
      const tokens = g.tokens.filter((t) => t.type !== 'none');
      steps.push({ kind: 'sentence', sentence, tokens, notes: g.notes });
      const labels = tokens.map(tokenLabel);
      const distractors = shuffle(pastWords.filter((w) => !labels.includes(w))).slice(0, 2);
      quiz.push({ type: 'orderSign', sentence, tokens, distractors: distractors.slice(0, 1) });
      quiz.push({ type: 'orderKo', sentence, tokens, distractors });
    }
    // 동작 미리 불러오기
    const paths = steps.flatMap((s) => s.tokens.flatMap((t) => (t.entry ? entrySignPaths(t.entry) : (t.jamo || []).map(jamoSignPath))));
    await preloadSigns(paths);
  }
  for (const q of shuffle(quiz)) steps.push({ kind: 'quiz', ex: q });

  // ---------- 화면 ----------
  let total = steps.length;
  let done = 0;
  let mistakes = 0;
  const bar = h('div.progress', { role: 'progressbar', 'aria-label': '레슨 진행', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: '0%' } }));
  const exitBtn = h('button.icon-btn', {
    type: 'button', 'aria-label': '레슨 그만하기',
    onclick: () => { if (confirm('레슨을 그만할까요? 진행 상황은 저장되지 않아요.')) location.hash = '#/learn'; },
  }, '✕');
  const body = h('div.lesson-body');
  const answer = answerBar();
  root.append(h('div', h('div.lesson-top', exitBtn, bar, h('span.small.muted', lesson.title)), body), answer.el);
  ctx.onCleanup(() => answer.el.remove());

  const setProgress = () => {
    const pct = Math.round((done / total) * 100);
    bar.firstChild.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', pct);
  };
  setProgress();

  const retry = [];
  for (let i = 0; i < steps.length; i++) {
    if (!ctx.isCurrent()) return;
    const step = steps[i];
    clear(body);
    if (step.kind === 'learn') {
      await learnStep(body, step, ctx, answer);
    } else if (step.kind === 'sentence') {
      await sentenceStep(body, step, ctx, answer);
    } else {
      const r = await runExercise(body, step.ex, { ctx, list: words.list }, answer);
      if (!r) return;
      if (!r.correct) {
        mistakes++;
        // 틀린 문제는 끝에 다시 (보기 순서는 새로 섞음)
        const again = { ...step.ex, options: step.ex.options ? shuffle(step.ex.options) : undefined };
        steps.push({ kind: 'quiz', ex: again });
        total++;
      }
    }
    if (!ctx.isCurrent()) return;
    done++;
    setProgress();
  }
  void retry;

  // ---------- 완료 ----------
  const perfect = mistakes === 0;
  const xpBefore = getState().xp;
  const res = completeLesson(lesson.id, { perfect, words: lessonWords.map((w) => w.word) });
  playSound('complete');
  answer.el.remove();
  const next = lessonAfter(c, lesson.id);
  const pet = resultMascot(perfect ? 'cheer' : 'happy', xpBefore);
  clear(body).append(
    h('div.result.card.pop',
      h('div.result-mascot', pet.el),
      h('h1', '레슨 완료!'),
      h('p.xp-earned', `+${res.xp} XP`),
      perfect ? h('p', '실수 없이 끝냈어요! 수달이가 신났어요. 보너스 +5 XP') : h('p.muted', `틀린 문제 ${mistakes}개 — 복습에서 다시 만나요.`),
      res.streakUp ? h('p', `🔥 스트릭 ${currentStreak()}일!`) : null,
      res.newWords ? h('p.muted', `새 단어 ${res.newWords}개가 복습 목록에 들어갔어요.`) : null,
      pet.note,
      h('div.actions',
        next ? h('a.btn.primary.big', { href: `#/lesson/${next.id}` }, `다음 레슨: ${next.title}`) : null,
        h('a.btn.big', { href: '#/learn' }, '학습 경로로'),
      ),
    ),
  );
}

// 새 단어: 보기(느리게) / 따라 하기(거울 모드)
async function learnStep(body, step, ctx, answer) {
  const scope = makeScope(ctx);
  const { entry, mode } = step;
  const follow = mode === 'follow';
  const vb = createViewerBlock(scope, { keyboard: true, mirror: follow, speed: follow ? 1 : 0.5 });
  vb.viewer.setClip(await entryClip(entry));
  body.append(
    h('div.titled-layout.lesson',
      h('div.tl-title',
        h('span.step-tag', follow ? '따라 하기 · 거울 모드' : '새 단어 · 보기'),
        h('h1.big-word', entry.word),
        h('p.tl-meaning', entry.meaning),
      ),
      h('div.tl-viewer', vb.el),
      h('div.tl-body',
        h('dl.info-list',
          h('dt', '동작'), h('dd', entry.description),
          h('dt', '손모양'), h('dd', entry.handshape || '—'),
          entry.nonManual ? [h('dt', '표정'), h('dd', entry.nonManual)] : null,
        ),
        follow
          ? h('p.notice.info.small', { style: { marginTop: '12px' } }, '거울처럼 좌우가 뒤집혀 있어요. 화면을 보며 그대로 따라 해 보세요.')
          : h('p.muted.small', { style: { marginTop: '12px' } }, '0.5배 속도로 천천히 재생 중이에요.'),
      ),
    ),
  );
  await answer.waitContinue(follow ? '✋ 따라 해봤어요' : '계속');
  scope.dispose();
}

// 문장 연습: 이어서 재생하며 단어 순서 익히기
async function sentenceStep(body, step, ctx, answer) {
  const scope = makeScope(ctx);
  const vb = createViewerBlock(scope, { keyboard: true });
  const seq = await sentenceClip(step.tokens);
  vb.viewer.setClip({ fps: seq.fps, frames: seq.frames });
  const cards = step.tokens.map((t) => h('div.gloss-card', h('b', tokenLabel(t)), h('span.badge.type', { class: 'type-' + t.type }, TYPE_LABELS[t.type] || t.type)));
  const off = vb.player.on((type, p) => {
    if (type !== 'time') return;
    let k = seq.segments.findIndex((s) => p.time <= s.end + 0.5);
    if (k < 0) k = seq.segments.length - 1;
    const active = seq.segments[k]?.index;
    cards.forEach((c, i) => c.classList.toggle('active', i === active));
  });
  scope.onCleanup(off);
  body.append(
    h('div.titled-layout.lesson',
      h('div.tl-title',
        h('span.step-tag', '문장 연습'),
        h('h1.big-word.quote', `“${step.sentence}”`),
        h('p.muted', '수어 단어 순서:'),
        h('div.gloss-cards', cards),
      ),
      h('div.tl-viewer', vb.el),
      h('div.tl-body',
        ...(step.notes || []).map((n) => h('p.notice.info.small', n)),
        h('p.notice.small', { style: { marginTop: '10px' } }, '한국수어는 한국어와 문법이 다른 독립된 언어예요. 여기서는 단어를 이어 표현하는 연습만 해요.'),
      ),
    ),
  );
  await answer.waitContinue('계속');
  scope.dispose();
}
