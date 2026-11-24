// 계정: 이메일+비밀번호 로그인(Appwrite) + 학습 기록을 계정에 저장
//
//  - 로그인하면 이 기기의 기록과 계정에 저장된 기록을 합친다 (어느 쪽에서 한 공부도 잃지 않게).
//  - 그 뒤로 기록이 바뀔 때마다 잠시 기다렸다가 계정에 저장한다.
//  - 다른 기기에서 공부하고 돌아오면(이 탭을 다시 볼 때) 계정의 기록을 다시 합친다.
//  - 로그아웃하면 이 기기의 학습 기록을 지운다 (같은 기기를 쓰는 다음 사람에게 보이지 않게). 화면 설정은 남긴다.
//
// 저장 위치: Appwrite TablesDB  signdict / progress  의 행 하나 (행 ID = 사용자 ID, 열 progressJson)
// 권한: 표는 "로그인한 사용자: 만들기"만, 행은 만든 사람만 읽기·고치기·지우기 (행 단위 보안 켬)
// Appwrite 라이브러리는 설정이 있을 때만 불러온다.
import { appwriteConfig as CFG } from './appwrite-config.js';
import { getState, onChange, replaceState, mergeProgress, resetProgress } from './learn/progress.js';

const SDK = 'https://cdn.jsdelivr.net/npm/appwrite@29.2.0/+esm';
const SAVE_DELAY = 1500; // ms: 기록이 바뀐 뒤 이만큼 조용하면 저장
export const MIN_PASSWORD = 8;

export const accountEnabled = !!(CFG && CFG.projectId);

let aw = null;        // { sdk, account, tables }
let user = null;
let status = accountEnabled ? 'loading' : 'off'; // off | loading | signed-out | syncing | saved | error
let errorText = '';
let lastSaved = null;
let lastUploaded = '';
let rowExists = false;
let pulling = false;
let timer = null;
let uploading = null;
let started = false;
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
    user: user ? { name: user.name || '', email: user.email || '' } : null,
  };
}

function setStatus(s, err = '') {
  status = s;
  errorText = err;
  emit();
}

// Appwrite 오류 → 알아듣기 쉬운 말
export function errorMessage(e) {
  const type = e?.type || '';
  if (type === 'user_invalid_credentials') return '이메일이나 비밀번호가 맞지 않아요.';
  if (type === 'user_already_exists') return '이미 가입된 이메일이에요. 로그인해 주세요.';
  if (type === 'user_password_mismatch' || type === 'password_recently_used') return '비밀번호를 다시 확인해 주세요.';
  if (type === 'password_personal_data') return '비밀번호에 이름이나 이메일을 넣지 말아 주세요.';
  if (type === 'user_blocked') return '이 계정은 사용할 수 없게 막혀 있어요.';
  if (type === 'general_rate_limit_exceeded' || e?.code === 429) return '너무 여러 번 시도했어요. 잠시 뒤에 다시 해 주세요.';
  if (type === 'general_argument_invalid') {
    if (/email/i.test(e.message)) return '이메일 주소 형식이 올바르지 않아요.';
    if (/password/i.test(e.message)) return `비밀번호는 ${MIN_PASSWORD}자 이상이어야 해요.`;
  }
  if (type === 'user_invalid_token') return '재설정 링크가 만료됐거나 이미 사용했어요. 비밀번호 찾기를 다시 해 주세요.';
  if (type === 'project_invalid_host' || (type === 'general_argument_invalid' && /url/i.test(e.message))) return '이 주소에서는 비밀번호 재설정을 쓸 수 없어요.';
  if (type === 'user_unauthorized' || e?.code === 401) return '로그인이 풀렸어요. 다시 로그인해 주세요.';
  if (e?.code === 403) return '계정 저장소에 접근할 수 없어요. (Appwrite 권한 설정 확인 필요)';
  if (e instanceof TypeError || /fetch|network/i.test(e?.message || '')) return '인터넷 연결을 확인해 주세요.';
  return e?.message || '알 수 없는 오류가 났어요.';
}

async function load() {
  if (aw) return aw;
  const sdk = await import(SDK);
  // setLocale('ko'): Appwrite 가 보내는 메일(비밀번호 재설정 등)을 한국어로
  const client = new sdk.Client().setEndpoint(CFG.endpoint).setProject(CFG.projectId).setLocale('ko');
  aw = { sdk, account: new sdk.Account(client), tables: new sdk.TablesDB(client) };
  return aw;
}

const rowRef = () => ({ databaseId: CFG.databaseId, tableId: CFG.tableId, rowId: user.$id });

// 계정의 기록을 가져와 이 기기의 기록과 합친다
async function pull() {
  if (!user || pulling) return;
  pulling = true;
  setStatus('syncing');
  try {
    const before = JSON.stringify(getState());
    let merged = getState();
    try {
      const row = await aw.tables.getRow(rowRef());
      rowExists = true;
      lastUploaded = row.progressJson || '';
      if (row.progressJson) merged = mergeProgress(getState(), JSON.parse(row.progressJson));
    } catch (e) {
      if (e?.code !== 404) throw e;
      rowExists = false; // 아직 저장한 적 없음
      lastUploaded = '';
    }
    pulling = false;
    replaceState(merged); // 바뀌었으면 onChange → 저장 예약
    if (JSON.stringify(getState()) !== before) window.dispatchEvent(new Event('signdict:synced'));
    await upload();
  } catch (e) {
    pulling = false;
    console.error(e);
    setStatus('error', errorMessage(e));
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
  const { Permission, Role } = aw.sdk;
  const mine = Role.user(user.$id);
  uploading = rowExists
    ? aw.tables.updateRow({ ...rowRef(), data: { progressJson: text } })
    : aw.tables.createRow({
      ...rowRef(),
      data: { progressJson: text },
      permissions: [Permission.read(mine), Permission.update(mine), Permission.delete(mine)],
    });
  try {
    await uploading;
    rowExists = true;
    lastUploaded = text;
    lastSaved = new Date();
    setStatus('saved');
  } catch (e) {
    console.error(e);
    if (e?.code === 409) rowExists = true; // 다른 기기가 먼저 만들었으면 다음엔 고친다
    if (e?.code === 404) rowExists = false;
    setStatus('error', errorMessage(e));
  } finally {
    uploading = null;
  }
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; upload(); }
}

// 로그인된 사용자로 시작
async function startSession(u) {
  user = u;
  lastUploaded = '';
  rowExists = false;
  await pull();
}

// 페이지를 열 때 한 번 부른다
export async function initAccount() {
  if (!accountEnabled || started) return;
  started = true;
  try {
    await load();
  } catch (e) {
    console.error(e);
    setStatus('error', '로그인 기능을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    return;
  }
  onChange(scheduleUpload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (user) pull();
  });
  window.addEventListener('pagehide', flush);
  try {
    await startSession(await aw.account.get());
  } catch (e) {
    user = null;
    if (e?.code === 401) setStatus('signed-out');
    else setStatus('error', errorMessage(e));
  }
}

// 로그인 (실패하면 알아듣기 쉬운 말로 된 Error 를 던진다)
export async function signIn(email, password) {
  await load();
  try {
    await aw.account.createEmailPasswordSession({ email: email.trim(), password });
  } catch (e) {
    // 이미 로그인된 세션이 남아 있으면 그대로 쓴다
    if (e?.type !== 'user_session_already_exists') throw new Error(errorMessage(e));
  }
  await startSession(await aw.account.get());
}

// 가입 후 바로 로그인
export async function signUp(email, password, name = '') {
  await load();
  try {
    await aw.account.create({ userId: aw.sdk.ID.unique(), email: email.trim(), password, name: name.trim() || undefined });
  } catch (e) {
    throw new Error(errorMessage(e));
  }
  await signIn(email, password);
}

export async function signOut() {
  if (!aw || !user) return;
  clearTimeout(timer);
  timer = null;
  // 마지막 기록까지 저장하고 나간다 (인터넷이 끊겨 있으면 오래 기다리지 않는다)
  await Promise.race([upload(), new Promise((r) => setTimeout(r, 4000))]);
  try { await aw.account.deleteSession({ sessionId: 'current' }); } catch (e) { console.warn(e); }
  user = null;
  lastUploaded = '';
  rowExists = false;
  resetProgress({ keepSettings: true });
  setStatus('signed-out');
}

// ---------- 비밀번호 찾기 ----------

// 비밀번호 재설정 메일을 보낸다. 메일의 링크를 누르면 이 사이트의 #/reset-password 화면이 열린다.
// 가입되지 않은 이메일이어도 같은 결과를 돌려준다 (누가 가입했는지 알아낼 수 없게).
export async function sendPasswordReset(email) {
  await load();
  // 링크 주소: 해시(#) 없이 지금 페이지 주소 — Appwrite 가 ?userId=…&secret=… 를 붙여 준다
  const url = location.origin + location.pathname;
  try {
    await aw.account.createRecovery({ email: email.trim(), url });
  } catch (e) {
    if (e?.code === 404 || e?.type === 'user_not_found') return; // 가입 안 된 이메일
    throw new Error(errorMessage(e));
  }
}

// 메일 링크로 들어온 사람의 새 비밀번호 저장
export async function resetPassword(userId, secret, password) {
  await load();
  try {
    await aw.account.updateRecovery({ userId, secret, password });
  } catch (e) {
    if (e?.code === 404) throw new Error(errorMessage({ type: 'user_invalid_token' }));
    throw new Error(errorMessage(e));
  }
}
