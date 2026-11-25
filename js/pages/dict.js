// 사전 검색 화면
import { h, clear, verifiedBadge, levelDots, wordHref } from '../ui.js';
import { loadWords, loadReview, signKind } from '../data.js';
import { searchWords, categoriesOf } from '../dict/search.js';
import { isStudying } from '../learn/progress.js';
import { hasOwnSign } from '../sentence/clips.js';

export async function render(root, ctx) {
  const [{ list }, review] = await Promise.all([loadWords(), loadReview()]);
  const q0 = ctx.query.get('q') || '';
  let category = ctx.query.get('cat') || '';
  let level = Number(ctx.query.get('lv') || 0);
  let status = ctx.query.get('st') || ''; // '' | 'dict' | 'guess' | 'check' | 'missing'
  // 동작 근거로 거르기: 사전 기반 / 추정 / 확인 필요(영상과 비교할 단어) / 녹화 필요(동작 없음)
  const statusOf = {
    dict: (w) => signKind(w) === 'dict' || signKind(w) === 'recorded',
    guess: (w) => signKind(w) === 'guess',
    check: (w) => review.has(w.word) || signKind(w) === 'guess',
    missing: (w) => !hasOwnSign(w),
  };

  const input = h('input.input', {
    type: 'search', value: q0, placeholder: '단어 또는 초성(ㄱㅅ) 검색',
    'aria-label': '단어 검색', autocomplete: 'off', enterkeyhint: 'search',
  });
  const catChips = h('div.chips.scroll.cat-chips', { role: 'group', 'aria-label': '분류' });
  const lvChips = h('div.chips.scroll', { role: 'group', 'aria-label': '난이도' });
  const stChips = h('div.chips.scroll', { role: 'group', 'aria-label': '동작 상태' });
  const count = h('p.muted.small.result-count', { 'aria-live': 'polite' });
  const results = h('div.word-list');
  const moreRow = h('div.more-row', { hidden: true });
  // 단어가 많아도 화면이 무거워지지 않게 나눠서 보여 준다
  const PAGE = 120;
  let shown = PAGE;
  let lastKey = '';

  function chip(label, on, onClick, n) {
    return h('button.chip', { type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on), onclick: onClick },
      label, n === undefined ? null : h('span.chip-count', n));
  }

  // 난이도·동작 필터는 "필터" 버튼 안에 접어 둔다 (켜져 있으면 처음부터 펼침)
  const extra = h('div.filter-extra', { id: 'dict-filter-extra', hidden: !(level || status) });
  const filterBtn = h('button.btn.small.filter-btn', {
    type: 'button', 'aria-controls': 'dict-filter-extra',
    onclick: () => { extra.hidden = !extra.hidden; renderFilters(); },
  });

  function renderFilters() {
    const active = (level ? 1 : 0) + (status ? 1 : 0);
    filterBtn.replaceChildren(...[
      h('span', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>' }),
      '필터',
      active ? h('span.filter-count', String(active)) : null,
    ].filter(Boolean));
    filterBtn.setAttribute('aria-expanded', String(!extra.hidden));
    filterBtn.setAttribute('aria-label', `난이도·동작 필터${active ? ` (${active}개 켜짐)` : ''}`);
    filterBtn.classList.toggle('on', !extra.hidden || active > 0);
    clear(catChips).append(
      chip('전체', !category, () => { category = ''; update(); }),
      ...categoriesOf(list).map((c) => chip(c, category === c, () => { category = category === c ? '' : c; update(); })),
    );
    clear(lvChips).append(
      chip('전체', !level, () => { level = 0; update(); }),
      ...[1, 2, 3, 4, 5].filter((n) => list.some((w) => w.level === n)).map((n) => chip(`난이도 ${n}`, level === n, () => { level = level === n ? 0 : n; update(); })),
    );
    const n = (k) => list.filter(statusOf[k]).length;
    const st = (k, label) => chip(label, status === k, () => { status = status === k ? '' : k; update(); }, n(k));
    clear(stChips).append(
      chip('전체', !status, () => { status = ''; update(); }),
      st('dict', '사전 기반'),
      st('guess', '추정 동작'),
      st('check', '확인 필요'),
      n('missing') ? st('missing', '녹화 필요') : '',
    );
  }

  function update() {
    renderFilters();
    const q = input.value;
    const found = searchWords(list, q, { category, level })
      .filter(({ entry }) => !status || !statusOf[status] || statusOf[status](entry));
    count.textContent = q.trim() ? `"${q.trim()}" 검색 결과 ${found.length}개` : `단어 ${found.length}개`;
    clear(results);
    if (!found.length) {
      results.append(h('div.empty',
        h('span.state-ico', { 'aria-hidden': 'true' }, '🔎'),
        h('strong', '찾는 단어가 없어요'),
        h('p.muted.small', q.trim() ? '철자를 확인하거나 필터를 풀어 보세요. 사전에 없는 말은 지문자로 볼 수 있어요.' : '필터를 풀어 보세요.'),
        q.trim() ? h('a.btn.small.primary', { href: `#/sentence?q=${encodeURIComponent(q.trim())}` }, '지문자로 보기 →') : null,
      ));
    }
    // 검색 조건이 바뀌면 처음 묶음부터 다시
    const key = [q.trim(), category, level, status].join('|');
    if (key !== lastKey) { lastKey = key; shown = PAGE; }
    const rest = found.length - shown;
    clear(moreRow);
    moreRow.hidden = rest <= 0;
    if (rest > 0) {
      moreRow.append(h('button.btn', { type: 'button', onclick: () => { shown += PAGE; update(); } }, `더 보기 (남은 ${rest}개)`));
    }
    for (const { entry, via } of found.slice(0, shown)) {
      results.append(h('a.card.word-card', { href: wordHref(entry.word) },
        h('h3', entry.word),
        h('p', entry.meaning),
        h('div.meta',
          h('span.badge.plain', entry.category),
          levelDots(entry.level),
          via && via !== entry.word ? h('span.badge.info', via === '뜻' ? '뜻에서 찾음' : `“${via}”`) : null,
          isStudying(entry.word) ? h('span.badge.ok', '학습 중') : null,
          !hasOwnSign(entry) ? h('span.badge.warn', { title: '동작 녹화 전이라 지문자로 보여 줘요' }, '지문자') : null,
          signKind(entry) === 'guess' ? h('span.badge.warn', { title: '사전에 항목이 없어 추정해 만든 동작' }, '추정') : null,
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

  extra.append(
    h('div.filter-row', h('span.filter-label', { 'aria-hidden': 'true' }, '난이도'), lvChips),
    h('div.filter-row', h('span.filter-label', { 'aria-hidden': 'true' }, '동작'), stChips),
  );
  input.addEventListener('input', update);
  root.append(
    h('div.stack',
      h('div.page-head', h('h1', '수어 사전'), h('p', `한국수어 단어 ${list.length}개를 3D 동작으로 찾아보세요.`)),
      h('section.card.filters', { 'aria-label': '검색과 필터' },
        h('div.search-row', h('div.search-box', input), filterBtn),
        catChips,
        extra,
      ),
      count,
      results,
      moreRow,
    ),
  );
  update();
  if (!q0 && matchMedia('(min-width: 760px)').matches) input.focus();
}
