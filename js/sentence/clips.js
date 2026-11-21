// 글로스 토큰 → 재생할 동작 클립 (지문자는 자모 동작을 이어 붙임)
import { loadSign, loadWords } from '../data.js';
import { buildSequence } from '../viewer/sequencer.js';
import { jamoSignPath, decompose } from './fingerspell.js';
import { buildIndex } from './glosser.js';

// 단어 고유의 수어 동작이 녹화되어 있는지
export function hasOwnSign(entry) {
  return !!entry?.sign;
}

// 동작이 아직 없는 단어는 지문자로 보여준다 → 사전의 모든 단어를 수어로 표현할 수 있다
export async function entryClip(entry) {
  if (entry.sign) return loadSign(entry.sign);
  return fingerspellClip(entry.word);
}

// text: 글자 문자열 또는 이미 나눈 자모 배열
export async function fingerspellClip(text) {
  const jamo = Array.isArray(text) ? text : decompose(text);
  const clips = await Promise.all(jamo.map((j) => loadSign(jamoSignPath(j)).catch(() => null)));
  const seq = buildSequence(clips, { transition: 4, pause: 2 });
  return seq.frames.length ? { fps: seq.fps, frames: seq.frames, fingerspelled: true } : null;
}

// 미리 불러올 파일 경로
export function entrySignPaths(entry) {
  return entry.sign ? [entry.sign] : decompose(entry.word).map(jamoSignPath);
}

let indexPromise = null;
// words.json으로 만든 검색 색인 (한 번만 만든다)
export function getGlossIndex() {
  if (!indexPromise) indexPromise = loadWords().then(({ list }) => buildIndex(list));
  return indexPromise;
}

// 토큰 하나의 클립. 못 찾은 토큰(none)은 null
export async function tokenClip(token) {
  if (token.entry) return entryClip(token.entry);
  if (token.type === 'fingerspell' && token.jamo?.length) return fingerspellClip(token.jamo);
  return null;
}

// 토큰 배열 → { fps, frames, segments } (segments[k].index = 토큰 위치)
export async function sentenceClip(tokens, { transition = 8, pause = 6 } = {}) {
  const clips = await Promise.all(tokens.map((t) => tokenClip(t).catch(() => null)));
  return buildSequence(clips, { transition, pause });
}

// 카드에 보여줄 이름
export function tokenLabel(token) {
  if (token.entry) return token.entry.word;
  if (token.type === 'fingerspell') return token.text;
  return token.text || token.surface || '?';
}

export const TYPE_LABELS = {
  exact: '정확',
  form: '활용형',
  synonym: '비슷한 말',
  rule: '활용형',
  split: '쪼갬',
  fingerspell: '지문자',
  marker: '완료 표시',
  none: '못 찾음',
};
