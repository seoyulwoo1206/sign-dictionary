// 홈: 오늘의 학습, 스트릭, 바로가기
import { h } from '../ui.js';
import { loadCurriculum } from '../data.js';
import { getState, currentStreak, dueWords, GOALS, studiedToday } from '../learn/progress.js';
import { nextLesson } from '../learn/path.js';

export async function render(root) {
  const curriculum = await loadCurriculum();
  const s = getState();
  const goal = GOALS[s.goal] || GOALS.normal;
  const due = dueWords();
  const next = nextLesson(curriculum);
  const learned = Object.keys(s.words).length;
  const streak = currentStreak();

  const newPct = Math.min(100, (s.daily.newWords / goal.newWords) * 100);
  const reviewTarget = Math.max(due.length + s.daily.reviews, 1);
  const reviewPct = due.length === 0 && s.daily.reviews === 0 ? 0 : Math.min(100, (s.daily.reviews / reviewTarget) * 100);

  root.append(
    h('div.stack',
      h('section.card.hero',
        h('h1', streak > 0 ? `🔥 ${streak}일째 학습 중!` : '오늘 수어 한 단어 어때요?'),
        h('p', studiedToday() ? '오늘 학습 완료! 스트릭이 이어졌어요.' : '레슨 하나만 끝내도 스트릭이 이어져요.'),
        next
          ? h('a.btn.big', { href: `#/lesson/${next.id}`, 'aria-label': `이어서 학습: ${next.unit.title} – ${next.title}` },
            h('span.cta-ico', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>' }),
            h('span.cta-text', h('span', '이어서 학습'), h('small', `${next.unit.title} · ${next.title}`)))
          : h('a.btn.big', { href: '#/learn', style: { justifyContent: 'center' } }, '🎉 모든 레슨 완료! 다시 하기'),
      ),

      h('section.card',
        h('h2', '오늘의 목표'),
        h('div.stack',
          h('div.goal-row',
            h('span', '새 단어', h('small', `목표 ${goal.label}`)),
            h('div.progress', h('i', { style: { width: `${newPct}%` } })),
            h('b', `${s.daily.newWords}/${goal.newWords}`),
          ),
          h('div.goal-row',
            h('span', '복습'),
            h('div.progress.accent', h('i', { style: { width: `${reviewPct}%` } })),
            h('b', `${s.daily.reviews}/${s.daily.reviews + due.length}`),
          ),
        ),
        due.length
          ? h('a.btn.primary.block', { href: '#/review', style: { marginTop: '16px' } }, `🔁 오늘 복습할 단어 ${due.length}개`)
          : h('p.muted.small', { style: { marginTop: '14px', marginBottom: 0 } }, learned ? '오늘 복습할 단어가 없어요. 잘하고 있어요!' : '레슨을 끝내면 복습할 단어가 생겨요.'),
      ),

      h('section.stats', { 'aria-label': '학습 통계' },
        h('div.stat', h('b', `🔥 ${streak}`), h('span', '연속 학습일')),
        h('div.stat', h('b', `⭐ ${s.xp}`), h('span', '총 XP')),
        h('div.stat', h('b', `📚 ${learned}`), h('span', '배운 단어')),
      ),

      h('section.quick', { 'aria-label': '바로가기' },
        h('a.card', { href: '#/dict' }, h('span.q-ico', { 'aria-hidden': 'true' }, '📖'), '사전', h('small', '단어 검색')),
        h('a.card', { href: '#/sentence' }, h('span.q-ico', { 'aria-hidden': 'true' }, '💬'), '문장 → 수어', h('small', '이어서 보기')),
        h('a.card', { href: '#/learn' }, h('span.q-ico', { 'aria-hidden': 'true' }, '🗺️'), '학습 경로', h('small', '유닛 지도')),
      ),

      h('p.notice.small',
        '지금 들어 있는 동작은 기능 시험용 ', h('b', '임시 데이터'), '예요. 실제 한국수어와 다를 수 있으니 국립국어원 한국수어사전으로 확인하세요.'),
    ),
  );
}
