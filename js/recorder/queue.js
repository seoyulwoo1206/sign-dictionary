// 녹화 대기열: 동작이 없는(또는 임시 동작인) 단어·자모를 차례로 녹화한다.
// Chrome·Edge에서는 프로젝트의 data 폴더를 연결해, 저장 버튼 한 번으로
// signs/단어.json 저장 + words.json 갱신까지 끝낸다. (다른 브라우저는 내려받기)
import { buildWordEntry, stringifySign, buildSignData, JAMO_GROUPS } from './wordinfo.js';

const DONE_KEY = 'signdict.recorder.done.v1';
const ALL_JAMO = JAMO_GROUPS.flatMap((g) => g.items);

const $ = (id) => document.getElementById(id);

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); }
}
function saveDone(set) {
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...set])); } catch { /* 저장 불가는 무시 */ }
}

// words.json을 한 줄에 항목 하나씩 저장 (변경 내역을 보기 쉽게)
// tools/gen-fake-data.mjs 와 같은 꼴(쉼표·콜론 뒤 띄어쓰기)로 써서, 녹화 하나를 저장해도 그 줄만 바뀌게 한다
function pretty(v) {
  if (Array.isArray(v)) return '[' + v.map(pretty).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pretty(x)}`).join(', ') + '}';
  return JSON.stringify(v);
}
function stringifyWords(list) {
  return '[\n' + list.map((e) => '  ' + pretty(e)).join(',\n') + '\n]\n';
}

// api: recorder.js가 넘겨주는 함수들
//   getClip() → { fps, frames } | null      fillWord(entry)      selectJamo(jamo)
//   getForm() → 폼 값                        setMode('word'|'jamo') getMode()
//   setMessage(text)
export function initQueue(api) {
  const el = {
    connect: $('qConnect'), folderInfo: $('qFolder'), kind: $('qKind'), filter: $('qFilter'),
    list: $('qList'), count: $('qCount'), next: $('qNext'), save: $('qSave'),
  };
  const state = {
    dir: null,          // data 폴더 핸들
    words: [],          // words.json 내용
    jamoStatus: {},     // 자모 → 'recorded' | 'placeholder' | 'missing'
    done: loadDone(),   // 이번 기기에서 녹화를 마친 항목 ('w:단어' / 'j:자모')
    current: null,      // { kind: 'word'|'jamo', key }
  };

  const fsSupported = typeof window.showDirectoryPicker === 'function';
  if (!fsSupported) {
    el.connect.disabled = true;
    el.folderInfo.textContent = '이 브라우저는 폴더 바로 저장을 지원하지 않아요 (Chrome·Edge에서 가능). 대신 JSON 내려받기를 쓰세요.';
    el.save.hidden = true;
  }

  async function readText(dir, path) {
    let d = dir;
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const f = await (await d.getFileHandle(parts.at(-1))).getFile();
    return f.text();
  }

  async function writeText(dir, path, text) {
    let d = dir;
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  async function loadWords() {
    try {
      if (state.dir) state.words = JSON.parse(await readText(state.dir, 'words.json'));
      else state.words = await (await fetch('data/words.json', { cache: 'no-store' })).json();
    } catch (e) {
      state.words = [];
      el.folderInfo.textContent = 'words.json을 읽지 못했어요: ' + e.message;
    }
  }

  // 자모 파일의 source를 확인해 임시 동작인지 본다
  async function loadJamoStatus() {
    await Promise.all(ALL_JAMO.map(async (j) => {
      try {
        const text = state.dir
          ? await readText(state.dir, `fingerspelling/${j}.json`)
          : await (await fetch(`data/fingerspelling/${encodeURIComponent(j)}.json`, { cache: 'no-store' })).text();
        const m = text.slice(0, 400).match(/"source"\s*:\s*"([^"]+)"/);
        // 사전 설명을 보고 만든 동작(described-ksl-dictionary)도 아직 녹화본이 아니므로 대기열에 남긴다
        state.jamoStatus[j] = m && (m[1] === 'generated-placeholder' || m[1] === 'described-ksl-dictionary') ? 'placeholder' : 'recorded';
      } catch {
        state.jamoStatus[j] = 'missing';
      }
    }));
  }

  function wordStatus(w) {
    if (!w.sign) return 'missing';
    return w.signStatus === 'placeholder' || w.signStatus === 'described' ? 'placeholder' : 'recorded';
  }

  const LABEL = { missing: '녹화 필요', placeholder: '설명 기반·임시', recorded: '녹화됨' };

  function items() {
    const kind = el.kind.value;
    const filter = el.filter.value;
    const list = kind === 'jamo'
      ? ALL_JAMO.map((j) => ({ kind: 'jamo', key: j, label: j, status: state.jamoStatus[j] || 'missing' }))
      : state.words.map((w) => ({ kind: 'word', key: w.word, label: w.word, sub: w.category, status: wordStatus(w), level: w.level }))
        .sort((a, b) => (a.level - b.level) || a.label.localeCompare(b.label, 'ko'));
    return list.map((it) => ({ ...it, done: state.done.has((it.kind === 'jamo' ? 'j:' : 'w:') + it.key) }))
      .filter((it) => filter === 'all' || (filter === 'todo' ? it.status !== 'recorded' && !it.done : it.status === filter));
  }

  function render() {
    const list = items();
    el.list.replaceChildren(...list.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'q-item' + (state.current?.key === it.key && state.current?.kind === it.kind ? ' active' : '') + (it.done ? ' done' : '');
      b.innerHTML = `<b></b><small></small>`;
      b.querySelector('b').textContent = it.label;
      b.querySelector('small').textContent = it.done ? '✓ 이번에 녹화' : LABEL[it.status];
      b.dataset.status = it.status;
      b.addEventListener('click', () => select(it));
      return b;
    }));
    const total = el.kind.value === 'jamo' ? ALL_JAMO.length : state.words.length;
    el.count.textContent = `${list.length}개 표시 / 전체 ${total}개`;
  }

  function select(it) {
    state.current = { kind: it.kind, key: it.key };
    if (it.kind === 'jamo') {
      api.setMode('jamo');
      api.selectJamo(it.key);
    } else {
      api.setMode('word');
      api.fillWord(state.words.find((w) => w.word === it.key));
    }
    render();
    api.setMessage(`"${it.label}" 선택됨 — 위에서 녹화하거나 영상을 추출한 뒤 저장하세요.`);
  }

  function next() {
    const list = items().filter((it) => !it.done);
    if (!list.length) { api.setMessage('대기열을 모두 끝냈어요! 🎉'); return; }
    const i = list.findIndex((it) => it.key === state.current?.key && it.kind === state.current?.kind);
    select(list[(i + 1) % list.length]);
  }

  function markDone(kind, key) {
    state.done.add((kind === 'jamo' ? 'j:' : 'w:') + key);
    saveDone(state.done);
  }

  // 폴더에 바로 저장
  async function saveToFolder() {
    const clip = api.getClip();
    if (!clip || !clip.frames.length) { api.setMessage('먼저 동작을 녹화하거나 추출하세요.'); return; }
    if (!state.dir) { api.setMessage('먼저 "data 폴더 연결"을 눌러 프로젝트의 data 폴더를 고르세요.'); return; }
    try {
      if (api.getMode() === 'jamo') {
        const jamo = api.getJamo();
        if (!jamo) { api.setMessage('자모를 고르세요.'); return; }
        await writeText(state.dir, `fingerspelling/${jamo}.json`, stringifySign(buildSignData(jamo, clip.fps, clip.frames)));
        state.jamoStatus[jamo] = 'recorded';
        markDone('jamo', jamo);
        api.setMessage(`✓ fingerspelling/${jamo}.json 저장 완료`);
      } else {
        const form = api.getForm();
        const word = String(form.word || '').trim();
        if (!word) { api.setMessage('단어를 입력하세요.'); return; }
        const fileName = word.replace(/[\\/:*?"<>|]/g, '_');
        await writeText(state.dir, `signs/${fileName}.json`, stringifySign(buildSignData(word, clip.fps, clip.frames)));
        // words.json 갱신 (최신 내용을 다시 읽고 고친다)
        await loadWords();
        const fresh = buildWordEntry({ ...form, word });
        const i = state.words.findIndex((w) => w.word === word);
        const merged = i >= 0 ? { ...state.words[i] } : { ...fresh };
        for (const k of ['forms', 'synonyms']) if (fresh[k].length) merged[k] = fresh[k];
        for (const k of ['pos', 'meaning', 'category', 'level', 'description', 'handshape', 'nonManual']) {
          if (fresh[k] !== '' && fresh[k] !== undefined) merged[k] = fresh[k];
        }
        merged.sign = `signs/${fileName}.json`;
        merged.signStatus = 'recorded';
        if (i >= 0) state.words[i] = merged; else state.words.push(merged);
        await writeText(state.dir, 'words.json', stringifyWords(state.words));
        markDone('word', word);
        api.setMessage(`✓ signs/${fileName}.json 저장 + words.json 갱신 완료`);
      }
      render();
      setTimeout(next, 600);
    } catch (e) {
      api.setMessage('저장 실패: ' + e.message);
    }
  }

  async function connect() {
    try {
      const dir = await window.showDirectoryPicker({ id: 'signdict-data', mode: 'readwrite' });
      try {
        await dir.getFileHandle('words.json');
      } catch {
        el.folderInfo.textContent = `"${dir.name}" 폴더에 words.json이 없어요. 프로젝트 안의 data 폴더를 골라 주세요.`;
        return;
      }
      state.dir = dir;
      el.folderInfo.textContent = `✓ "${dir.name}" 폴더 연결됨 — 저장하면 이 폴더에 바로 써요.`;
      el.save.disabled = false;
      await refresh();
    } catch (e) {
      if (e.name !== 'AbortError') el.folderInfo.textContent = '폴더 연결 실패: ' + e.message;
    }
  }

  async function refresh() {
    await Promise.all([loadWords(), loadJamoStatus()]);
    render();
  }

  // 다운로드로 저장했을 때도 '이번에 녹화'로 표시
  api.onDownloaded?.((kind, key) => { markDone(kind, key); render(); });

  el.connect.addEventListener('click', connect);
  el.kind.addEventListener('change', render);
  el.filter.addEventListener('change', render);
  el.next.addEventListener('click', next);
  el.save.addEventListener('click', saveToFolder);
  el.save.disabled = true;

  refresh().then(() => {
    // 사전의 "지금 녹화하기" 링크로 들어온 경우
    const want = new URLSearchParams(location.search).get('word');
    if (want) {
      const w = state.words.find((x) => x.word === want);
      if (w) select({ kind: 'word', key: w.word, label: w.word });
    }
  });
}
