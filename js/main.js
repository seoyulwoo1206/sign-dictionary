// 진입점: 해시 라우터
import { clear, errorView, loadingView, applyTheme } from './ui.js';
import { getState, onChange, currentStreak, storageOK } from './learn/progress.js';

const routes = [
  { pattern: /^\/?$/, nav: 'home', load: () => import('./pages/home.js') },
  { pattern: /^\/learn$/, nav: 'learn', load: () => import('./learn/path.js') },
  { pattern: /^\/lesson\/([^/]+)$/, nav: 'learn', load: () => import('./learn/lesson.js'), keys: ['id'], immersive: true },
  { pattern: /^\/review$/, nav: 'learn', load: () => import('./pages/review.js'), immersive: true },
  { pattern: /^\/dict$/, nav: 'dict', load: () => import('./pages/dict.js') },
  { pattern: /^\/word\/([^/]+)$/, nav: 'dict', load: () => import('./pages/word.js'), keys: ['word'] },
  { pattern: /^\/sentence$/, nav: 'sentence', load: () => import('./sentence/sentence-page.js') },
  { pattern: /^\/profile$/, nav: 'profile', load: () => import('./pages/profile.js') },
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

applyTheme();
updateHeader();
onChange(() => { updateHeader(); });
window.addEventListener('hashchange', route);
route();
