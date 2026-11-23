// 수어 동작 데이터 생성기
// 실행: node tools/gen-fake-data.mjs   (프로젝트 폴더에서)
//       node tools/gen-fake-data.mjs 먹다 ㄱ   ← 적은 단어·자모만 다시 만든다 (words.json 은 항상 갱신)
//
// 국립국어원 한국수어사전의 "수형 설명"을 보고 tools/ksl/ 의 어휘로 적은 동작 정의를
// data/signs/<단어>.json, data/fingerspelling/<자모>.json 으로 만든다.
// 사전의 영상·사진에서 좌표를 뽑지 않는다 — 설명을 읽고 새로 만든 동작이다 (source: "described-ksl-dictionary").
//
//  - 동작 정의: tools/ksl/signs/*.mjs (단어), tools/ksl/jamo.mjs (지문자)
//  - 어휘(손 모양·위치·방향·움직임): tools/ksl/vocab.mjs  ← 설명서는 tools/ksl/README.md
//  - 움직임 엔진(사람다운 타이밍·팔꿈치·충돌 회피): tools/ksl/engine.mjs
//  - 사전 설명 원문: data/ksl-ref.json (tools/fetch-ksl-ref.mjs 로 모음)
//
// 직접 녹화한 동작(signStatus: "recorded")은 건드리지 않는다.

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FPS, animate } from './ksl/engine.mjs';
import { 동작풀기 } from './ksl/vocab.mjs';
import JAMO from './ksl/jamo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'described-ksl-dictionary';
const only = process.argv.slice(2);

// ---------- 동작 정의 모으기 (tools/ksl/signs/ 의 모든 파일) ----------
const SIGNS = {};
const signDir = join(ROOT, 'tools', 'ksl', 'signs');
for (const file of readdirSync(signDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(join(signDir, file)).href);
  for (const [word, def] of Object.entries(mod.default)) {
    if (SIGNS[word]) throw new Error(`"${word}" 동작이 두 번 정의됨 (${SIGNS[word].file}, ${file})`);
    SIGNS[word] = { ...def, file };
  }
}

// ---------- 사전 설명 원문 ----------
const kslRef = JSON.parse(readFileSync(join(ROOT, 'data', 'ksl-ref.json'), 'utf8'));
const refByNo = new Map();
for (const e of Object.values(kslRef.entries || {})) for (const c of e.candidates || []) refByNo.set(String(c.no), c);
for (const arr of Object.values(kslRef.jamo || {})) for (const c of arr || []) refByNo.set(String(c.no), c);
function refOf(name, no) {
  const c = refByNo.get(String(no));
  if (!c) throw new Error(`${name}: 사전 항목 ${no} 이(가) data/ksl-ref.json 에 없음`);
  return { no: String(c.no), url: c.url, description: c.description };
}

// ---------- 저장 ----------
function signJson(word, frames, fps, ref) {
  const lines = frames.map((f) => '    ' + JSON.stringify(f));
  return `{\n  "version": 1,\n  "word": ${JSON.stringify(word)},\n  "fps": ${fps},\n  "frameCount": ${frames.length},\n  "coordinate": "normalized",\n  "source": "${SOURCE}",\n  "ref": ${JSON.stringify(ref)},\n  "frames": [\n${lines.join(',\n')}\n  ]\n}\n`;
}
// words.json 은 한 줄에 단어 하나씩, 사람이 읽기 좋은 간격으로 적는다
function pretty(v) {
  if (Array.isArray(v)) return '[' + v.map(pretty).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pretty(x)}`).join(', ') + '}';
  return JSON.stringify(v);
}

const wordsPath = join(ROOT, 'data', 'words.json');
const words = JSON.parse(readFileSync(wordsPath, 'utf8'));
mkdirSync(join(ROOT, 'data', 'signs'), { recursive: true });
mkdirSync(join(ROOT, 'data', 'fingerspelling'), { recursive: true });

let total = 0, made = 0, skipped = 0;
const known = new Set(words.map((w) => w.word));
for (const word of Object.keys(SIGNS)) if (!known.has(word)) console.warn(`[주의] "${word}" 은(는) data/words.json 에 없는 단어 (${SIGNS[word].file})`);

for (const w of words) {
  const def = SIGNS[w.word];
  if (!def) continue; // 아직 동작이 없는 단어 (지문자로 표시됨)
  if (w.signStatus === 'recorded') { skipped++; continue; } // 직접 녹화한 동작이 우선
  const ref = def.ref == null ? null : refOf(w.word, def.ref); // ref 가 없으면(사전에 항목이 없는 단어) 사전 카드 없이 만든다
  // words.json 갱신: 사전 항목(설명 원문 그대로) + 우리말 풀이
  w.sign = `signs/${w.word}.json`;
  w.signStatus = 'described';
  w.ref = ref;
  w.description = def.풀이 || '';
  w.handshape = def.수형 || '';
  w.nonManual = def.비수지 || '';
  w.verified = false;
  if (only.length && !only.includes(w.word)) continue;
  const frames = animate(동작풀기(def.동작, w.word), w.word);
  const text = signJson(w.word, frames, FPS, ref);
  writeFileSync(join(ROOT, 'data', w.sign), text);
  total += text.length;
  made++;
}
writeFileSync(wordsPath, '[\n' + words.map((w) => '  ' + pretty(w)).join(',\n') + '\n]\n');

let jamoMade = 0, jamoSkipped = 0;
for (const [j, def] of Object.entries(JAMO)) {
  if (only.length && !only.includes(j)) continue;
  // 녹화 도구로 직접 녹화한 지문자(source: self-recorded)는 덮어쓰지 않는다
  try {
    const head = readFileSync(join(ROOT, 'data', 'fingerspelling', `${j}.json`), 'utf8').slice(0, 400);
    if (/"source"\s*:\s*"self-recorded"/.test(head)) { jamoSkipped++; continue; }
  } catch { /* 파일이 없으면 새로 만든다 */ }
  const ref = refOf(j, def.ref);
  // 지문자는 짧고 많이 이어 붙이므로 15fps로 저장한다 (뷰어가 프레임 사이를 보간함)
  // 이어 붙였을 때 글자마다 눈을 깜빡이면 어색하므로 가끔만 깜빡인다
  const frames = animate(동작풀기(def.동작, j), j, { blinkChance: 0.2 }).filter((_, k) => k % 2 === 0).map((f, k) => ({ ...f, t: k }));
  const text = signJson(j, frames, FPS / 2, ref);
  writeFileSync(join(ROOT, 'data', 'fingerspelling', `${j}.json`), text);
  total += text.length;
  jamoMade++;
}
const authored = words.filter((w) => SIGNS[w.word]).length;
console.log(`단어 ${made}개 생성 (정의된 단어 ${authored}개 / 전체 ${words.length}개${skipped ? `, 녹화본이 있어 건너뜀 ${skipped}개` : ''}), 지문자 ${jamoMade}개 생성${jamoSkipped ? ` (녹화본이 있어 건너뜀 ${jamoSkipped}개)` : ''} (총 ${(total / 1024 / 1024).toFixed(2)} MB)`);
