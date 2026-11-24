// 내 정보: 통계, 설정, 진도 내보내기/가져오기
import { h, toast, applyTheme } from '../ui.js';
import { loadCurriculum } from '../data.js';
import {
  getState, currentStreak, GOALS, setGoal, setSetting, exportJSON, importJSON, resetProgress, storageOK,
} from '../learn/progress.js';
import { accountInfo, onAccountChange, signIn, signUp, signOut, MIN_PASSWORD } from '../account.js';
import { dateKey, addDays } from '../learn/srs.js';
import { refreshViewerAvatar } from '../viewer/viewer.js';
import { getCustomAvatar, saveCustomAvatar, clearCustomAvatar } from '../viewer/avatar-store.js';
import { customAvatarFailed } from '../viewer/avatar.js';

export async function render(root, ctx) {
  const [c, mine] = await Promise.all([loadCurriculum(), getCustomAvatar()]);
  const draw = () => {
    root.replaceChildren();
    build(root, c, draw, mine);
  };
  draw();
  // 로그인·로그아웃하거나 오류가 나면 다시 그린다 (스크롤 위치는 그대로)
  let pending = false;
  const redraw = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!ctx.isCurrent()) return;
      const y = window.scrollY;
      draw();
      window.scrollTo(0, y);
    }, 0);
  };
  let lastKey = '';
  const offAccount = onAccountChange((a) => {
    // 저장 중/저장됨 사이를 오갈 때마다 화면 전체를 다시 그리지 않고 상태 글자만 바꾼다
    const key = `${a.user?.email}|${a.status === 'error'}|${a.status === 'loading'}|${a.status === 'signed-out'}`;
    if (key !== lastKey) { lastKey = key; redraw(); } else updateSyncText(root, a);
  });
  ctx.onCleanup(offAccount);
  // (계정의 기록을 불러와 기록이 바뀌면 main.js 가 화면을 통째로 다시 그린다)
}


function syncText(a) {
  if (a.status === 'syncing') return '저장하는 중…';
  if (a.status === 'error') return '';
  if (a.lastSaved) {
    const t = a.lastSaved;
    return `학습 기록이 계정에 저장돼요 · 마지막 저장 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }
  return '학습 기록이 계정에 저장돼요';
}

function updateSyncText(root, a) {
  const el = root.querySelector('.account-sync');
  if (el) el.textContent = syncText(a);
}

// 계정 카드: 이메일+비밀번호로 로그인·가입 / 로그인한 사람 / 로그아웃
let formMode = 'login'; // login | signup (다시 그려도 유지)

function loginForm(err) {
  const signup = formMode === 'signup';
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, placeholder: 'example@email.com' });
  const pw = h('input', {
    type: 'password', name: 'password', required: true, minlength: String(MIN_PASSWORD),
    autocomplete: signup ? 'new-password' : 'current-password',
    placeholder: signup ? `${MIN_PASSWORD}자 이상` : '',
  });
  const name = signup ? h('input', { type: 'text', name: 'name', autocomplete: 'nickname', maxlength: '40', placeholder: '선택' }) : null;
  const msg = h('p.notice.small', { role: 'alert', hidden: !err }, err || '');
  const submit = h('button.btn.primary', { type: 'submit' }, signup ? '가입하고 시작하기' : '로그인');
  const form = h('form.account-form', { novalidate: true },
    h('label.field', h('span', '이메일'), email),
    h('label.field', h('span', '비밀번호'), pw),
    signup ? h('label.field', h('span', '이름 (화면에 보일 이름)'), name) : null,
    msg,
    h('div.row', submit,
      h('button.btn.ghost', {
        type: 'button',
        onclick: () => { formMode = signup ? 'login' : 'signup'; form.closest('.account-card').replaceWith(accountCard()); },
      }, signup ? '이미 계정이 있어요' : '처음이에요 (가입하기)')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const show = (t) => { msg.textContent = t; msg.hidden = false; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return show('이메일 주소를 확인해 주세요.');
    if (pw.value.length < MIN_PASSWORD) return show(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 해요.`);
    submit.disabled = true;
    msg.hidden = true;
    try {
      if (signup) await signUp(email.value, pw.value, name.value);
      else await signIn(email.value, pw.value);
      formMode = 'login';
      toast(signup ? '가입했어요! 이제 기록이 계정에 저장돼요.' : '로그인했어요.', { type: 'good' });
    } catch (err) {
      show(err.message || '로그인하지 못했어요.');
      submit.disabled = false;
    }
  });
  setTimeout(() => { if (document.activeElement === document.body) email.focus({ preventScroll: true }); }, 0);
  return form;
}

function accountCard() {
  const a = accountInfo();
  if (!a.enabled) return null;
  const err = a.status === 'error' && a.error ? h('p.notice.small', a.error) : null;
  if (a.status === 'loading') {
    return h('section.card.account-card', h('h2', '계정'), h('p.muted.small', '로그인 상태를 확인하는 중…'), err);
  }
  if (!a.user) {
    return h('section.card.account-card',
      h('h2', formMode === 'signup' ? '계정 만들기' : '계정'),
      h('p.small', '로그인하면 학습 기록(XP, 연속 학습일, 배운 단어, 레슨)이 내 계정에 저장돼요. 다른 기기에서 로그인해도 이어서 공부할 수 있어요.'),
      h('p.muted.small', '이 기기에서 로그인 전에 한 공부도 계정 기록에 합쳐져요. 비밀번호는 잊어버리면 찾을 수 없으니 꼭 기억해 두세요.'),
      loginForm(a.status === 'error' ? a.error : ''),
    );
  }
  const u = a.user;
  const out = h('button.btn.ghost', { type: 'button' }, '로그아웃');
  out.addEventListener('click', async () => {
    if (!confirm('로그아웃할까요? 기록은 계정에 저장돼 있고, 이 기기에서는 지워져요.')) return;
    out.disabled = true;
    try {
      await signOut();
      applyTheme();
      toast('로그아웃했어요.');
    } catch (e) {
      toast('로그아웃하지 못했어요: ' + (e.message || e));
      out.disabled = false;
    }
  });
  return h('section.card.account-card',
    h('h2', '계정'),
    h('div.account-row',
      h('span.account-photo', { 'aria-hidden': 'true' }, (u.name || u.email || '?').slice(0, 1).toUpperCase()),
      h('div.account-who', h('b', u.name || u.email.split('@')[0]), h('span.small.muted', u.email)),
      out,
    ),
    h('p.small.muted.account-sync', syncText(a)),
    err,
  );
}

// 내 VRM 아바타 불러오기 / 되돌리기 (파일은 이 브라우저에만 보관)
function avatarFileRow(mine) {
  const input = h('input', { type: 'file', accept: '.vrm,model/gltf-binary', hidden: true, 'aria-label': 'VRM 파일 고르기' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      await saveCustomAvatar(f);
      toast('내 아바타를 저장했어요. 화면을 다시 불러올게요.', { type: 'good' });
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast(err.message || '파일을 저장하지 못했어요.', { type: 'bad' });
    }
  });
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  return h('div.settings-row.avatar-file',
    h('span', '내 아바타'),
    h('div.stack-tight',
      h('p.small.muted', mine
        ? `지금: ${mine.name} (${mb(mine.size)}) — 이 브라우저에만 저장돼 있어요.`
        : 'VRoid Studio 등에서 만든 VRM(.vrm) 파일을 불러와 3D 아바타로 쓸 수 있어요. 파일은 서버로 보내지 않고 이 브라우저에만 저장돼요.'),
      mine && customAvatarFailed() ? h('p.notice.small', '이 파일을 아바타로 읽지 못해서 기본 아바타를 쓰고 있어요. 다른 VRM 파일을 골라 보세요.') : null,
      h('div.row',
        h('button.btn.small', { type: 'button', onclick: () => input.click() }, mine ? '다른 VRM 파일로 바꾸기' : 'VRM 파일 불러오기'),
        mine ? h('button.btn.small.ghost', {
          type: 'button',
          onclick: async () => {
            await clearCustomAvatar().catch(() => {});
            toast('기본 아바타로 되돌렸어요.');
            setTimeout(() => location.reload(), 500);
          },
        }, '기본 아바타로 되돌리기') : null,
      ),
      input,
    ),
  );
}

function build(root, c, redraw, mine) {
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
    accountCard(),
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
      avatarFileRow(mine),
      toggle('효과음 끄기', 'muted'),
      toggle('뷰어를 처음부터 거울 모드로', 'mirrorDefault'),
    ),

    h('section.card',
      h('h2', '진도 저장'),
      h('p.muted.small', accountInfo().user
        ? '로그인돼 있어서 진도가 계정에 자동으로 저장돼요. 파일로도 따로 내보내 둘 수 있어요.'
        : '진도는 이 브라우저에만 저장돼요. 기기를 바꾸거나 캐시를 지우기 전에 파일로 내보내 두세요.' + (accountInfo().enabled ? ' 로그인하면 계정에 자동으로 저장돼요.' : '')),
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
