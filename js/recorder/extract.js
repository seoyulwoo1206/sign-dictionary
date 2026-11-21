// MediaPipe Tasks Vision 래퍼
// HolisticLandmarker를 먼저 시도하고, 안 되면 Pose + Hand + Face 세 모델을 함께 쓴다.

import {
  FilesetResolver,
  HolisticLandmarker,
  PoseLandmarker,
  HandLandmarker,
  FaceLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { collectHolistic, collectSeparate } from './normalize.js';

export const MEDIAPIPE_VERSION = '0.10.14';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
export const MODEL_URLS = {
  holistic: `${MODEL_BASE}/holistic_landmarker/holistic_landmarker/float16/1/holistic_landmarker.task`,
  pose: `${MODEL_BASE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  hand: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  face: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
};
const MODEL_LABELS = { holistic: '통합(Holistic)', pose: '몸', hand: '손', face: '얼굴' };

const modelCache = new Map(); // 같은 모델을 다시 받지 않도록 보관
let filesetPromise = null;

// 모델 파일을 받으면서 진행률을 알려 준다
async function fetchModel(key, onStatus) {
  if (modelCache.has(key)) return modelCache.get(key);
  const label = MODEL_LABELS[key];
  const res = await fetch(MODEL_URLS[key]);
  if (!res.ok) throw new Error(`${label} 모델을 내려받지 못했습니다 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let buffer;
  if (res.body && total) {
    const reader = res.body.getReader();
    buffer = new Uint8Array(total);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > buffer.length) { // 압축 전송 등으로 길이가 다를 때
        const bigger = new Uint8Array((received + value.length) * 2);
        bigger.set(buffer.subarray(0, received));
        buffer = bigger;
      }
      buffer.set(value, received);
      received += value.length;
      onStatus?.(`${label} 모델 내려받는 중… ${Math.min(100, Math.round((received / total) * 100))}%`,
        Math.min(1, received / total));
    }
    buffer = buffer.subarray(0, received);
  } else {
    onStatus?.(`${label} 모델 내려받는 중…`, null);
    buffer = new Uint8Array(await res.arrayBuffer());
  }
  modelCache.set(key, buffer);
  return buffer;
}

function getFileset() {
  filesetPromise ??= FilesetResolver.forVisionTasks(WASM_URL).catch((e) => {
    filesetPromise = null;
    throw e;
  });
  return filesetPromise;
}

async function createHolistic(delegate, onStatus) {
  const model = await fetchModel('holistic', onStatus);
  onStatus?.('통합(Holistic) 모델 준비 중…', null);
  const task = await HolisticLandmarker.createFromOptions(await getFileset(), {
    baseOptions: { modelAssetBuffer: model, delegate },
    runningMode: 'VIDEO',
  });
  return {
    kind: 'holistic',
    run: (image, ts) => collectHolistic(task.detectForVideo(image, ts)),
    close: () => task.close(),
  };
}

async function createSeparate(delegate, onStatus) {
  const poseModel = await fetchModel('pose', onStatus);
  const handModel = await fetchModel('hand', onStatus);
  const faceModel = await fetchModel('face', onStatus);
  onStatus?.('몸·손·얼굴 모델 준비 중…', null);
  const fileset = await getFileset();
  const created = [];
  try {
    const pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: poseModel, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    created.push(pose);
    const hand = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: handModel, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    created.push(hand);
    const face = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceModel, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    created.push(face);
    return {
      kind: 'separate',
      run: (image, ts) => collectSeparate(
        pose.detectForVideo(image, ts),
        hand.detectForVideo(image, ts),
        face.detectForVideo(image, ts),
      ),
      close: () => created.forEach((t) => t.close()),
    };
  } catch (e) {
    created.forEach((t) => { try { t.close(); } catch { /* 무시 */ } });
    throw e;
  }
}

// 추출기를 만든다.
//   engine: 'auto'(Holistic 우선, 실패하면 분리 모델) | 'holistic' | 'separate'
//   onStatus(message, progress 0~1 | null)
// 반환: { kind, delegate, detect(image, tsMs), close() }
//   detect는 { pose, hands, face }를 돌려준다 (normalize.js의 toRawFrame에 넘긴다).
export async function createExtractor({ engine = 'auto', onStatus } = {}) {
  const attempts = [];
  if (engine !== 'separate') attempts.push(['holistic', 'GPU'], ['holistic', 'CPU']);
  if (engine !== 'holistic') attempts.push(['separate', 'GPU'], ['separate', 'CPU']);

  let impl = null;
  let implIndex = -1;
  let lastError = null;
  const createFrom = async (start) => {
    for (let i = start; i < attempts.length; i++) {
      const [kind, delegate] = attempts[i];
      try {
        impl = kind === 'holistic'
          ? await createHolistic(delegate, onStatus)
          : await createSeparate(delegate, onStatus);
        implIndex = i;
        return;
      } catch (e) {
        lastError = e;
        console.warn(`[recorder] ${kind}/${delegate} 초기화 실패`, e);
      }
    }
    impl = null;
    throw lastError ?? new Error('모델을 초기화하지 못했습니다');
  };
  await createFrom(0);

  let lastTs = 0;
  let succeeded = false;
  const extractor = {
    get kind() { return impl.kind; },
    get delegate() { return attempts[implIndex][1]; },
    // image: video / canvas 등. tsMs: 계속 커지는 시각(ms) — 작거나 같으면 자동으로 올린다.
    async detect(image, tsMs) {
      const ts = Math.max(Math.round(tsMs), lastTs + 1);
      lastTs = ts;
      try {
        const out = impl.run(image, ts);
        succeeded = true;
        return out;
      } catch (e) {
        // 첫 실행부터 실패하면 다음 후보(다른 delegate / 분리 모델)로 바꿔 한 번 더 해 본다
        if (succeeded || implIndex >= attempts.length - 1) throw e;
        console.warn('[recorder] 추출 실패, 다른 방식으로 전환', e);
        try { impl.close(); } catch { /* 무시 */ }
        await createFrom(implIndex + 1);
        return extractor.detect(image, lastTs + 1);
      }
    },
    get lastTs() { return lastTs; },
    close() { try { impl?.close(); } catch { /* 무시 */ } },
  };
  return extractor;
}
