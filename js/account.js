// 계정: 구글 로그인(Firebase) + 학습 기록을 계정에 저장
//
//  - 로그인하면 이 기기의 기록과 계정에 저장된 기록을 합친다 (어느 쪽에서 한 공부도 잃지 않게).
//  - 그 뒤로 기록이 바뀔 때마다 잠시 기다렸다가 계정에 저장한다.
//  - 다른 기기에서 공부하고 돌아오면(이 탭을 다시 볼 때) 계정의 기록을 다시 합친다.
//  - 로그아웃하면 이 기기의 학습 기록을 지운다 (같은 기기를 쓰는 다음 사람에게 보이지 않게). 화면 설정은 남긴다.
//
// 저장 위치: Firestore  users/{로그인한 사람의 uid}  { progressJson, updatedAt, app }
// 보안 규칙: firestore.rules (본인 문서만 읽고 쓸 수 있음)
// Firebase 라이브러리는 설정이 있을 때만 불러온다 (설정이 없으면 로그인 기능이 꺼짐).
import { firebaseConfig } from './firebase-config.js';
import { getState, onChange, replaceState, mergeProgress, resetProgress } from './learn/progress.js';

const SDK = 'https://www.gstatic.com/firebasejs/11.0.2';
const SAVE_DELAY = 1500; // ms: 기록이 바뀐 뒤 이만큼 조용하면 저장

export const accountEnabled = !!(firebaseConfig && firebaseConfig.apiKey);

let fb = null;        // { A: auth 모듈, F: firestore 모듈, auth, db }
let user = null;
let status = accountEnabled ? 'loading' : 'off'; // off | loading | signed-out | syncing | saved | error
let errorText = '';
let lastSaved = null;
let lastUploaded = '';
let pulling = false;
let timer = null;
let uploading = null;
const listeners = new Set();

export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) {
    try { fn(accountInfo()); } catch (e) { console.error(e); }
  }
}

export function accountInfo() {
  return {
    enabled: accountEnabled,
    status,
    error: errorText,
    lastSaved,
    user: user ? { name: user.displayName || '', email: user.email || '', photo: user.photoURL || '' } : null,
  };
}

function setStatus(s, err = '') {
  status = s;
  errorText = err;
  emit();
}

function message(e) {
  const code = e?.code || '';
  if (code === 'auth/unauthorized-domain') return '이 사이트 주소가 Firebase에 등록되지 않았어요. (설정 안내의 "승인된 도메인" 단계)';
  if (code === 'auth/network-request-failed' || code === 'unavailable') return '인터넷 연결을 확인해 주세요.';
  if (code === 'permission-denied') return '계정 저장소에 접근할 수 없어요. (설정 안내의 "보안 규칙" 단계)';
  if (code === 'auth/operation-not-allowed') return 'Firebase에서 구글 로그인이 켜져 있지 않아요. (설정 안내의 "로그인 방법" 단계)';
  return e?.message || '알 수 없는 오류가 났어요.';
}

async function load() {
  if (fb) return fb;
  const [app, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(firebaseConfig);
  fb = { A, F, auth: A.getAuth(a), db: F.getFirestore(a) };
  return fb;
}

const docRef = () => fb.F.doc(fb.db, 'users', user.uid);

// 계정의 기록을 가져와 이 기기의 기록과 합친다
async function pull() {
  if (!user || pulling) return;
  pulling = true;
  setStatus('syncing');
  try {
    const before = JSON.stringify(getState());
    const snap = await fb.F.getDoc(docRef());
    let merged = getState();
    if (snap.exists()) {
      const text = snap.data().progressJson;
      lastUploaded = text || '';
      if (text) merged = mergeProgress(getState(), JSON.parse(text));
    }
    pulling = false;
    replaceState(merged); // 바뀌었으면 onChange → 저장 예약
    if (JSON.stringify(getState()) !== before) window.dispatchEvent(new Event('signdict:synced'));
    await upload();
  } catch (e) {
    pulling = false;
    console.error(e);
    setStatus('error', message(e));
  }
}

function scheduleUpload() {
  if (!user || pulling) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; upload(); }, SAVE_DELAY);
}

async function upload() {
  if (!user) return;
  if (uploading) await uploading.catch(() => {});
  const text = JSON.stringify(getState());
  if (text === lastUploaded) { lastSaved = lastSaved || new Date(); setStatus('saved'); return; }
  setStatus('syncing');
  uploading = fb.F.setDoc(docRef(), { progressJson: text, updatedAt: fb.F.serverTimestamp(), app: 'signdict' });
  try {
    await uploading;
    lastUploaded = text;
    lastSaved = new Date();
    setStatus('saved');
  } catch (e) {
    console.error(e);
    setStatus('error', message(e));
  } finally {
    uploading = null;
  }
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; upload(); }
}

// 페이지를 열 때 한 번 부른다
export async function initAccount() {
  if (!accountEnabled) return;
  try {
    await load();
  } catch (e) {
    console.error(e);
    setStatus('error', '로그인 기능을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    return;
  }
  // 리디렉트 방식으로 로그인했다가 돌아온 경우의 오류 확인
  fb.A.getRedirectResult(fb.auth).catch((e) => setStatus('error', message(e)));
  fb.A.onAuthStateChanged(fb.auth, (u) => {
    const changed = (u?.uid || null) !== (user?.uid || null);
    user = u;
    if (!u) { lastUploaded = ''; setStatus('signed-out'); return; }
    if (changed) pull();
  });
  onChange(scheduleUpload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (user) pull();
  });
  window.addEventListener('pagehide', flush);
}

export async function signIn() {
  await load();
  const provider = new fb.A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.A.signInWithPopup(fb.auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await fb.A.signInWithRedirect(fb.auth, provider);
      return;
    }
    setStatus('error', message(e));
    throw e;
  }
}

export async function signOut() {
  if (!fb || !user) return;
  clearTimeout(timer);
  timer = null;
  // 마지막 기록까지 저장하고 나간다 (인터넷이 끊겨 있으면 오래 기다리지 않는다)
  await Promise.race([upload(), new Promise((r) => setTimeout(r, 4000))]);
  await fb.A.signOut(fb.auth);
  user = null;
  lastUploaded = '';
  resetProgress({ keepSettings: true });
  setStatus('signed-out');
}
