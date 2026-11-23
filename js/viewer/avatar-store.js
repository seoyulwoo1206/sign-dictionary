// 사용자가 고른 VRM 아바타 파일을 이 브라우저(IndexedDB)에 보관한다.
// 서버로 보내지 않는다. 다른 기기·브라우저에는 따로 불러와야 한다.

const DB = 'sign-dict';
const STORE = 'files';
const KEY = 'custom-avatar';
export const MAX_AVATAR_BYTES = 60 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('이 브라우저는 파일 저장을 지원하지 않아요')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

// glb(VRM) 파일인지: 앞 4바이트가 'glTF'
export function isGlb(buffer) {
  return buffer && buffer.byteLength >= 20 && new DataView(buffer).getUint32(0, true) === 0x46546c67;
}

// { name, size, savedAt, buffer } 또는 null
export async function getCustomAvatar() {
  try {
    const v = await tx('readonly', (s) => s.get(KEY));
    return v && isGlb(v.buffer) ? v : null;
  } catch { return null; }
}

export async function saveCustomAvatar(file) {
  if (file.size > MAX_AVATAR_BYTES) throw new Error(`파일이 너무 커요 (${Math.round(file.size / 1048576)}MB, 최대 60MB)`);
  const buffer = await file.arrayBuffer();
  if (!isGlb(buffer)) throw new Error('VRM(.vrm) 파일이 아니에요');
  await tx('readwrite', (s) => s.put({ name: file.name, size: file.size, savedAt: Date.now(), buffer }, KEY));
}

export async function clearCustomAvatar() {
  await tx('readwrite', (s) => s.delete(KEY));
}
