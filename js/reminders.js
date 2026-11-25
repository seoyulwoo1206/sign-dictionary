// 공부 알림: 정해 둔 시간에 수달이가 웹 푸시 알림을 보낸다.
//
//  - 브라우저가 알림을 구독하면(pushManager.subscribe) 그 구독 정보를 Appwrite 표 reminders 의 내 행에 저장한다.
//    행 ID = 사용자 ID, 행 권한은 나만 읽기·고치기·지우기. 여러 기기를 쓰면 subs 목록에 기기마다 하나씩.
//  - 실제로 보내는 일은 Appwrite Function "reminders" 가 1시간마다 한다 (functions/reminders). 그래서 시간은 '몇 시' 단위.
//  - 아이폰·아이패드는 Safari 에서 "홈 화면에 추가"한 앱으로 열어야 알림을 받을 수 있다 (iOS 16.4+).
import { appwrite, accountInfo } from './account.js';

const MAX_DEVICES = 6;

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}

// 이 기기에서 알림을 쓸 수 있는지
//  ok | ios-install(홈 화면에 추가 필요) | unsupported | denied(브라우저에서 알림 차단됨)
export function pushSupport() {
  if (isIOS && !standalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

async function registration() {
  await navigator.serviceWorker.register('sw.js');
  return navigator.serviceWorker.ready;
}

async function callFunction(aw, path, method) {
  const ex = await aw.functions.createExecution({
    functionId: aw.config.reminderFunctionId, body: '', async: false, xpath: path, method,
  });
  let data = {};
  try { data = JSON.parse(ex.responseBody || '{}'); } catch { data = {}; }
  if (ex.status === 'failed' || ex.responseStatusCode >= 400) {
    const err = new Error(data.error || `알림 서버 오류 (${ex.responseStatusCode || ex.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

let vapidKey = null;
async function publicKey(aw) {
  if (!vapidKey) vapidKey = (await callFunction(aw, '/vapid', 'GET')).publicKey;
  return vapidKey;
}

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const ref = (aw) => ({ databaseId: aw.config.databaseId, tableId: aw.config.remindersTableId, rowId: aw.user.$id });

async function readRow(aw) {
  try {
    return await aw.tables.getRow(ref(aw));
  } catch (e) {
    if (e?.code === 404) return null;
    throw e;
  }
}

async function writeRow(aw, row, data) {
  if (row) return aw.tables.updateRow({ ...ref(aw), data });
  const { Permission, Role } = aw.sdk;
  const mine = Role.user(aw.user.$id);
  return aw.tables.createRow({
    ...ref(aw), data,
    permissions: [Permission.read(mine), Permission.update(mine), Permission.delete(mine)],
  });
}

const parseSubs = (row) => { try { return JSON.parse(row?.subs || '[]'); } catch { return []; } };

async function currentSubscription() {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function ready() {
  if (!accountInfo().user) throw new Error('로그인하면 알림을 받을 수 있어요.');
  const aw = await appwrite();
  if (!aw.user) throw new Error('로그인하면 알림을 받을 수 있어요.');
  return aw;
}

// 지금 상태: { enabled(계정에 켜져 있음), time, thisDevice(이 기기가 받는 중), devices }
export async function getReminder() {
  const aw = await ready();
  const row = await readRow(aw);
  const subs = parseSubs(row);
  const sub = await currentSubscription().catch(() => null);
  return {
    enabled: !!row?.enabled && subs.length > 0,
    time: row?.time || '20:00',
    thisDevice: !!sub && subs.some((s) => s.endpoint === sub.endpoint),
    devices: subs.length,
  };
}

// 이 기기에서 알림 켜기 (버튼을 누른 순간에 불러야 브라우저가 허락을 물어본다)
export async function enableReminder(time) {
  const support = pushSupport();
  if (support !== 'ok') throw new Error(supportMessage(support));
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림이 허용되지 않았어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.');
  const aw = await ready();
  const reg = await registration();
  const key = await publicKey(aw);
  let sub = await reg.pushManager.getSubscription();
  // 예전 키로 만든 구독이면 새로 만든다
  if (sub && sub.options?.applicationServerKey) {
    const old = new Uint8Array(sub.options.applicationServerKey);
    const now = b64ToBytes(key);
    if (old.length !== now.length || old.some((b, i) => b !== now[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  const json = sub.toJSON();
  const row = await readRow(aw);
  const subs = parseSubs(row).filter((s) => s.endpoint !== json.endpoint);
  subs.push({ endpoint: json.endpoint, keys: json.keys });
  await writeRow(aw, row, {
    enabled: true,
    time,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul',
    subs: JSON.stringify(subs.slice(-MAX_DEVICES)),
  });
}

// 알림 시간만 바꾸기 (모든 기기에 같이 적용)
export async function setReminderTime(time) {
  const aw = await ready();
  const row = await readRow(aw);
  if (!row) return;
  await writeRow(aw, row, { time, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || row.tz, lastSent: '' });
}

// 이 기기에서 알림 끄기
export async function disableReminder() {
  const aw = await ready();
  const sub = await currentSubscription().catch(() => null);
  const row = await readRow(aw);
  const subs = parseSubs(row).filter((s) => !sub || s.endpoint !== sub.endpoint);
  if (sub) await sub.unsubscribe().catch(() => {});
  if (row) await writeRow(aw, row, { subs: JSON.stringify(subs), enabled: subs.length > 0 });
}

// 시험 알림 한 번 보내기
export async function sendTestReminder() {
  const aw = await ready();
  const r = await callFunction(aw, '/test', 'POST');
  if (!r.sent) throw new Error('알림을 보내지 못했어요. 알림을 껐다가 다시 켜 보세요.');
  return r.sent;
}

export function supportMessage(reason) {
  if (reason === 'ios-install') return '아이폰·아이패드는 Safari 아래쪽 공유 버튼(□↑) → "홈 화면에 추가"를 한 뒤, 홈 화면의 수어사전 앱에서 알림을 켜 주세요.';
  if (reason === 'denied') return '이 브라우저에서 알림이 차단돼 있어요. 주소창 옆 자물쇠(사이트 설정)에서 알림을 "허용"으로 바꿔 주세요.';
  if (reason === 'unsupported') return '이 브라우저는 알림을 지원하지 않아요. 크롬이나 엣지, 사파리 최신 버전에서 열어 주세요.';
  return '';
}
