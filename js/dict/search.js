// 사전 검색: 완성형 + 초성 검색 + 활용형·동의어·뜻

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const CHO_SET = new Set(CHO);

// 문자열의 초성만 뽑기 ('감사합니다' → 'ㄱㅅㅎㄴㄷ')
export function getChosung(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) out += CHO[Math.floor((code - 0xac00) / 588)];
    else out += ch;
  }
  return out;
}

export function isChosungQuery(q) {
  return q.length > 0 && [...q].every((c) => CHO_SET.has(c) || c === ' ');
}

// 검색어 q로 words 목록에서 점수 순 결과 반환
export function searchWords(list, q, { category = '', level = 0 } = {}) {
  const query = q.trim().replace(/\s+/g, '');
  const filtered = list.filter((w) => (!category || w.category === category) && (!level || w.level === level));
  if (!query) return filtered.map((entry) => ({ entry, score: 0, via: '' }));

  const cho = isChosungQuery(query);
  const results = [];
  for (const w of filtered) {
    let score = 0;
    let via = '';
    const all = [w.word, ...(w.forms || []), ...(w.synonyms || [])];
    if (cho) {
      if (getChosung(w.word).startsWith(query)) { score = 80; }
      else if (getChosung(w.word).includes(query)) { score = 60; }
      else {
        const hit = [...(w.forms || []), ...(w.synonyms || [])].find((s) => getChosung(s).startsWith(query));
        if (hit) { score = 40; via = hit; }
      }
    } else if (w.word === query) score = 100;
    else if (w.word.startsWith(query)) score = 85;
    else if (w.word.includes(query)) score = 70;
    else {
      const exact = all.find((s) => s === query);
      const prefix = all.find((s) => s.startsWith(query));
      if (exact) { score = 75; via = exact; }
      else if (prefix) { score = 55; via = prefix; }
      else if (w.meaning && w.meaning.includes(query)) { score = 30; via = '뜻'; }
    }
    if (score) results.push({ entry: w, score, via });
  }
  results.sort((a, b) => b.score - a.score || a.entry.level - b.entry.level || a.entry.word.localeCompare(b.entry.word, 'ko'));
  return results;
}

export function categoriesOf(list) {
  return [...new Set(list.map((w) => w.category))];
}
