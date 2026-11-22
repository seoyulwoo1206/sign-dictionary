// 내 정보: 통계, 설정, 진도 내보내기/가져오기
import { h, toast, applyTheme } from '../ui.js';
import { loadCurriculum } from '../data.js';
import {
  getState, currentStreak, GOALS, setGoal, setSetting, exportJSON, importJSON, resetProgress, storageOK,
} from '../learn/progress.js';
import { dateKey, addDays } from '../learn/srs.js';
import { refreshViewerAvatar } from '../viewer/viewer.js';

export async function render(root, ctx) {
  const c = await loadCurriculum();
  const draw = () => {
    root.replaceChildren();
    build(root, c, draw);
  };
  draw();
  void ctx;
}

function build(root, c, redraw) {
  const s = getState();
  const lessonsDone = Object.keys(s.lessons).length;
  const learned = Object.keys(s.words).length;
  const mastered = Object.values(s.words).filter((w) => w.box >= 4).length;

  // 최근 7일 XP
  const today = dateKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const maxXP = Math.max(10, ...days.map((d) => s.history[d] || 0));
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const week = h('div.week', { role: 'img', 'aria-label': '최근 7일 XP: ' + days.map((d) => `${d.slice(5)} ${s.history[d] || 0}`).join(', ') },
    days.map((d) => {
      const xp = s.history[d] || 0;
      const [y, m, dd] = d.split('-').map(Number);
      return h('div', { class: d === today ? 'today' : '' },
        h('span', xp || ''),
        h('i', { style: { height: `${(xp / maxXP) * 70}%` } }),
        h('span', dayNames[new Date(y, m - 1, dd).getDay()]),
      );
    }));

  const toggle = (label, key, onChange) => {
    const input = h('input', { type: 'checkbox', checked: !!s.settings[key], 'aria-label': label });
    input.addEventListener('change', () => { setSetting(key, input.checked); onChange?.(); });
    return h('div.settings-row', h('span', label), h('label.switch', input, h('span')));
  };

  const goalSeg = h('div.seg', { role: 'group', 'aria-label': '일일 목표' },
    Object.entries(GOALS).map(([k, g]) => h('button.pc-btn', {
      type: 'button', class: s.goal === k ? 'on' : '', 'aria-pressed': String(s.goal === k),
      onclick: () => { setGoal(k); redraw(); },
    }, `${g.label} ${g.newWords}개`)));

  const themeSeg = h('div.seg', { role: 'group', 'aria-label': '화면 테마' },
    [['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']].map(([k, label]) => h('button.pc-btn', {
      type: 'button', class: s.settings.theme === k ? 'on' : '', 'aria-pressed': String(s.settings.theme === k),
      onclick: () => { setSetting('theme', k); applyTheme(); redraw(); },
    }, label)));

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      importJSON(await f.text());
      applyTheme();
      toast('진도를 불러왔어요!', { type: 'good' });
      redraw();
    } catch (e) {
      toast('불러오기 실패: ' + e.message);
    }
  });

  root.append(h('div.stack',
    h('div.page-head', h('h1', '내 정보'), h('p', '학습 기록과 설정을 한곳에서 확인해요.')),
    h('section.stats', { 'aria-label': '통계' },
      h('div.stat', h('b', `🔥 ${currentStreak()}`), h('span', `연속 학습일 (최고 ${s.streak.best || 0})`)),
      h('div.stat', h('b', `⭐ ${s.xp}`), h('span', '총 XP')),
      h('div.stat', h('b', `${lessonsDone}/${c.lessons.length}`), h('span', '완료한 레슨')),
    ),
    h('section.stats',
      h('div.stat', h('b', String(learned)), h('span', '배운 단어')),
      h('div.stat', h('b', String(mastered)), h('span', '잘 아는 단어 (4박스+)')),
      h('div.stat', h('b', String(s.daily.reviews)), h('span', '오늘 복습')),
    ),
    h('section.card', h('h2', '최근 7일 XP'), week),

    h('section.card',
      h('h2', '설정'),
      h('div.settings-row', h('span', '일일 목표 (새 단어)'), goalSeg),
      h('div.settings-row', h('span', '화면 테마'), themeSeg),
      h('div.settings-row', h('span', '사람 모습'), h('div.seg', { role: 'group', 'aria-label': '사람 모습' },
        [['avatar', '3D 아바타'], ['mannequin', '마네킹 (가벼움)']].map(([k, label]) => {
          const on = (s.settings.avatar || 'avatar') === k;
          return h('button.pc-btn', {
            type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on),
            onclick: () => { setSetting('avatar', k); refreshViewerAvatar(); redraw(); },
          }, label);
        }))),
      toggle('효과음 끄기', 'muted'),
      toggle('뷰어를 처음부터 거울 모드로', 'mirrorDefault'),
    ),

    h('section.card',
      h('h2', '진도 저장'),
      h('p.muted.small', '진도는 이 브라우저에만 저장돼요. 기기를 바꾸거나 캐시를 지우기 전에 파일로 내보내 두세요.'),
      !storageOK ? h('p.notice.small', '지금은 브라우저 저장소를 쓸 수 없어서 메모리에만 저장되고 있어요.') : null,
      h('div.file-actions',
        h('button.btn', {
          type: 'button',
          onclick: () => {
            const blob = new Blob([exportJSON()], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: `수어사전-진도-${dateKey()}.json` });
            document.body.append(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          },
        }, '⬇ 진도 내보내기'),
        h('button.btn', { type: 'button', onclick: () => fileInput.click() }, '⬆ 진도 가져오기'),
        fileInput,
        h('span.spacer'),
        h('button.btn.ghost.danger-text', {
          type: 'button',
          onclick: () => {
            if (confirm('모든 진도(XP, 스트릭, 배운 단어)를 지울까요? 되돌릴 수 없어요.')) {
              resetProgress(); applyTheme(); toast('진도를 초기화했어요.'); redraw();
            }
          },
        }, '진도 초기화'),
      ),
    ),

    h('section.card',
      h('h2', '이 사이트에 대해'),
      h('p.small', '수어 동작을 영상 대신 관절 좌표로 저장해 3D로 보여줘요. 시점을 돌리고, 느리게 보고, 거울처럼 뒤집어 볼 수 있어요.'),
      h('p.notice.small', '지금 들어 있는 동작은 기능 시험용 임시 데이터예요. 실제 한국수어 동작은 국립국어원 한국수어사전에서 확인하고, 검수 배지가 있는 데이터만 믿어 주세요.'),
      h('p.small', h('a', { href: 'recorder.html' }, '🎥 동작 데이터 제작 도구 열기'), ' · ', h('a', { href: 'tests/tokenizer.test.html' }, '문장 분석 테스트')),
    ),
  ));
}
