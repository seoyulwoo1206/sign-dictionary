// 홈: 오늘의 학습, 스트릭, 바로가기
import { h, wordHref } from '../ui.js';
import { loadCurriculum, loadWords } from '../data.js';
import { getState, currentStreak, dueWords, GOALS, studiedToday, isEmptyProgress } from '../learn/progress.js';
import { nextLesson } from '../learn/path.js';
import { entryClip } from '../sentence/clips.js';
import { createViewerBlock } from '../viewer/widget.js';

// 오늘의 수어: 날짜마다 바뀌는 쉬운 단어 하나 (사전 항목이 있는 난이도 1~2 단어 중에서)
function wordOfDay(list) {
  const pool = list.filter((w) => w.sign && w.ref && (w.level || 1) <= 2);
  const from = pool.length ? pool : list.filter((w) => w.sign);
  const d = new Date();
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  return from[(day * 7919) % from.length];
}

function todaySignCard(ctx, entry) {
  const vb = createViewerBlock(ctx, { controls: false, small: true, interactive: false, legend: false, speed: 0.8 });
  entryClip(entry).then((clip) => { if (ctx.isCurrent()) vb.viewer.setClip(clip); }).catch(() => {});
  return h('section.card.today-sign', { 'aria-label': '오늘의 수어' },
    h('div.today-viewer', vb.el),
    h('div.today-text',
      h('span.step-tag', '오늘의 수어'),
      h('h2.today-word', entry.word),
      h('p.muted', entry.meaning),
      h('a.btn.small.primary', { href: wordHref(entry.word) }, '자세히 보기 →'),
    ),
  );
}

export async function render(root, ctx) {
  const [curriculum, { list }] = await Promise.all([loadCurriculum(), loadWords()]);
  const s = getState();
  // 처음 온 사람: 빈 목표·통계(0, 0/5…) 대신 오늘의 수어를 크게 보여 준다
  const fresh = isEmptyProgress(s);
  const today = wordOfDay(list);
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

      today ? todaySignCard(ctx, today) : null,

      fresh ? null : h('section.card',
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

      fresh ? null : h('section.stats', { 'aria-label': '학습 통계' },
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
        '동작은 국립국어원 한국수어사전의 ', h('b', '설명 글을 읽고 만든 3D 동작'), '이에요. 아직 농인 검수 전이라 실제 수어와 조금 다를 수 있으니, 단어 화면의 사전 영상 링크로 함께 확인하세요.'),
    ),
  );
}
