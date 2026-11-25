// Appwrite Function "reminders": 정해 둔 시간에 수달이가 공부 알림(웹 푸시)을 보낸다.
//
//  - 일정(1시간마다 — 무료 요금제의 가장 짧은 간격): 알림 시간(몇 시)이 된 사람에게 보낸다. 오늘 이미 공부했으면 보내지 않는다.
//  - GET  /vapid : 브라우저가 알림을 구독할 때 쓰는 공개 키
//  - POST /test  : 부른 사람(로그인한 사용자)에게 시험 알림 한 번
//
// 표 (데이터베이스 signdict)
//  - reminders : 행 ID = 사용자 ID. enabled, time("HH:MM"), tz(시간대), subs(구독 목록 JSON), lastSent(마지막으로 보낸 날짜)
//  - progress  : 학습 기록 (오늘 공부했는지, 스트릭 확인용으로 읽기만)
//  - config    : 행 "vapid" 에 알림 서명 키. 처음 실행할 때 함수가 직접 만들고, 권한을 주지 않아 서버만 읽는다.
//
// API 키는 Appwrite 가 실행마다 넣어 주는 x-appwrite-key 를 쓴다 (함수 설정의 Scopes: rows.read, rows.write).
import { Client, TablesDB, Query } from 'node-appwrite';
import * as webpush from 'web-push';

const DB = 'signdict';
const SITE = 'https://seoyulwoo1206.github.io/sign-dictionary/';
// 알림 시간(정각)이 지나고 이 안에 실행되면 보낸다. 함수는 매시간 같은 분에 돌기 때문에
// 20시로 정하면 20:00~20:59 사이 어느 한 때(날마다 거의 같은 때)에 도착한다. 조금 늦게 돌아도 놓치지 않게 5분 여유.
const WINDOW_MIN = 65;

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'] ?? '');
  const db = new TablesDB(client);
  const keys = await vapidKeys(db);
  webpush.setVapidDetails(SITE, keys.publicKey, keys.privateKey);

  const trigger = req.headers['x-appwrite-trigger'];
  if (trigger === 'schedule') {
    const r = await runSchedule(db, log, error);
    log(`checked ${r.checked}, sent ${r.sent}, skipped(studied) ${r.studied}`);
    return res.json(r);
  }

  if (req.path === '/vapid') return res.json({ publicKey: keys.publicKey });

  if (req.path === '/test') {
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) return res.json({ ok: false, error: 'login' }, 401);
    const row = await getRow(db, 'reminders', userId);
    if (!row) return res.json({ ok: false, error: 'no-subscription' }, 404);
    const sent = await sendToRow(db, row, {
      title: '수달이예요 🦦',
      body: '알림이 잘 와요! 정해 둔 시간에 이렇게 알려 드릴게요.',
      url: SITE + '#/',
    }, error);
    return res.json({ ok: sent > 0, sent });
  }

  return res.json({ ok: false, error: 'unknown path' }, 404);
};

// ---------- 키 ----------
async function vapidKeys(db) {
  const row = await getRow(db, 'config', 'vapid');
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  try {
    await db.createRow({ databaseId: DB, tableId: 'config', rowId: 'vapid', data: { value: JSON.stringify(keys) }, permissions: [] });
    return keys;
  } catch (e) {
    // 동시에 두 번 실행돼 이미 만들어졌으면 그것을 쓴다
    const again = await getRow(db, 'config', 'vapid');
    if (again) return JSON.parse(again.value);
    throw e;
  }
}

async function getRow(db, tableId, rowId) {
  try {
    return await db.getRow({ databaseId: DB, tableId, rowId });
  } catch (e) {
    if (e?.code === 404) return null;
    throw e;
  }
}

// ---------- 시간 ----------
// 그 사람 시간대의 지금 날짜("YYYY-MM-DD")와 분(0~1439)
function localNow(tz, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return localNow('Asia/Seoul', now);
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ---------- 일정 실행 ----------
async function runSchedule(db, log, error) {
  const out = { checked: 0, sent: 0, studied: 0 };
  let cursor = null;
  for (;;) {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await db.listRows({ databaseId: DB, tableId: 'reminders', queries });
    for (const row of page.rows) {
      out.checked++;
      try {
        const r = await maybeSend(db, row, error);
        if (r === 'sent') out.sent++;
        if (r === 'studied') out.studied++;
      } catch (e) {
        error(`row ${row.$id}: ${e?.message || e}`);
      }
    }
    if (page.rows.length < 100) break;
    cursor = page.rows[page.rows.length - 1].$id;
  }
  return out;
}

async function maybeSend(db, row, error) {
  if (!row.enabled) return 'off';
  const target = toMinutes(row.time);
  if (target === null) return 'off';
  const now = localNow(row.tz);
  if (row.lastSent === now.date) return 'done';
  const diff = now.minutes - target;
  if (diff < 0 || diff >= WINDOW_MIN) return 'wait';

  // 오늘 이미 공부했으면 보내지 않는다
  const prog = await getRow(db, 'progress', row.$id);
  let s = null;
  try { s = prog?.progressJson ? JSON.parse(prog.progressJson) : null; } catch { s = null; }
  const lastDate = s?.streak?.lastDate || '';
  await db.updateRow({ databaseId: DB, tableId: 'reminders', rowId: row.$id, data: { lastSent: now.date } });
  if (lastDate === now.date) return 'studied';

  const streak = lastDate === addDays(now.date, -1) ? (s?.streak?.count || 0) : 0;
  const due = s?.words ? Object.values(s.words).filter((w) => w && w.due && w.due <= now.date).length : 0;
  const sent = await sendToRow(db, row, message(streak, due, now.date), error);
  return sent ? 'sent' : 'none';
}

const NUDGES = [
  '오늘 수어 한 단어 배워 볼까요?',
  '레슨 하나는 5분이면 끝나요!',
  '손 풀고 같이 수어 해요 👋',
  '수달이가 새 단어를 들고 기다리고 있어요.',
];

function message(streak, due, date) {
  const pick = NUDGES[Number(date.replaceAll('-', '')) % NUDGES.length];
  if (streak > 0) {
    return {
      title: `🔥 ${streak}일 스트릭을 지켜요!`,
      body: `오늘 레슨 하나면 ${streak + 1}일째예요. 수달이가 기다려요 🦦`,
      url: SITE + '#/',
    };
  }
  if (due > 0) {
    return { title: '수달이가 기다려요 🦦', body: `복습할 단어 ${due}개가 있어요. ${pick}`, url: SITE + '#/review' };
  }
  return { title: '수달이가 기다려요 🦦', body: pick, url: SITE + '#/' };
}

// ---------- 보내기 ----------
// 그 사람의 모든 기기(구독)로 보낸다. 없어진 구독(404/410)은 목록에서 뺀다.
async function sendToRow(db, row, payload, error) {
  let subs = [];
  try { subs = JSON.parse(row.subs || '[]'); } catch { subs = []; }
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  const keep = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 6, urgency: 'normal', topic: 'daily-reminder' });
      sent++;
      keep.push(sub);
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) continue; // 알림을 끈 기기
      error(`push ${row.$id}: ${e?.statusCode || ''} ${e?.body || e?.message || e}`);
      keep.push(sub);
    }
  }
  if (keep.length !== subs.length) {
    await db.updateRow({ databaseId: DB, tableId: 'reminders', rowId: row.$id, data: { subs: JSON.stringify(keep), enabled: keep.length > 0 } });
  }
  return sent;
}

// 시험용 (node 로 직접 돌려 보기)
export const _test = { localNow, addDays, toMinutes, message };
