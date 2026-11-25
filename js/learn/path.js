// 학습 경로 화면 (유닛 지도)
import { h } from '../ui.js';
import { loadCurriculum } from '../data.js';
import { getState, isLessonDone } from './progress.js';

// 앞 레슨을 끝내야 다음 레슨이 열린다
export function isUnlocked(curriculum, lesson) {
  if (lesson.order === 0) return true;
  return isLessonDone(curriculum.lessons[lesson.order - 1].id) || isLessonDone(lesson.id);
}

// 아직 안 끝낸 첫 레슨
export function nextLesson(curriculum) {
  return curriculum.lessons.find((l) => !isLessonDone(l.id)) || null;
}

export function lessonAfter(curriculum, id) {
  const l = curriculum.lessonById.get(id);
  return l ? curriculum.lessons[l.order + 1] || null : null;
}

// 유닛마다 색을 다르게 (CSS 의 --unit-c 로 넘긴다). 손 색(파랑·주황)과 겹치지 않는 색들.
const UNIT_COLORS = ['#0f766e', '#a16207', '#b4533a', '#4d7c0f', '#7c4d8a', '#2f6690', '#9f3a55'];

export async function render(root) {
  const c = await loadCurriculum();
  const s = getState();
  const next = nextLesson(c);

  const units = c.units.map((u, ui) => {
    const unitLessons = c.lessons.filter((l) => l.unit === u);
    const done = unitLessons.filter((l) => s.lessons[l.id]).length;
    const unitLocked = !isUnlocked(c, unitLessons[0]);
    const pct = Math.round((done / unitLessons.length) * 100);
    return h('section.unit', {
      class: [unitLocked ? 'locked' : '', done === unitLessons.length ? 'complete' : ''].join(' '),
      style: { '--unit-c': UNIT_COLORS[ui % UNIT_COLORS.length] },
      'aria-label': `유닛 ${ui + 1} ${u.title}`,
    },
      h('div.unit-head',
        h('div.unit-num', { 'aria-hidden': 'true' }, String(ui + 1)),
        h('div.unit-title', h('small', `유닛 ${ui + 1} · 난이도 ${u.level}`), h('h2', u.title)),
        h('div.unit-progress', { 'aria-label': `레슨 ${unitLessons.length}개 중 ${done}개 완료` },
          h('span', `${done}/${unitLessons.length}`),
          h('i', h('b', { style: { width: pct + '%' } })),
        ),
      ),
      h('ol.path',
        unitLessons.map((l) => {
          const unlocked = isUnlocked(c, l);
          const rec = s.lessons[l.id];
          const isSentence = !!l.sentences;
          const current = next?.id === l.id;
          const icon = !unlocked ? '🔒' : rec ? '★' : isSentence ? '💬' : '✋';
          const state = rec ? '완료' : current ? '지금 할 레슨' : unlocked ? '' : '잠김';
          const preview = isSentence ? l.sentences.map((x) => `“${x}”`).join(' · ') : (l.words || []).join(' · ');
          const label = `${l.title}${rec ? ' (완료, 다시 하기)' : unlocked ? '' : ' (잠김)'}: ${preview}`;
          const inner = [
            h('span.node', { 'aria-hidden': 'true' }, icon),
            h('span.lesson-info',
              h('span.lesson-title', l.title, state ? h('em', state) : null),
              h('span.lesson-words', preview),
              rec ? h('span.node-stars', { 'aria-hidden': 'true' }, '★'.repeat(rec.stars) + '☆'.repeat(Math.max(0, 3 - rec.stars))) : null,
            ),
          ];
          const cls = [rec ? 'done' : '', current ? 'current' : '', unlocked ? '' : 'locked'].join(' ');
          return h('li.lesson-row', { class: cls },
            unlocked
              ? h('a.lesson-link', { href: `#/lesson/${l.id}`, 'aria-label': label }, inner)
              : h('div.lesson-link', { 'aria-label': label, role: 'img' }, inner),
          );
        }),
      ),
    );
  });

  root.append(
    h('div',
      h('div.page-head',
        h('h1', '학습 경로'),
        h('p', '레슨 하나에 새 단어 3~5개. 앞 레슨을 끝내면 다음 레슨이 열려요.'),
      ),
      units,
    ),
  );
  // 지금 할 레슨으로 스크롤
  requestAnimationFrame(() => root.querySelector('.lesson-row.current')?.scrollIntoView({ block: 'center' }));
}
