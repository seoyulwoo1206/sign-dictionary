// 간격 반복 복습 (라이트너 박스)
// 박스 1~6, 맞히면 다음 박스, 틀리면 1번 박스로

export const INTERVALS = [1, 2, 4, 7, 15, 30]; // 박스별 다음 복습까지 일 수

// 로컬 시간 기준 날짜 문자열 'YYYY-MM-DD'
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
}

export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}

// 새로 배운 단어
export function newCard(today = dateKey(), { dueNow = false } = {}) {
  return { box: 1, due: dueNow ? today : addDays(today, INTERVALS[0]), correct: 0, wrong: 0, learnedAt: today };
}

// 복습 결과 반영
export function grade(card, correct, today = dateKey()) {
  const c = { ...card };
  if (correct) {
    c.box = Math.min(INTERVALS.length, (c.box || 1) + 1);
    c.correct = (c.correct || 0) + 1;
  } else {
    c.box = 1;
    c.wrong = (c.wrong || 0) + 1;
  }
  c.due = addDays(today, INTERVALS[c.box - 1]);
  c.lastReview = today;
  return c;
}

export function isDue(card, today = dateKey()) {
  return card && card.due <= today;
}

// 오늘 복습할 단어 목록 (오래 밀린 순, 낮은 박스 순)
export function dueList(words, today = dateKey()) {
  return Object.entries(words)
    .filter(([, c]) => isDue(c, today))
    .sort(([, a], [, b]) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.box - b.box))
    .map(([word]) => word);
}
