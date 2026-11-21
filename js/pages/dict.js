// 사전 검색 화면
import { h, clear, verifiedBadge, levelDots, wordHref } from '../ui.js';
import { loadWords } from '../data.js';
import { searchWords, categoriesOf } from '../dict/search.js';
import { isStudying } from '../learn/progress.js';
import { hasOwnSign } from '../sentence/clips.js';

export async function render(root, ctx) {
  const { list } = await loadWords();
  const q0 = ctx.query.get('q') || '';
  let category = ctx.query.get('cat') || '';
  let level = Number(ctx.query.get('lv') || 0);
  let status = ctx.query.get('st') || ''; // '' | 'has' | 'missing'

  const input = h('input.input', {
    type: 'search', value: q0, placeholder: '단어 검색 (초성도 돼요: ㄱㅅ)',
    'aria-label': '단어 검색', autocomplete: 'off', enterkeyhint: 'search',
  });
  const catChips = h('div.chips.scroll', { role: 'group', 'aria-label': '카테고리' });
  const lvChips = h('div.chips', { role: 'group', 'aria-label': '난이도' });
  const stChips = h('div.chips', { role: 'group', 'aria-label': '동작 상태' });
  const count = h('p.muted.small', { 'aria-live': 'polite' });
  const results = h('div.word-list');

  function chip(label, on, onClick) {
    return h('button.chip', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), onclick: onClick }, label);
  }

  function renderFilters() {
    clear(catChips).append(
      chip('전체', !category, () => { category = ''; update(); }),
      ...categoriesOf(list).map((c) => chip(c, category === c, () => { category = category === c ? '' : c; update(); })),
    );
    clear(lvChips).append(
      chip('모든 난이도', !level, () => { level = 0; update(); }),
      ...[1, 2, 3, 4, 5].filter((n) => list.some((w) => w.level === n)).map((n) => chip(`난이도 ${n}`, level === n, () => { level = level === n ? 0 : n; update(); })),
    );
    const missing = list.filter((w) => !hasOwnSign(w)).length;
    clear(stChips).append(
      chip('동작 전체', !status, () => { status = ''; update(); }),
      chip(`동작 있음 ${list.length - missing}`, status === 'has', () => { status = status === 'has' ? '' : 'has'; update(); }),
      chip(`녹화 필요 ${missing}`, status === 'missing', () => { status = status === 'missing' ? '' : 'missing'; update(); }),
    );
  }

  function update() {
    renderFilters();
    const q = input.value;
    const found = searchWords(list, q, { category, level })
      .filter(({ entry }) => !status || (status === 'has') === hasOwnSign(entry));
    count.textContent = q.trim() ? `"${q.trim()}" 검색 결과 ${found.length}개` : `단어 ${found.length}개`;
    clear(results);
    if (!found.length) {
      results.append(h('div.card', h('p', '찾는 단어가 없어요.'), h('a', { href: `#/sentence?q=${encodeURIComponent(q)}` }, '문장 → 수어에서 지문자로 보기 →')));
    }
    for (const { entry, via } of found) {
      results.append(h('a.card.word-card', { href: wordHref(entry.word) },
        h('h3', entry.word),
        h('p', entry.meaning),
        h('div.meta',
          h('span.badge.plain', entry.category),
          levelDots(entry.level),
          via && via !== entry.word ? h('span.badge.info', via === '뜻' ? '뜻에서 찾음' : `“${via}”`) : null,
          isStudying(entry.word) ? h('span.badge.ok', '학습 중') : null,
          !hasOwnSign(entry) ? h('span.badge.warn', { title: '동작 녹화 전이라 지문자로 보여 줘요' }, '지문자') : null,
          entry.verified ? verifiedBadge(entry) : null,
        ),
      ));
    }
    // 주소에 검색 상태 남기기 (뒤로 가기 대비)
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (category) params.set('cat', category);
    if (level) params.set('lv', level);
    if (status) params.set('st', status);
    const hash = '#/dict' + (params.toString() ? '?' + params.toString() : '');
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  input.addEventListener('input', update);
  root.append(
    h('div.stack',
      h('h1', '수어 사전'),
      h('div.search-box', input),
      catChips,
      lvChips,
      stChips,
      count,
      results,
    ),
  );
  update();
  if (!q0 && matchMedia('(min-width: 760px)').matches) input.focus();
}
