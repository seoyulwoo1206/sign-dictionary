// XP, 스트릭, 일일 목표, 진도 저장/불러오기
import { dateKey, addDays, newCard, grade, dueList } from './srs.js';

const KEY = 'signdict.progress.v1';
export const VERSION = 1;

export const GOALS = {
  light: { label: '가볍게', newWords: 3 },
  normal: { label: '보통', newWords: 5 },
  hard: { label: '열심히', newWords: 10 },
};
export const XP_LESSON = 10;
export const XP_PERFECT = 5;
export const XP_REVIEW = 1; // 복습 정답 1개당

function emptyState() {
  return {
    version: VERSION,
    xp: 0,
    streak: { count: 0, lastDate: null, best: 0 },
    daily: { date: dateKey(), newWords: 0, reviews: 0, lessons: 0, xp: 0 },
    goal: 'normal',
    lessons: {},   // lessonId → { stars, perfect, completedAt, count }
    words: {},     // 단어 → { box, due, correct, wrong, learnedAt }
    settings: { muted: false, theme: 'auto', mirrorDefault: false, avatar: 'avatar' },
    history: {},   // 날짜 → 그날 얻은 XP
  };
}

// 이전 버전 저장 형식 → 현재 형식
function migrate(data) {
  if (!data || typeof data !== 'object') return emptyState();
  const base = emptyState();
  const s = {
    ...base,
    ...data,
    streak: { ...base.streak, ...(data.streak || {}) },
    daily: { ...base.daily, ...(data.daily || {}) },
    settings: { ...base.settings, ...(data.settings || {}) },
    lessons: data.lessons || {},
    words: data.words || {},
    history: data.history || {},
  };
  s.version = VERSION;
  return s;
}

let state = null;
export let storageOK = true;
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrate(JSON.parse(raw)) : emptyState();
  } catch {
    storageOK = false;
    return emptyState();
  }
}

export function getState() {
  if (!state) state = read();
  rollDaily();
  return state;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageOK = true;
  } catch {
    // 저장이 막혀도 메모리에서는 계속 동작한다
    storageOK = false;
  }
  for (const fn of listeners) fn(state);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 날짜가 바뀌면 오늘 기록 초기화
function rollDaily() {
  const today = dateKey();
  if (state.daily.date !== today) state.daily = { date: today, newWords: 0, reviews: 0, lessons: 0, xp: 0 };
}

// 화면에 보여줄 스트릭 (어제나 오늘 학습했으면 유지, 아니면 0)
export function currentStreak() {
  const s = getState();
  const today = dateKey();
  if (!s.streak.lastDate) return 0;
  if (s.streak.lastDate === today || s.streak.lastDate === addDays(today, -1)) return s.streak.count;
  return 0;
}

export function studiedToday() {
  return getState().streak.lastDate === dateKey();
}

function touchStreak() {
  const today = dateKey();
  const st = state.streak;
  if (st.lastDate === today) return false;
  st.count = st.lastDate === addDays(today, -1) ? st.count + 1 : 1;
  st.lastDate = today;
  st.best = Math.max(st.best || 0, st.count);
  return true;
}

function addXP(n) {
  state.xp += n;
  state.daily.xp += n;
  const today = dateKey();
  state.history[today] = (state.history[today] || 0) + n;
}

// 레슨 완료 → { xp, streakUp, newWords }
export function completeLesson(lessonId, { perfect = false, words = [] } = {}) {
  getState();
  const today = dateKey();
  const prev = state.lessons[lessonId];
  const xp = XP_LESSON + (perfect ? XP_PERFECT : 0);
  addXP(xp);
  const stars = Math.max(prev?.stars || 0, perfect ? 3 : 2);
  state.lessons[lessonId] = { stars, perfect: perfect || !!prev?.perfect, completedAt: today, count: (prev?.count || 0) + 1 };
  let added = 0;
  for (const w of words) {
    if (!state.words[w]) { state.words[w] = newCard(today); added++; }
  }
  state.daily.newWords += added;
  state.daily.lessons += 1;
  const streakUp = touchStreak();
  save();
  return { xp, streakUp, newWords: added };
}

// 복습 1개 결과
export function recordReview(word, correct) {
  getState();
  const card = state.words[word] || newCard();
  state.words[word] = grade(card, correct);
  state.daily.reviews += 1;
  if (correct) addXP(XP_REVIEW);
  save();
}

// 복습 세션을 끝까지 마쳤을 때 (스트릭 유지)
export function completeReviewSession() {
  getState();
  const streakUp = touchStreak();
  save();
  return { streakUp };
}

// 사전에서 "학습 목록에 추가" — 오늘 바로 복습 대상이 된다
export function addToStudy(word) {
  getState();
  if (state.words[word]) return false;
  state.words[word] = newCard(dateKey(), { dueNow: true });
  save();
  return true;
}

export function removeFromStudy(word) {
  getState();
  delete state.words[word];
  save();
}

export function isStudying(word) {
  return !!getState().words[word];
}

export function dueWords() {
  return dueList(getState().words);
}

export function setGoal(goal) {
  getState();
  if (GOALS[goal]) { state.goal = goal; save(); }
}

export function setSetting(key, value) {
  getState();
  state.settings[key] = value;
  save();
}

export function isLessonDone(id) {
  return !!getState().lessons[id];
}

// 진도 JSON 내보내기 / 가져오기
export function exportJSON() {
  return JSON.stringify({ app: 'signdict', exportedAt: new Date().toISOString(), progress: getState() }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  const progress = data && data.progress ? data.progress : data;
  if (!progress || typeof progress !== 'object' || !('xp' in progress)) throw new Error('진도 파일 형식이 아닙니다.');
  state = migrate(progress);
  save();
}

export function resetProgress() {
  state = emptyState();
  save();
}
