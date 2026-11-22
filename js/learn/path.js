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

// 지그재그 위치
const OFFSETS = [0, 46, 70, 46, 0, -46, -70, -46];

export async function render(root) {
  const c = await loadCurriculum();
  const s = getState();
  const next = nextLesson(c);
  let k = 0;

  const units = c.units.map((u) => {
    const unitLessons = c.lessons.filter((l) => l.unit === u);
    const done = unitLessons.filter((l) => s.lessons[l.id]).length;
    const unitLocked = !isUnlocked(c, unitLessons[0]);
    return h('section.unit', { class: unitLocked ? 'locked' : '', 'aria-label': `유닛 ${u.title}` },
      h('div.unit-head',
        h('div', h('small', `유닛 ${c.units.indexOf(u) + 1} · 난이도 ${u.level}`), h('h2', u.title)),
        h('span.badge.unit-count', { 'aria-label': `레슨 ${unitLessons.length}개 중 ${done}개 완료` }, `${done}/${unitLessons.length}`),
      ),
      h('div.path',
        unitLessons.map((l) => {
          const unlocked = isUnlocked(c, l);
          const rec = s.lessons[l.id];
          const isSentence = !!l.sentences;
          const icon = !unlocked ? '🔒' : rec ? '★' : isSentence ? '💬' : '✋';
          const offset = OFFSETS[k++ % OFFSETS.length];
          const label = `${l.title}${rec ? ' (완료, 다시 하기)' : unlocked ? '' : ' (잠김)'}`;
          const node = unlocked
            ? h('a.node', { href: `#/lesson/${l.id}`, class: [rec ? 'done' : '', next?.id === l.id ? 'current' : ''].join(' '), 'aria-label': label }, icon)
            : h('span.node.locked', { role: 'img', 'aria-label': label }, icon);
          return h('div.node-wrap', { style: { transform: `translateX(${offset}px)` } },
            node,
            h('span.node-label', l.title),
            h('span.node-stars', { 'aria-hidden': 'true' }, rec ? '★'.repeat(rec.stars) : ''),
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
  requestAnimationFrame(() => root.querySelector('.node.current')?.scrollIntoView({ block: 'center' }));
}
