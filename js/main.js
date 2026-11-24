// 진입점: 해시 라우터
import { clear, errorView, loadingView, applyTheme } from './ui.js';
import { getState, onChange, currentStreak, storageOK } from './learn/progress.js';
import { initAccount, onAccountChange, accountInfo } from './account.js';

const routes = [
  { pattern: /^\/?$/, nav: 'home', load: () => import('./pages/home.js') },
  { pattern: /^\/learn$/, nav: 'learn', load: () => import('./learn/path.js') },
  { pattern: /^\/lesson\/([^/]+)$/, nav: 'learn', load: () => import('./learn/lesson.js'), keys: ['id'], immersive: true },
  { pattern: /^\/review$/, nav: 'learn', load: () => import('./pages/review.js'), immersive: true },
  { pattern: /^\/dict$/, nav: 'dict', load: () => import('./pages/dict.js') },
  { pattern: /^\/word\/([^/]+)$/, nav: 'dict', load: () => import('./pages/word.js'), keys: ['word'] },
  { pattern: /^\/sentence$/, nav: 'sentence', load: () => import('./sentence/sentence-page.js') },
  { pattern: /^\/profile$/, nav: 'profile', load: () => import('./pages/profile.js') },
  { pattern: /^\/reset-password$/, nav: 'profile', load: () => import('./pages/reset-password.js') },
];

const main = document.getElementById('main');
let cleanups = [];
let renderId = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

function runCleanups() {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch (e) { console.error(e); }
  }
}

async function route() {
  const id = ++renderId;
  const { path, query } = parseHash();
  let match = null;
  let route = null;
  for (const r of routes) {
    match = path.match(r.pattern);
    if (match) { route = r; break; }
  }
  runCleanups();
  clear(main);
  document.body.classList.toggle('immersive', !!route?.immersive);
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = route && a.dataset.nav === route.nav;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  if (!route) {
    main.append(errorView('페이지를 찾을 수 없어요.'));
    return;
  }
  const params = {};
  (route.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });

  const loading = loadingView();
  main.append(loading);
  const ctx = {
    params,
    query,
    onCleanup: (fn) => cleanups.push(fn),
    isCurrent: () => id === renderId,
  };
  // 새 화면은 맨 위에서 시작 (렌더가 오래 걸리는 화면도 바로 올라가게 먼저 올린다)
  if (!query.has('keep-scroll')) window.scrollTo(0, 0);
  try {
    const mod = await route.load();
    if (id !== renderId) return;
    loading.remove();
    await mod.render(main, ctx);
  } catch (err) {
    if (id !== renderId) return;
    clear(main);
    main.append(errorView(err));
  }
  if (id === renderId && !query.has('keep-scroll')) window.scrollTo(0, 0);
}

// 머리글의 스트릭·XP
function updateHeader() {
  const s = getState();
  document.getElementById('hdr-streak').textContent = `🔥 ${currentStreak()}`;
  document.getElementById('hdr-xp').textContent = `⭐ ${s.xp}`;
  document.getElementById('storage-warning').hidden = storageOK;
}

// 머리글의 계정 표시: 로그인 전 "로그인", 로그인 후 이름 첫 글자
function updateAccountChip() {
  const el = document.getElementById('hdr-account');
  const a = accountInfo();
  el.hidden = !a.enabled;
  if (!a.enabled) return;
  el.replaceChildren();
  el.classList.toggle('signed-in', !!a.user);
  if (a.user) {
    const label = `${a.user.name || a.user.email} 계정${a.status === 'error' ? ' (저장 오류)' : ''}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.append((a.user.name || a.user.email || '?').slice(0, 1).toUpperCase());
    el.classList.toggle('error', a.status === 'error');
  } else {
    el.title = '로그인하면 학습 기록이 계정에 저장돼요';
    el.removeAttribute('aria-label');
    el.classList.remove('error');
    el.textContent = a.status === 'loading' ? '…' : '로그인';
  }
}

applyTheme();
updateHeader();
updateAccountChip();
onChange(() => { updateHeader(); });
onAccountChange(updateAccountChip);
// 로그인해서 계정의 기록을 합쳤으면 지금 화면을 새 기록으로 다시 그린다 (레슨·복습 중에는 방해하지 않음)
window.addEventListener('signdict:synced', () => {
  if (!document.body.classList.contains('immersive')) route();
});
// 비밀번호 재설정 메일의 링크(?userId=…&secret=…)로 들어오면 재설정 화면으로
{
  const q = new URLSearchParams(location.search);
  if (q.has('userId') && q.has('secret') && !location.hash.startsWith('#/reset-password')) {
    history.replaceState(null, '', location.pathname + location.search + '#/reset-password');
  }
}
window.addEventListener('hashchange', route);
route();
initAccount();
