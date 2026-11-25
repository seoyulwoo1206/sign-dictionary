// 단어 상세: 뷰어 + 뜻 + 동작 설명 + 손모양 + 비수지 신호 + 검수 배지
import { h, verifiedBadge, levelDots, toast, wordHref, errorView } from '../ui.js';
import { loadWords, loadReview, signKind } from '../data.js';
import { entryClip, hasOwnSign } from '../sentence/clips.js';
import { createViewerBlock } from '../viewer/widget.js';
import { addToStudy, removeFromStudy, isStudying } from '../learn/progress.js';

// 국립국어원 한국수어사전 항목: 수형 설명 원문 + 영상 링크 (CC BY-NC-ND 2.0 KR, 원문 그대로 표시)
function refCard(ref) {
  return h('div.card.ref-card',
    h('h2.small-title', '국립국어원 한국수어사전'),
    ref.description ? h('p.small', h('b', '수형 설명 '), ref.description) : null,
    h('p.small', h('a', { href: ref.url, target: '_blank', rel: 'noopener' }, '▶ 사전에서 실제 영상 보기 ↗')),
    h('p.muted.tiny', '출처: 국립국어원 한국수어사전 (저작자표시-비영리-변경금지 2.0 대한민국). 3D 동작은 이 설명을 참고해 새로 만든 것이며 원본 영상이 아닙니다.'),
  );
}

export async function render(root, ctx) {
  const [{ list, byWord }, review] = await Promise.all([loadWords(), loadReview()]);
  const word = ctx.params.word;
  const entry = byWord.get(word) || list.find((w) => w.forms?.includes(word) || w.synonyms?.includes(word));
  if (!entry) {
    root.append(h('div.empty',
      h('span.state-ico', { 'aria-hidden': 'true' }, '🔎'),
      h('strong', `“${word}”은(는) 사전에 없어요`),
      h('p.muted', '사전에서 다시 찾거나, 문장 → 수어에서 지문자로 볼 수 있어요.'),
      h('div.row', { style: { justifyContent: 'center' } },
        h('a.btn.small.primary', { href: '#/dict' }, '사전으로'),
        h('a.btn.small', { href: `#/sentence?q=${encodeURIComponent(word)}` }, '지문자로 보기'),
      ),
    ));
    return;
  }
  if (entry.word !== word) { location.replace(wordHref(entry.word)); return; }

  const block = createViewerBlock(ctx, { keyboard: true });
  const studyBtn = h('button.btn', { type: 'button' });
  const syncStudy = () => {
    const on = isStudying(entry.word);
    studyBtn.textContent = on ? '✓ 학습 목록에 있음' : '＋ 학습 목록에 추가';
    studyBtn.className = 'btn block ' + (on ? '' : 'primary');
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
    h('dt', '품사'), h('dd', entry.pos),
    h('dt', '동작'), h('dd', entry.description || (hasOwnSign(entry) ? '—' : '아직 녹화 전 (지문자로 표시)')),
    h('dt', '손모양'), h('dd', entry.handshape || '—'),
    h('dt', '비수지 신호'), h('dd', entry.nonManual || '없음'),
    entry.forms?.length ? [h('dt', '활용형'), h('dd', entry.forms.join(', '))] : null,
    entry.synonyms?.length ? [h('dt', '같은 수어'), h('dd', entry.synonyms.join(', '))] : null,
  );

  root.append(
    h('div.stack',
      h('nav.word-top', { 'aria-label': '단어 이동' },
        h('a.btn.small.ghost', { href: '#/dict' }, '← 사전'),
        h('span.spacer'),
        prev ? h('a.btn.small', { href: wordHref(prev.word), 'aria-label': `이전 단어 ${prev.word}` }, '‹', h('span', prev.word)) : null,
        next ? h('a.btn.small', { href: wordHref(next.word), 'aria-label': `다음 단어 ${next.word}` }, h('span', next.word), '›') : null,
      ),
      // 휴대폰에서는 단어 이름 → 아바타 → 설명 순서, 넓은 화면에서는 왼쪽 아바타 / 오른쪽 이름·설명
      h('div.titled-layout',
        h('div.tl-title.word-title',
          h('div.row', h('span.badge.plain', entry.category), levelDots(entry.level), verifiedBadge(entry)),
          h('h1.big-word', entry.word),
          h('p.tl-meaning', entry.meaning),
        ),
        h('div.tl-viewer', block.el),
        h('div.tl-body.stack',
          h('div.card', info),
          entry.ref ? refCard(entry.ref) : null,
          studyBtn,
          !hasOwnSign(entry)
            ? h('p.notice.small', h('b', '동작 녹화 필요'), ' — 이 단어의 수어 동작은 아직 녹화되지 않아서 지문자로 보여 주고 있어요. ', h('a', { href: 'recorder.html?word=' + encodeURIComponent(entry.word) }, '지금 녹화하기 →'))
            : entry.signStatus === 'placeholder'
              ? h('p.notice.small', h('b', '임시 동작'), ' — 기능 시험용으로 만든 가짜 동작이라 실제 한국수어와 달라요. ', h('a', { href: 'recorder.html?word=' + encodeURIComponent(entry.word) }, '진짜 동작 녹화하기 →'))
              : signKind(entry) === 'guess'
                ? h('p.notice.small', h('b', '추정 동작'), ' — 국립국어원 한국수어사전에 이 단어 항목이 없어서, 사전에 있는 다른 수어를 이어 붙이거나 일반적으로 쓰는 표현으로 만든 동작이에요. 농인에게 확인받기 전까지는 참고용으로만 써 주세요.')
                : entry.signStatus === 'described'
                  ? h('p.notice.small', h('b', '설명 기반 동작'), ' — 국립국어원 한국수어사전의 수형 설명을 보고 만든 동작이에요. 실제 영상과 다를 수 있으니 위 링크의 영상과 꼭 비교해 보세요.')
                  : !entry.verified ? h('p.notice.small', '검수 전 데이터예요. 학습 참고용으로만 써 주세요.') : null,
          review.get(entry.word) ? h('p.notice.small', h('b', '확인 필요'), ' — ', review.get(entry.word)) : null,
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
