// 국립국어원 한국수어사전에서 단어별 수형 설명과 항목 주소를 모은다.
// 실행: node tools/fetch-ksl-ref.mjs   (프로젝트 폴더에서)
// 결과: data/ksl-ref.json  — 출처: 국립국어원 한국수어사전 (CC BY-NC-ND 2.0 KR, 설명 원문 그대로 보관)
// 영상은 내려받지 않는다. 설명을 참고해 동작은 따로 새로 만든다.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://sldict.korean.go.kr';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (study project)' } });
      if (r.ok) return await r.text();
    } catch {}
    await sleep(1000 * (i + 1));
  }
  throw new Error('fetch failed: ' + url);
}

// 검색 결과에서 일상생활 수어(CTE) 항목: [{ no, title }]
function parseSearch(html) {
  const out = [];
  const re = /<span class="tit">\s*<a href="javascript:fnSearchContentsView\('(\d+)', 'CTE', '\d+'\);">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) out.push({ no: m[1], title: clean(m[2]) });
  return out;
}

function parseView(html) {
  const desc = [];
  const re = /수형 설명<\/dt>[\s\S]*?<dd>([\s\S]*?)<\/dd>/g;
  let m;
  while ((m = re.exec(html))) desc.push(clean(m[1]));
  const kor = /한국어 대응표현<\/span>\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(html);
  const imgs = [...html.matchAll(/class="example" href="([^"]+_700X466\.jpg)"/g)].map((x) => x[1]);
  const lic = /<span class="copy">([\s\S]*?)<\/span>/.exec(html);
  return { description: desc.join(' / '), korean: kor ? clean(kor[1]) : '', images: imgs, license: lic ? clean(lic[1]).replace(/\].*/, ']') : '' };
}

const words = JSON.parse(readFileSync(join(ROOT, 'data', 'words.json'), 'utf8'));
const list = Array.isArray(words) ? words : words.words;
const outPath = join(ROOT, 'data', 'ksl-ref.json');
let prev = {};
try { prev = JSON.parse(readFileSync(outPath, 'utf8')).entries || {}; } catch {}

// 검색어 후보: 단어 그대로 → 활용형 → '합니다/하다'를 뗀 꼴 → 같은 수어
function queriesOf(w) {
  const qs = [w.word, ...(w.forms || []).slice(0, 2)];
  const stem = w.word.replace(/(합니다|하세요|해요)$/, '');
  if (stem !== w.word) qs.push(stem + '하다', stem);
  if (/하다$/.test(w.word)) qs.push(w.word.replace(/하다$/, ''));
  qs.push(...(w.synonyms || []).slice(0, 2));
  return [...new Set(qs)];
}

const entries = { ...prev };
const save = () => writeFileSync(outPath, JSON.stringify({ source: '국립국어원 한국수어사전 (https://sldict.korean.go.kr)', license: 'CC BY-NC-ND 2.0 KR — 수형 설명 원문을 변경 없이 보관', fetchedAt: new Date().toISOString().slice(0, 10), entries, jamo }, null, 1));
let jamo = {};
try { jamo = JSON.parse(readFileSync(outPath, 'utf8')).jamo || {}; } catch {}
let n = 0;
for (const w of list) {
  n++;
  if (entries[w.word]?.candidates?.length) continue;
  const qs = queriesOf(w);
  const keys = qs;
  let found = [];
  for (const q of qs) {
    const html = await get(`${BASE}/front/search/searchAllList.do?searchKeyword=${encodeURIComponent(q)}`);
    await sleep(300);
    const items = parseSearch(html);
    const exact = items.filter((it) => it.title.split(',').map((s) => s.trim()).some((t) => keys.includes(t)));
    found = exact.length ? exact : found.length ? found : items.filter((it) => it.title.includes(q)).slice(0, 1);
    if (exact.length) break;
  }
  const candidates = [];
  for (const it of found.slice(0, 3)) {
    const html = await get(`${BASE}/front/sign/signContentsView.do?origin_no=${it.no}&top_category=CTE`);
    await sleep(300);
    candidates.push({ no: it.no, title: it.title, url: `${BASE}/front/sign/signContentsView.do?origin_no=${it.no}&top_category=CTE`, ...parseView(html) });
  }
  entries[w.word] = { candidates };
  console.log(`${n}/${list.length} ${w.word}: ${candidates.length ? candidates.map((c) => c.title).join(' | ') : '(없음)'}`);
  save();
}

// 지문자 자모: 제목이 'ㄱ' 또는 'ㄱ[기역]' 꼴인 항목
const JAMO = [
  'ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ', 'ㄲ', 'ㄸ', 'ㅃ', 'ㅆ', 'ㅉ',
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
];
for (const j of JAMO) {
  if (jamo[j]?.length) continue;
  const html = await get(`${BASE}/front/search/searchAllList.do?searchKeyword=${encodeURIComponent(j)}`);
  await sleep(300);
  const items = parseSearch(html).filter((it) => it.title.replace(/\s/g, '').split(/[\[,]/)[0] === j);
  const out = [];
  for (const it of items.slice(0, 2)) {
    const v = await get(`${BASE}/front/sign/signContentsView.do?origin_no=${it.no}&top_category=CTE`);
    await sleep(300);
    out.push({ no: it.no, title: it.title, url: `${BASE}/front/sign/signContentsView.do?origin_no=${it.no}&top_category=CTE`, ...parseView(v) });
  }
  jamo[j] = out;
  console.log(`자모 ${j}: ${out.map((o) => o.title + ' — ' + o.description).join(' | ') || '(없음)'}`);
  save();
}
