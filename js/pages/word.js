// 단어 상세: 뷰어 + 뜻 + 동작 설명 + 손모양 + 비수지 신호 + 검수 배지
import { h, verifiedBadge, levelDots, toast, wordHref, errorView } from '../ui.js';
import { loadWords } from '../data.js';
import { entryClip, hasOwnSign } from '../sentence/clips.js';
import { createViewerBlock } from '../viewer/widget.js';
import { addToStudy, removeFromStudy, isStudying } from '../learn/progress.js';

export async function render(root, ctx) {
  const { list, byWord } = await loadWords();
  const word = ctx.params.word;
  const entry = byWord.get(word) || list.find((w) => w.forms?.includes(word) || w.synonyms?.includes(word));
  if (!entry) {
    root.append(errorView(`"${word}"은(는) 사전에 없어요.`), h('p', h('a', { href: '#/dict' }, '← 사전으로')));
    return;
  }
  if (entry.word !== word) { location.replace(wordHref(entry.word)); return; }

  const block = createViewerBlock(ctx, { keyboard: true });
  const studyBtn = h('button.btn', { type: 'button' });
  const syncStudy = () => {
    const on = isStudying(entry.word);
    studyBtn.textContent = on ? '✓ 학습 목록에 있음' : '＋ 학습 목록에 추가';
    studyBtn.className = 'btn ' + (on ? '' : 'primary');
    studyBtn.setAttribute('aria-pressed', String(on));
  };
  studyBtn.addEventListener('click', () => {
    if (isStudying(entry.word)) {
      removeFromStudy(entry.word);
      toast('학습 목록에서 뺐어요.');
    } else {
      addToStudy(entry.word);
      toast('학습 목록에 추가했어요. 오늘 복습에 나와요!', { type: 'good' });
    }
    syncStudy();
  });
  syncStudy();

  const idx = list.indexOf(entry);
  const prev = list[idx - 1];
  const next = list[idx + 1];

  const info = h('dl.info-list',
    h('dt', '뜻'), h('dd', entry.meaning),
    h('dt', '품사'), h('dd', entry.pos),
    h('dt', '동작'), h('dd', entry.description || (hasOwnSign(entry) ? '—' : '아직 녹화 전 (지문자로 표시)')),
    h('dt', '손모양'), h('dd', entry.handshape || '—'),
    h('dt', '비수지 신호'), h('dd', entry.nonManual || '없음'),
    entry.forms?.length ? [h('dt', '활용형'), h('dd', entry.forms.join(', '))] : null,
    entry.synonyms?.length ? [h('dt', '같은 수어'), h('dd', entry.synonyms.join(', '))] : null,
  );

  root.append(
    h('div.stack',
      h('div.row',
        h('a.btn.small.ghost', { href: '#/dict' }, '← 사전'),
        h('span.spacer'),
        prev ? h('a.btn.small', { href: wordHref(prev.word), 'aria-label': `이전 단어 ${prev.word}` }, `‹ ${prev.word}`) : null,
        next ? h('a.btn.small', { href: wordHref(next.word), 'aria-label': `다음 단어 ${next.word}` }, `${next.word} ›`) : null,
      ),
      h('div.grid-2',
        h('div', block.el),
        h('div.stack',
          h('div',
            h('div.row', h('span.badge.plain', entry.category), levelDots(entry.level), verifiedBadge(entry)),
            h('h1.big-word', { style: { marginTop: '8px' } }, entry.word),
          ),
          h('div.card', info),
          studyBtn,
          !hasOwnSign(entry)
            ? h('p.notice.small', h('b', '동작 녹화 필요'), ' — 이 단어의 수어 동작은 아직 녹화되지 않아서 지문자로 보여 주고 있어요. ', h('a', { href: 'recorder.html?word=' + encodeURIComponent(entry.word) }, '지금 녹화하기 →'))
            : entry.signStatus === 'placeholder'
              ? h('p.notice.small', h('b', '임시 동작'), ' — 기능 시험용으로 만든 가짜 동작이라 실제 한국수어와 달라요. ', h('a', { href: 'recorder.html?word=' + encodeURIComponent(entry.word) }, '진짜 동작 녹화하기 →'))
              : !entry.verified ? h('p.notice.small', '검수 전 데이터예요. 학습 참고용으로만 써 주세요.') : null,
        ),
      ),
    ),
  );

  try {
    const clip = await entryClip(entry);
    if (ctx.isCurrent()) block.viewer.setClip(clip);
  } catch (err) {
    block.el.prepend(h('p.notice', '동작 데이터를 불러오지 못했어요: ' + err.message));
  }
}
