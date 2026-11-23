// words / curriculum / 동작 JSON 불러오기 + 캐시

const BASE = new URL('../data/', import.meta.url);

let wordsPromise = null;
let curriculumPromise = null;
const signCache = new Map(); // 경로 → Promise<clip>

async function fetchJSON(path) {
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), BASE);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`불러오기 실패: ${path} (${res.status})`);
  return res.json();
}

export function loadWords() {
  if (!wordsPromise) {
    wordsPromise = fetchJSON('words.json').then((list) => {
      const byWord = new Map(list.map((w) => [w.word, w]));
      const byId = new Map(list.map((w) => [w.id, w]));
      return { list, byWord, byId };
    });
    wordsPromise.catch(() => { wordsPromise = null; });
  }
  return wordsPromise;
}

// 영상·농인 확인이 필요한 단어와 이유 (data/review.json). 없거나 실패하면 빈 목록
let reviewPromise = null;
export function loadReview() {
  if (!reviewPromise) {
    reviewPromise = fetchJSON('review.json')
      .then((o) => new Map(Object.entries(o).filter(([k]) => !k.startsWith('_'))))
      .catch(() => new Map());
  }
  return reviewPromise;
}

// 동작의 근거: recorded(직접 녹화) | dict(사전 설명 기반) | guess(사전 항목 없이 추정) | placeholder(임시) | missing(없음, 지문자)
export function signKind(entry) {
  if (!entry?.sign) return 'missing';
  if (entry.signStatus === 'recorded') return 'recorded';
  if (entry.signStatus === 'placeholder') return 'placeholder';
  return entry.ref ? 'dict' : 'guess';
}

export function loadCurriculum() {
  if (!curriculumPromise) {
    curriculumPromise = fetchJSON('curriculum.json').then((c) => {
      // 레슨을 순서대로 펼친 목록 (잠금 해제 판단용)
      const lessons = [];
      c.units.forEach((u, ui) => u.lessons.forEach((l, li) => lessons.push({ ...l, unit: u, unitIndex: ui, lessonIndex: li, order: lessons.length })));
      return { ...c, lessons, lessonById: new Map(lessons.map((l) => [l.id, l])) };
    });
    curriculumPromise.catch(() => { curriculumPromise = null; });
  }
  return curriculumPromise;
}

// 동작 JSON (data/ 기준 상대 경로, 예: 'signs/먹다.json')
export function loadSign(path) {
  if (!signCache.has(path)) {
    const p = fetchJSON(path).then(upgradeSign);
    signCache.set(path, p);
    p.catch(() => signCache.delete(path));
  }
  return signCache.get(path);
}

export function loadSignForWord(entry) {
  return loadSign(entry.sign);
}

// 레슨 시작 전에 필요한 동작만 미리 불러오기
export function preloadSigns(paths) {
  return Promise.allSettled(paths.map(loadSign));
}

// 동작 JSON 형식이 바뀌면 여기서 이전 버전을 변환한다
function upgradeSign(data) {
  if (!data.version || data.version === 1) {
    return { ...data, version: 1, fps: data.fps || 30 };
  }
  return data;
}
