// 문장 → 수어 보조 화면
import { h, clear, toast, wordHref } from '../ui.js';
import { createViewerBlock } from '../viewer/widget.js';
import { segmentAt } from '../viewer/sequencer.js';
import { gloss, lookupWord } from './glosser.js';
import { decompose } from './fingerspell.js';
import { getGlossIndex, sentenceClip, tokenClip, tokenLabel, TYPE_LABELS } from './clips.js';

const EXAMPLES = ['나는 학교에 갔어요', '만나서 반갑습니다', '엄마가 밥을 먹었어요?', '친구가 물을 마셔요', '철수는 어디에 가요?'];
const DISCLAIMER = '한국수어는 한국어와 문법이 다른 독립된 언어입니다. 이 기능은 단어를 수어로 바꿔 나열해 표현을 돕는 보조 도구이며, 정확한 수어 번역이 아닙니다.';

export async function render(root, ctx) {
  const index = await getGlossIndex();
  let tokens = [];
  let notes = [];
  let flags = { isPast: false, isQuestion: false };
  let mode = 'all';      // all: 이어서 재생 / one: 하나씩
  let current = 0;       // 하나씩 모드의 현재 카드
  let pause = 6;         // 단어 사이 쉬는 프레임
  let seq = null;
  let buildId = 0;
  let addCompletion = ctx.query.get('done') === '1';

  const input = h('input.input', {
    type: 'text', placeholder: '한국어 문장을 입력하세요', 'aria-label': '문장 입력',
    value: ctx.query.get('q') || '', enterkeyhint: 'go', autocomplete: 'off',
  });
  const goBtn = h('button.btn.primary', { type: 'submit' }, '수어로');
  const form = h('form.sentence-input', { onsubmit: (e) => { e.preventDefault(); analyze(); } }, input, goBtn);
  const examples = h('div.chips.scroll', { 'aria-label': '예문' },
    EXAMPLES.map((ex) => h('button.chip', { type: 'button', onclick: () => { input.value = ex; analyze(); } }, ex)));

  const doneToggle = h('input', { type: 'checkbox', checked: addCompletion, 'aria-label': '과거형이면 끝(완료) 수어 붙이기' });
  doneToggle.addEventListener('change', () => { addCompletion = doneToggle.checked; if (input.value.trim()) analyze(); });

  const result = h('section.stack', { hidden: true });
  const notesBox = h('div');
  const cardsBox = h('div.gloss-cards', { role: 'list', 'aria-label': '수어 단어 카드' });
  const modeSeg = h('div.seg', { role: 'group', 'aria-label': '재생 방식' });
  const modeExtra = h('div.row');
  const block = createViewerBlock(ctx, { keyboard: true });
  block.player.setLoop(false);

  root.append(h('div.stack',
    h('h1', '문장 → 수어'),
    h('p.notice.disclaimer', { role: 'note' }, '⚠️ ', DISCLAIMER),
    form,
    examples,
    h('label.row.small', { style: { cursor: 'pointer' } }, doneToggle, '과거형이면 문장 끝에 "끝(완료)" 수어 붙이기'),
    result,
  ));
  result.append(
    notesBox,
    h('div',
      h('div.row', h('h2', { style: { margin: 0 } }, '수어 단어 순서'), h('span.spacer'), h('span.small.muted', '카드를 눌러 바꾸기 · 끌어서 순서 바꾸기')),
      cardsBox,
    ),
    h('div.row', modeSeg, h('span.spacer'), modeExtra),
    block.el,
    h('div.row',
      h('button.btn.small', { type: 'button', onclick: share }, '🔗 공유 링크 복사'),
      h('a.btn.small.ghost', { href: '#/dict' }, '📖 사전에서 찾기'),
    ),
  );

  // 재생 중인 카드 강조
  const off = block.player.on((type, p) => {
    if (type !== 'time' || mode !== 'all' || !seq) return;
    const k = segmentAt(seq, p.time);
    highlight(k >= 0 ? seq.segments[k].index : -1);
  });
  ctx.onCleanup(off);

  function highlight(i) {
    [...cardsBox.children].forEach((c, k) => {
      const on = k === i;
      if (on && !c.classList.contains('active')) c.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      c.classList.toggle('active', on);
    });
  }

  function analyze() {
    const q = input.value.trim();
    if (!q) { result.hidden = true; return; }
    const g = gloss(q, index, { addCompletion });
    tokens = g.tokens.map((t) => ({ ...t }));
    notes = g.notes || [];
    flags = { isPast: g.isPast, isQuestion: g.isQuestion };
    current = 0;
    result.hidden = false;
    const hash = `#/sentence?q=${encodeURIComponent(q)}${addCompletion ? '&done=1' : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    refresh();
  }

  function refresh() {
    drawNotes();
    drawCards();
    drawMode();
    rebuild();
  }

  function drawNotes() {
    clear(notesBox);
    const tags = [];
    if (flags.isQuestion) tags.push(h('span.badge.info', '의문문'));
    if (flags.isPast) tags.push(h('span.badge.info', '과거'));
    if (tags.length) notesBox.append(h('div.row', tags));
    for (const n of notes) notesBox.append(h('p.notice.info.small', { style: { marginTop: '8px' } }, n));
    const missing = tokens.filter((t) => t.type === 'none');
    if (missing.length) notesBox.append(h('p.notice.small', { style: { marginTop: '8px' } }, `표현하지 못한 부분: ${missing.map((t) => t.text || t.surface).join(', ')} (숫자·영문은 아직 지원하지 않아요)`));
  }

  // ---------- 카드 ----------
  let dragFrom = -1;
  function drawCards() {
    clear(cardsBox);
    tokens.forEach((t, i) => {
      const label = tokenLabel(t);
      const card = h('button.gloss-card', {
        type: 'button', role: 'listitem', draggable: 'true', class: 't-' + t.type,
        'aria-label': `${i + 1}번째 ${label}, ${TYPE_LABELS[t.type] || t.type}. 눌러서 바꾸기`,
        onclick: () => openMenu(i),
      },
        h('b', label),
        t.surface && t.surface !== label ? h('small', t.surface) : h('small', ' '),
        h('span.badge.type', { class: 'type-' + t.type }, TYPE_LABELS[t.type] || t.type),
      );
      card.addEventListener('dragstart', (e) => { dragFrom = i; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); dragFrom = -1; cardsBox.querySelectorAll('.drop-before').forEach((c) => c.classList.remove('drop-before')); });
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-before'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-before'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom < 0 || dragFrom === i) return;
        move(dragFrom, dragFrom < i ? i - 1 : i);
      });
      cardsBox.append(card);
    });
    // 맨 끝으로 놓기
    cardsBox.ondragover = (e) => e.preventDefault();
    cardsBox.ondrop = (e) => { if (e.target === cardsBox && dragFrom >= 0) move(dragFrom, tokens.length - 1); };
    if (mode === 'one') highlight(current);
  }

  function move(from, to) {
    if (to < 0 || to >= tokens.length || from === to) return;
    const [t] = tokens.splice(from, 1);
    tokens.splice(to, 0, t);
    if (mode === 'one') current = to;
    refresh();
  }

  function replace(i, entry, type) {
    tokens[i] = { ...tokens[i], entry, type, jamo: undefined, candidates: tokens[i].candidates || [] };
    if (entry) tokens[i].text = entry.word;
    refresh();
  }

  function openMenu(i) {
    const t = tokens[i];
    const backdrop = h('div.backdrop');
    const search = h('input.input', { type: 'text', placeholder: '다른 단어 찾기', 'aria-label': '바꿀 단어 검색', autocomplete: 'off' });
    const found = h('div.chips', { style: { marginTop: '8px' } });
    const close = () => { backdrop.remove(); pop.remove(); document.removeEventListener('keydown', onEsc); };
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    search.addEventListener('input', () => {
      clear(found);
      const q = search.value.trim();
      if (!q) return;
      const r = lookupWord(q, index);
      if (r?.entry) found.append(h('button.chip', { type: 'button', onclick: () => { replace(i, r.entry, r.type === 'exact' ? 'exact' : r.type); close(); } }, `${r.entry.word} (${TYPE_LABELS[r.type] || r.type})`));
      found.append(h('button.chip', { type: 'button', onclick: () => { tokens[i] = { ...t, entry: null, type: 'fingerspell', text: q, jamo: decompose(q) }; close(); refresh(); } }, `“${q}” 지문자로`));
    });
    const candidates = (t.candidates || []).filter((c) => c && c.word !== t.entry?.word);
    const pop = h('div.popover', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `${tokenLabel(t)} 카드 편집` },
      h('h3', `“${tokenLabel(t)}” 카드`),
      t.surface ? h('p.small.muted', `원래 어절: ${t.surface}`) : null,
      candidates.length ? [h('p.small', '다른 후보'), h('div.chips', candidates.map((c) => h('button.chip', { type: 'button', onclick: () => { replace(i, c, 'exact'); close(); } }, c.word)))] : null,
      h('div', { style: { marginTop: '12px' } }, search, found),
      h('div.row', { style: { marginTop: '14px' } },
        h('button.btn.small', { type: 'button', disabled: i === 0, onclick: () => { move(i, i - 1); close(); } }, '← 앞으로'),
        h('button.btn.small', { type: 'button', disabled: i === tokens.length - 1, onclick: () => { move(i, i + 1); close(); } }, '뒤로 →'),
        t.entry ? h('a.btn.small', { href: wordHref(t.entry.word) }, '사전') : null,
        h('span.spacer'),
        h('button.btn.small.bad', { type: 'button', onclick: () => { tokens.splice(i, 1); current = Math.min(current, tokens.length - 1); close(); refresh(); } }, '삭제'),
      ),
      h('button.btn.small.ghost', { type: 'button', style: { marginTop: '8px', width: '100%' }, onclick: close }, '닫기'),
    );
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onEsc);
    document.body.append(backdrop, pop);
    search.focus();
  }

  // ---------- 재생 방식 ----------
  function drawMode() {
    clear(modeSeg).append(
      h('button.pc-btn', { type: 'button', class: mode === 'all' ? 'on' : '', 'aria-pressed': String(mode === 'all'), onclick: () => { mode = 'all'; drawMode(); rebuild(); } }, '이어서 재생'),
      h('button.pc-btn', { type: 'button', class: mode === 'one' ? 'on' : '', 'aria-pressed': String(mode === 'one'), onclick: () => { mode = 'one'; current = 0; drawMode(); rebuild(); } }, '하나씩'),
    );
    clear(modeExtra);
    if (mode === 'all') {
      const slider = h('input', { type: 'range', min: 0, max: 30, step: 1, value: pause, 'aria-label': '단어 사이 쉬는 시간', style: { width: '120px', accentColor: 'var(--accent)' } });
      const val = h('span.small.muted', `${(pause / 30).toFixed(1)}초`);
      slider.addEventListener('input', () => { pause = Number(slider.value); val.textContent = `${(pause / 30).toFixed(1)}초`; });
      slider.addEventListener('change', rebuild);
      modeExtra.append(h('span.small', '쉬는 시간'), slider, val);
    } else {
      modeExtra.append(
        h('button.btn.small', { type: 'button', disabled: current <= 0, onclick: () => { current--; drawMode(); rebuild(); } }, '‹ 이전 단어'),
        h('span.small', `${Math.min(current + 1, tokens.length)} / ${tokens.length}`),
        h('button.btn.small.primary', { type: 'button', disabled: current >= tokens.length - 1, onclick: () => { current++; drawMode(); rebuild(); } }, '다음 단어 ›'),
      );
    }
  }

  async function rebuild() {
    const id = ++buildId;
    if (!tokens.length) { block.viewer.setClip(null); return; }
    if (mode === 'all') {
      const s = await sentenceClip(tokens, { pause });
      if (id !== buildId || !ctx.isCurrent()) return;
      seq = s;
      block.player.setLoop(false);
      block.viewer.setClip(s.frames.length ? { fps: s.fps, frames: s.frames } : null);
      if (!s.frames.length) toast('재생할 수 있는 동작이 없어요.');
    } else {
      seq = null;
      highlight(current);
      const clip = await tokenClip(tokens[current]).catch(() => null);
      if (id !== buildId || !ctx.isCurrent()) return;
      block.player.setLoop(true);
      block.viewer.setClip(clip);
      if (!clip) toast('이 카드는 동작이 없어요. 카드를 눌러 다른 단어로 바꿔 보세요.');
    }
  }

  async function share() {
    const url = location.href.split('#')[0] + `#/sentence?q=${encodeURIComponent(input.value.trim())}${addCompletion ? '&done=1' : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('링크를 복사했어요!', { type: 'good' });
    } catch {
      prompt('이 링크를 복사하세요', url);
    }
  }

  if (input.value.trim()) analyze();
}
