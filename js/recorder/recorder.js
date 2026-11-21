// 동작 데이터 제작 도구 — 화면 제어
// 흐름: (웹캠 녹화 | 영상 파일) → MediaPipe 추출 → 원시 프레임 보관
//       → 정규화 → 끊김 보간 → 스무딩 → 자르기 → 미리보기 / JSON 저장
// 영상 원본은 메모리에서만 쓰고 저장하지 않는다.

import { smoothFrames, fillGaps } from '../viewer/smoothing.js';
import { toRawFrame, resampleRaw, normalizeClip, findNeutralTrim } from './normalize.js';
import { drawSkeleton, drawRawOverlay } from './preview.js';
import {
  POS_LIST, JAMO_GROUPS, buildWordEntry, buildSignData, stringifySign, safeFileName,
} from './wordinfo.js';
import { initQueue } from './queue.js';

let onDownloaded = null; // 녹화 대기열에 알림

const $ = (id) => document.getElementById(id);
const el = {
  status: $('globalStatus'), progress: $('progress'),
  tabCam: $('tabCam'), tabFile: $('tabFile'), camControls: $('camControls'), fileControls: $('fileControls'),
  engine: $('engine'), fps: $('fps'), engineInfo: $('engineInfo'),
  stage: $('stage'), video: $('video'), overlay: $('overlay'), stageEmpty: $('stageEmpty'),
  countdown: $('countdown'), recBadge: $('recBadge'), recTime: $('recTime'),
  btnCam: $('btnCam'), btnRec: $('btnRec'), useCountdown: $('useCountdown'), mirror: $('mirror'),
  fileInput: $('fileInput'), btnExtract: $('btnExtract'), btnCancel: $('btnCancel'),
  front: $('front'), side: $('side'), btnPlay: $('btnPlay'), scrub: $('scrub'), frameLabel: $('frameLabel'),
  editBox: $('editBox'), trimStart: $('trimStart'), trimEnd: $('trimEnd'),
  trimStartLabel: $('trimStartLabel'), trimEndLabel: $('trimEndLabel'),
  btnAutoTrim: $('btnAutoTrim'), btnResetTrim: $('btnResetTrim'), trimInfo: $('trimInfo'),
  strength: $('strength'), strengthLabel: $('strengthLabel'),
  depth: $('depth'), depthLabel: $('depthLabel'), maxGap: $('maxGap'), maxGapLabel: $('maxGapLabel'),
  stats: $('stats'),
  modeWord: $('modeWord'), modeJamo: $('modeJamo'), wordForm: $('wordForm'), jamoForm: $('jamoForm'),
  jamoList: $('jamoList'), saveHint: $('saveHint'), saveMsg: $('saveMsg'),
  btnDownload: $('btnDownload'), btnCopy: $('btnCopy'), entryWrap: $('entryWrap'), entryText: $('entryText'),
  fWord: $('fWord'), fForms: $('fForms'), fSynonyms: $('fSynonyms'), fPos: $('fPos'), fCategory: $('fCategory'),
  fLevel: $('fLevel'), fMeaning: $('fMeaning'), fDescription: $('fDescription'),
  fHandshape: $('fHandshape'), fNonManual: $('fNonManual'),
};

const state = {
  source: 'cam',          // 'cam' | 'file'
  stream: null,           // 웹캠 스트림
  fileUrl: null,          // 업로드한 영상의 임시 주소 (브라우저 메모리 안에서만 유효)
  extractor: null,
  extractorEngine: null,
  loadingExtractor: null,
  busy: false,            // 파일 추출 중
  cancel: false,
  recording: false,
  recBuffer: [],
  recStart: 0,
  liveToken: 0,           // 실시간 추출 루프 구분용
  raw: [],                // 일정한 fps의 원시 프레임
  aspect: 1,
  fps: 30,
  full: [],               // 정규화 + 보간 + 스무딩 (자르기 전)
  processed: [],          // 자르기까지 끝난 최종 프레임
  trimStart: 0,
  trimEnd: 0,
  cur: 0,
  playing: false,
  mode: 'word',           // 'word' | 'jamo'
  jamo: null,
};

const grab = document.createElement('canvas'); // 모델에 넣을 프레임을 그리는 캔버스
const grabCtx = grab.getContext('2d', { willReadFrequently: false });
const MAX_GRAB_WIDTH = 1280;

// ---------------------------------------------------------------------------
// 상태 표시
// ---------------------------------------------------------------------------
function setStatus(message, type = 'info', progress) {
  el.status.textContent = message;
  el.status.className = `status${type === 'error' ? ' error' : type === 'ok' ? ' ok' : ''}`;
  if (progress === undefined) return;
  if (progress === false) { el.progress.hidden = true; return; }
  el.progress.hidden = false;
  if (progress === null) el.progress.removeAttribute('value');
  else el.progress.value = progress;
}

function describeError(e) {
  return e?.message || String(e);
}

// ---------------------------------------------------------------------------
// 추출기 준비 (모델은 처음 필요할 때 내려받는다)
// ---------------------------------------------------------------------------
async function ensureExtractor() {
  const engine = el.engine.value;
  if (state.extractor && state.extractorEngine === engine) return state.extractor;
  if (state.loadingExtractor) return state.loadingExtractor;
  state.loadingExtractor = (async () => {
    try {
      state.extractor?.close();
      state.extractor = null;
      setStatus('추출 모듈 불러오는 중…', 'info', null);
      let mod;
      try {
        mod = await import('./extract.js');
      } catch (e) {
        throw new Error(`MediaPipe 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요. (${describeError(e)})`);
      }
      const extractor = await mod.createExtractor({
        engine,
        onStatus: (msg, p) => setStatus(msg, 'info', p),
      });
      state.extractor = extractor;
      state.extractorEngine = engine;
      showEngineInfo();
      setStatus('모델 준비 완료', 'ok', false);
      return extractor;
    } catch (e) {
      setStatus(`모델을 준비하지 못했습니다: ${describeError(e)}`, 'error', false);
      throw e;
    } finally {
      state.loadingExtractor = null;
    }
  })();
  return state.loadingExtractor;
}

function showEngineInfo() {
  const x = state.extractor;
  if (!x) { el.engineInfo.textContent = ''; return; }
  const name = x.kind === 'holistic' ? 'Holistic' : '몸 + 손 + 얼굴 (대체 방식)';
  el.engineInfo.textContent = `사용 중: ${name} · ${x.delegate}`;
}

// 현재 비디오 화면을 캔버스로 옮긴다 (너무 큰 영상은 줄인다)
function grabFrame() {
  const vw = el.video.videoWidth;
  const vh = el.video.videoHeight;
  const k = Math.min(1, MAX_GRAB_WIDTH / vw);
  const w = Math.round(vw * k);
  const h = Math.round(vh * k);
  if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
  grabCtx.drawImage(el.video, 0, 0, w, h);
  return grab;
}

function fitStageToVideo() {
  const { videoWidth: w, videoHeight: h } = el.video;
  if (!w || !h) return;
  el.stage.style.aspectRatio = `${w} / ${h}`;
  // 세로로 긴 영상이 화면을 다 차지하지 않게 높이를 화면의 65%로 제한한다
  el.stage.style.width = `min(100%, calc(65vh * ${w} / ${h}))`;
  el.stageEmpty.hidden = true;
}

// ---------------------------------------------------------------------------
// 입력 방식 전환
// ---------------------------------------------------------------------------
function setSource(source) {
  if (state.busy || state.recording) return;
  state.source = source;
  const cam = source === 'cam';
  el.tabCam.classList.toggle('active', cam);
  el.tabFile.classList.toggle('active', !cam);
  el.tabCam.setAttribute('aria-selected', String(cam));
  el.tabFile.setAttribute('aria-selected', String(!cam));
  el.camControls.hidden = !cam;
  el.fileControls.hidden = cam;
  if (!cam) stopCamera();
  updateMirror();
}

function updateMirror() {
  el.stage.classList.toggle('mirrored', state.source === 'cam' && el.mirror.checked);
}

// ---------------------------------------------------------------------------
// 웹캠
// ---------------------------------------------------------------------------
function cameraErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 거부되었습니다. 주소창의 카메라 아이콘에서 권한을 허용한 뒤 다시 시도하세요.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '사용할 수 있는 카메라를 찾지 못했습니다. 영상 파일 업로드를 이용할 수 있습니다.';
    case 'NotReadableError':
    case 'AbortError':
      return '카메라를 열 수 없습니다. 다른 프로그램이 카메라를 쓰고 있는지 확인하세요.';
    default:
      return `카메라를 켜지 못했습니다: ${describeError(e)}`;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(window.isSecureContext
      ? '이 브라우저는 웹캠 녹화를 지원하지 않습니다. 영상 파일 업로드를 이용하세요.'
      : '웹캠은 https 또는 localhost 주소에서만 쓸 수 있습니다. (python -m http.server 로 열어 주세요)', 'error');
    return;
  }
  el.btnCam.disabled = true;
  try {
    setStatus('카메라 권한을 요청하는 중…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: false,
    });
    releaseFile();
    state.stream = stream;
    el.video.srcObject = stream;
    await el.video.play();
    fitStageToVideo();
    el.btnCam.textContent = '카메라 끄기';
    updateMirror();
    await ensureExtractor();
    if (!state.stream) return; // 모델을 받는 사이에 카메라를 끈 경우
    el.btnRec.disabled = false;
    setStatus('카메라 준비 완료 — 관절이 화면에 잘 잡히는지 확인하고 녹화를 시작하세요.', 'ok');
    runLiveLoop();
  } catch (e) {
    // 스트림을 얻은 뒤의 실패는 모델 준비 오류이고, ensureExtractor가 이미 화면에 표시했다
    if (!state.stream || state.extractor) setStatus(cameraErrorMessage(e), 'error');
  } finally {
    el.btnCam.disabled = false;
  }
}

function stopCamera() {
  state.liveToken++;
  if (state.recording) stopRecording(false);
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.video.srcObject = null;
  el.btnCam.textContent = '카메라 켜기';
  el.btnRec.disabled = true;
  drawRawOverlay(el.overlay, null);
  if (!state.fileUrl) el.stageEmpty.hidden = false;
}

// 카메라가 켜져 있는 동안 계속 추출해서 화면에 겹쳐 그린다. 녹화 중이면 프레임을 모은다.
function runLiveLoop() {
  const token = ++state.liveToken;
  let lastVideoTime = -1;
  let running = false;
  const tick = async () => {
    if (token !== state.liveToken || !state.stream) return;
    if (!running && el.video.readyState >= 2 && el.video.currentTime !== lastVideoTime) {
      running = true;
      lastVideoTime = el.video.currentTime;
      try {
        const now = performance.now();
        const image = grabFrame();
        const aspect = image.width / image.height;
        const detection = await state.extractor.detect(image, now);
        if (token !== state.liveToken) return;
        const raw = toRawFrame(detection, aspect, (now - state.recStart) / 1000);
        drawRawOverlay(el.overlay, raw);
        if (state.recording) {
          state.aspect = aspect;
          state.recBuffer.push(raw);
          el.recTime.textContent = `${raw.ts.toFixed(1)}초`;
        }
        showEngineInfo();
      } catch (e) {
        console.error(e);
        setStatus(`추출 중 오류가 났습니다: ${describeError(e)}`, 'error');
        stopCamera();
        return;
      } finally {
        running = false;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRecording() {
  if (!state.stream || !state.extractor) return;
  el.btnRec.disabled = true;
  if (el.useCountdown.checked) {
    el.countdown.hidden = false;
    for (let n = 3; n >= 1; n--) {
      el.countdown.textContent = String(n);
      await sleep(1000);
      if (!state.stream) { el.countdown.hidden = true; return; }
    }
    el.countdown.hidden = true;
  }
  pause();
  state.fps = Number(el.fps.value);
  state.recBuffer = [];
  state.recStart = performance.now();
  state.recording = true;
  el.recBadge.hidden = false;
  el.recTime.textContent = '0.0초';
  el.btnRec.textContent = '녹화 정지';
  el.btnRec.classList.add('recording');
  el.btnRec.disabled = false;
  lockInputs(true);
  setStatus('녹화 중… 동작이 끝나면 중립 자세로 돌아온 뒤 정지하세요.');
}

function stopRecording(keep = true) {
  state.recording = false;
  el.recBadge.hidden = true;
  el.btnRec.textContent = '녹화 시작';
  el.btnRec.classList.remove('recording');
  lockInputs(false);
  const buffer = state.recBuffer;
  state.recBuffer = [];
  if (!keep) return;
  if (buffer.length < 5) {
    setStatus('녹화가 너무 짧습니다. 다시 녹화해 주세요.', 'error');
    return;
  }
  const seconds = buffer[buffer.length - 1].ts - buffer[0].ts;
  const captured = (buffer.length - 1) / Math.max(seconds, 1e-3);
  const note = captured < state.fps * 0.6
    ? ` 실제 추출 속도가 초당 ${captured.toFixed(1)}프레임으로 낮아 사이를 보간했습니다. 빠른 동작이면 영상 파일 업로드를 권합니다.`
    : ` (실제 추출 속도 초당 ${captured.toFixed(1)}프레임)`;
  finishCapture(resampleRaw(buffer, state.fps), state.aspect, note);
}

// ---------------------------------------------------------------------------
// 영상 파일
// ---------------------------------------------------------------------------
function releaseFile() {
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = null;
  el.video.removeAttribute('src');
  el.btnExtract.disabled = true;
}

function waitEvent(target, okEvent, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      clearTimeout(timer);
      target.removeEventListener(okEvent, onOk);
      target.removeEventListener('error', onErr);
      fn(arg);
    };
    const onOk = () => done(resolve);
    const onErr = () => done(reject, new Error('영상을 읽지 못했습니다. 브라우저가 지원하지 않는 형식일 수 있습니다.'));
    const timer = setTimeout(() => done(reject, new Error('영상 응답이 없습니다 (시간 초과).')), timeoutMs);
    target.addEventListener(okEvent, onOk);
    target.addEventListener('error', onErr);
  });
}

async function loadFile(file) {
  if (!file) return;
  stopCamera();
  releaseFile();
  drawRawOverlay(el.overlay, null);
  try {
    state.fileUrl = URL.createObjectURL(file);
    el.video.srcObject = null;
    const ready = waitEvent(el.video, 'loadeddata', 15000);
    el.video.src = state.fileUrl;
    await ready;
    // 브라우저로 녹화한 webm은 길이 정보가 없을 때가 있다 → 끝까지 넘겨서 길이를 알아낸다
    if (!Number.isFinite(el.video.duration)) {
      const known = waitEvent(el.video, 'durationchange', 8000).catch(() => {});
      el.video.currentTime = 1e101;
      await known;
      if (Number.isFinite(el.video.duration)) {
        const back = waitEvent(el.video, 'seeked').catch(() => {});
        el.video.currentTime = 0;
        await back;
      }
    }
    fitStageToVideo();
    el.btnExtract.disabled = false;
    const d = el.video.duration;
    setStatus(`영상을 불러왔습니다 (${Number.isFinite(d) ? `${d.toFixed(1)}초` : '길이 알 수 없음'}, ${el.video.videoWidth}×${el.video.videoHeight}). "추출 시작"을 누르세요.`, 'ok');
  } catch (e) {
    releaseFile();
    el.stageEmpty.hidden = false;
    setStatus(describeError(e), 'error');
  }
}

// 원하는 시각으로 정확히 옮긴 뒤 그 화면이 준비될 때까지 기다린다
async function seekTo(time) {
  if (Math.abs(el.video.currentTime - time) < 1e-4 && el.video.readyState >= 2 && !el.video.seeking) return;
  const seeked = waitEvent(el.video, 'seeked');
  el.video.currentTime = time;
  await seeked;
}

async function extractFile() {
  if (state.busy || !state.fileUrl) return;
  const duration = el.video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    setStatus('이 영상은 길이를 알 수 없어 프레임 단위로 넘길 수 없습니다. mp4로 변환해서 다시 시도하세요.', 'error');
    return;
  }
  state.busy = true;
  state.cancel = false;
  pause();
  lockInputs(true);
  el.btnExtract.disabled = true;
  el.btnCancel.hidden = false;
  try {
    const extractor = await ensureExtractor();
    const fps = Number(el.fps.value);
    const stepMs = 1000 / fps;
    el.video.pause();
    const total = Math.max(1, Math.floor(duration * fps));
    const raw = [];
    let aspect = 1;
    for (let i = 0; i < total; i++) {
      if (state.cancel) break;
      await seekTo(Math.min(i / fps, Math.max(0, duration - 0.001)));
      const image = grabFrame();
      aspect = image.width / image.height;
      const detection = await extractor.detect(image, extractor.lastTs + stepMs);
      const frame = toRawFrame(detection, aspect, i / fps);
      raw.push(frame);
      drawRawOverlay(el.overlay, frame);
      setStatus(`추출 중… ${i + 1} / ${total} 프레임`, 'info', (i + 1) / total);
    }
    showEngineInfo();
    if (state.cancel) {
      setStatus('추출을 취소했습니다.', 'info', false);
    } else {
      state.fps = fps;
      el.progress.hidden = true;
      finishCapture(raw, aspect, '');
    }
  } catch (e) {
    console.error(e);
    if (state.extractor) setStatus(`추출 중 오류가 났습니다: ${describeError(e)}`, 'error', false);
  } finally {
    state.busy = false;
    el.btnCancel.hidden = true;
    el.btnExtract.disabled = !state.fileUrl;
    lockInputs(false);
  }
}

function lockInputs(locked) {
  for (const node of [el.engine, el.fps, el.tabCam, el.tabFile, el.fileInput]) node.disabled = locked;
  if (state.source === 'file') el.btnCam.disabled = locked;
}

// ---------------------------------------------------------------------------
// 후처리 파이프라인
// ---------------------------------------------------------------------------
function finishCapture(raw, aspect, note) {
  if (!raw.some((f) => f.pose)) {
    setStatus('영상에서 사람(어깨)을 찾지 못했습니다. 상반신이 다 보이게 다시 찍어 주세요.', 'error');
    return;
  }
  state.raw = raw;
  state.aspect = aspect;
  state.trimStart = 0;
  state.trimEnd = raw.length - 1;
  state.cur = 0;
  for (const s of [el.trimStart, el.trimEnd]) s.max = String(raw.length - 1);
  el.trimStart.value = '0';
  el.trimEnd.value = String(raw.length - 1);
  el.editBox.disabled = false;
  el.btnPlay.disabled = false;
  el.scrub.disabled = false;
  el.btnDownload.disabled = false;
  el.trimInfo.textContent = '';
  recompute();
  setStatus(`추출 완료: ${raw.length}프레임 (${(raw.length / state.fps).toFixed(1)}초).${note} 아래에서 앞뒤를 자르고 저장하세요.`, 'ok');
  play();
}

// 슬라이더 값으로 원시 프레임을 처음부터 다시 처리한다
function recompute() {
  if (!state.raw.length) return;
  const normalized = normalizeClip(state.raw, { aspect: state.aspect, depthScale: Number(el.depth.value) });
  const filled = fillGaps(normalized, { maxGap: Number(el.maxGap.value) });
  state.full = smoothFrames(filled, { fps: state.fps, strength: Number(el.strength.value) });
  applyTrim();
  updateStats();
}

function applyTrim() {
  state.processed = state.full
    .slice(state.trimStart, state.trimEnd + 1)
    .map((f, i) => ({ ...f, t: i }));
  el.trimStartLabel.textContent = String(state.trimStart);
  el.trimEndLabel.textContent = String(state.trimEnd);
  el.scrub.max = String(Math.max(0, state.processed.length - 1));
  state.cur = Math.min(state.cur, state.processed.length - 1);
  render();
}

function updateStats() {
  const n = state.raw.length;
  const rate = (part) => `${Math.round((state.raw.filter((f) => f[part]).length / n) * 100)}%`;
  const kept = state.processed.length;
  const missing = state.processed.filter((f) => !f.left && !f.right).length;
  el.stats.textContent = `인식률 — 왼손 ${rate('left')} · 오른손 ${rate('right')} · 얼굴 ${rate('face')} · 몸 ${rate('pose')}`
    + ` | 저장될 길이 ${kept}프레임 (${(kept / state.fps).toFixed(1)}초, ${state.fps}fps)`
    + (missing ? ` | 두 손 모두 없는 프레임 ${missing}개` : '');
}

function render() {
  const frame = state.processed[state.cur] ?? null;
  drawSkeleton(el.front, frame, { view: 'front', label: '정면' });
  drawSkeleton(el.side, frame, { view: 'side', label: '측면 (오른쪽 = 카메라 쪽)' });
  el.scrub.value = String(state.cur);
  el.frameLabel.textContent = state.processed.length ? `${state.cur + 1} / ${state.processed.length}` : '0 / 0';
}

// --- 재생 ---
let playToken = 0;
function play() {
  if (state.processed.length < 2) return;
  state.playing = true;
  el.btnPlay.textContent = '❚❚ 정지';
  const token = ++playToken;
  const startFrame = state.cur >= state.processed.length - 1 ? 0 : state.cur;
  const startTime = performance.now();
  const step = (now) => {
    if (token !== playToken) return;
    const n = state.processed.length;
    if (n < 2) { pause(); return; }
    state.cur = (startFrame + Math.floor(((now - startTime) / 1000) * state.fps)) % n;
    render();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function pause() {
  playToken++;
  state.playing = false;
  el.btnPlay.textContent = '▶ 재생';
}

function onTrimInput(which) {
  pause();
  let a = Number(el.trimStart.value);
  let b = Number(el.trimEnd.value);
  const last = state.raw.length - 1;
  // 시작이 끝을 넘지 않게 (최소 2프레임)
  if (which === 'start') a = Math.min(a, Math.max(0, b - 1));
  else b = Math.max(b, Math.min(last, a + 1));
  el.trimStart.value = String(a);
  el.trimEnd.value = String(b);
  state.trimStart = a;
  state.trimEnd = b;
  // 방금 움직인 쪽의 경계 프레임을 보여 준다
  state.cur = which === 'start' ? 0 : b - a;
  applyTrim();
  updateStats();
  el.trimInfo.textContent = '';
}

function setTrim(a, b) {
  state.trimStart = a;
  state.trimEnd = b;
  el.trimStart.value = String(a);
  el.trimEnd.value = String(b);
  state.cur = 0;
  applyTrim();
  updateStats();
}

function autoTrim() {
  if (!state.full.length) return;
  pause();
  const found = findNeutralTrim(state.full, { fps: state.fps });
  if (!found) {
    el.trimInfo.textContent = '앞뒤에서 중립 자세(두 손을 내리고 멈춘 구간)를 찾지 못했습니다.';
    return;
  }
  setTrim(found.start, found.end);
  el.trimInfo.textContent = `${found.start}~${found.end}프레임으로 잘랐습니다.`;
  play();
}

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------
function readForm() {
  return {
    word: el.fWord.value, forms: el.fForms.value, synonyms: el.fSynonyms.value, pos: el.fPos.value,
    meaning: el.fMeaning.value, category: el.fCategory.value, level: el.fLevel.value,
    description: el.fDescription.value, handshape: el.fHandshape.value, nonManual: el.fNonManual.value,
  };
}

function currentName() {
  return state.mode === 'jamo' ? (state.jamo ?? '') : safeFileName(el.fWord.value);
}

function setMode(mode) {
  state.mode = mode;
  const word = mode === 'word';
  el.modeWord.classList.toggle('active', word);
  el.modeJamo.classList.toggle('active', !word);
  el.modeWord.setAttribute('aria-selected', String(word));
  el.modeJamo.setAttribute('aria-selected', String(!word));
  el.wordForm.hidden = !word;
  el.jamoForm.hidden = word;
  el.btnCopy.hidden = !word;
  el.entryWrap.hidden = !word;
  el.saveMsg.textContent = '';
  updateSaveHint();
}

function updateSaveHint() {
  const name = currentName();
  const hint = el.saveHint;
  hint.textContent = '';
  const code = (text) => Object.assign(document.createElement('code'), { textContent: text });
  if (state.mode === 'jamo') {
    hint.append('내려받은 파일을 ', code(`data/fingerspelling/${name || '자모'}.json`), ' 위치에 넣으세요.');
  } else {
    hint.append('내려받은 파일을 ', code(`data/signs/${name || '단어'}.json`), ' 위치에 넣고, 아래 항목을 ',
      code('data/words.json'), ' 배열에 추가하세요.');
    el.entryText.value = JSON.stringify(buildWordEntry({ ...readForm(), word: name }), null, 2);
  }
}

function download() {
  const name = currentName();
  if (!state.processed.length) { el.saveMsg.textContent = '먼저 동작을 녹화하거나 추출하세요.'; return; }
  if (!name) {
    el.saveMsg.textContent = state.mode === 'jamo' ? '자모를 고르세요.' : '단어를 입력하세요.';
    (state.mode === 'jamo' ? el.jamoList.querySelector('button') : el.fWord)?.focus();
    return;
  }
  const text = stringifySign(buildSignData(name, state.fps, state.processed));
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const folder = state.mode === 'jamo' ? 'data/fingerspelling/' : 'data/signs/';
  el.saveMsg.textContent = `${name}.json 저장 (${state.processed.length}프레임, ${(text.length / 1024).toFixed(0)}KB) → ${folder} 폴더에 넣으세요.`;
  onDownloaded?.(state.mode, name);
}

async function copyEntry() {
  if (!currentName()) { el.saveMsg.textContent = '단어를 입력하세요.'; el.fWord.focus(); return; }
  updateSaveHint();
  const text = el.entryText.value;
  try {
    await navigator.clipboard.writeText(text);
    el.saveMsg.textContent = 'words.json 항목을 복사했습니다.';
  } catch {
    // 클립보드 권한이 없으면 글상자를 선택해 직접 복사할 수 있게 한다
    el.entryText.focus();
    el.entryText.select();
    const ok = document.execCommand?.('copy');
    el.saveMsg.textContent = ok ? 'words.json 항목을 복사했습니다.' : '자동 복사가 막혀 있습니다. 선택된 내용을 Ctrl+C로 복사하세요.';
  }
}

function buildJamoList() {
  for (const group of JAMO_GROUPS) {
    const title = document.createElement('div');
    title.className = 'group';
    title.textContent = group.label;
    el.jamoList.append(title);
    for (const jamo of group.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = jamo;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', () => {
        state.jamo = jamo;
        for (const other of el.jamoList.querySelectorAll('button')) {
          other.setAttribute('aria-checked', String(other === b));
        }
        updateSaveHint();
      });
      el.jamoList.append(b);
    }
  }
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
function init() {
  for (const pos of POS_LIST) el.fPos.append(new Option(pos, pos));
  buildJamoList();
  setMode('word');
  render();

  el.tabCam.addEventListener('click', () => setSource('cam'));
  el.tabFile.addEventListener('click', () => setSource('file'));
  el.mirror.addEventListener('change', updateMirror);
  el.btnCam.addEventListener('click', () => (state.stream ? stopCamera() : startCamera()));
  el.btnRec.addEventListener('click', () => (state.recording ? stopRecording(true) : startRecording()));
  el.fileInput.addEventListener('change', () => loadFile(el.fileInput.files?.[0]));
  el.btnExtract.addEventListener('click', extractFile);
  el.btnCancel.addEventListener('click', () => { state.cancel = true; });
  el.engine.addEventListener('change', () => {
    // 카메라가 켜져 있으면 바로 새 방식으로 바꾼다. 아니면 다음 추출 때 바뀐다.
    if (state.stream) {
      state.liveToken++;
      el.btnRec.disabled = true;
      ensureExtractor().then(() => {
        if (!state.stream) return;
        el.btnRec.disabled = false;
        runLiveLoop();
      }).catch(() => {});
    }
  });

  el.btnPlay.addEventListener('click', () => (state.playing ? pause() : play()));
  el.scrub.addEventListener('input', () => {
    pause();
    state.cur = Number(el.scrub.value);
    render();
  });
  el.trimStart.addEventListener('input', () => onTrimInput('start'));
  el.trimEnd.addEventListener('input', () => onTrimInput('end'));
  el.btnAutoTrim.addEventListener('click', autoTrim);
  el.btnResetTrim.addEventListener('click', () => {
    if (!state.raw.length) return;
    setTrim(0, state.raw.length - 1);
    el.trimInfo.textContent = '';
  });
  const bindSlider = (input, label, format) => {
    const show = () => { label.textContent = format(Number(input.value)); };
    input.addEventListener('input', () => { show(); recompute(); });
    show();
  };
  bindSlider(el.strength, el.strengthLabel, (v) => v.toFixed(2));
  bindSlider(el.depth, el.depthLabel, (v) => v.toFixed(2));
  bindSlider(el.maxGap, el.maxGapLabel, (v) => `${v}프레임`);

  el.modeWord.addEventListener('click', () => setMode('word'));
  el.modeJamo.addEventListener('click', () => setMode('jamo'));
  el.wordForm.addEventListener('input', updateSaveHint);
  el.wordForm.addEventListener('submit', (e) => e.preventDefault());
  el.btnDownload.addEventListener('click', download);
  el.btnCopy.addEventListener('click', copyEntry);

  // 스페이스 = 재생/정지 (입력 칸에 있을 때는 제외)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.closest('input, textarea, select, button')) return;
    if (!state.processed.length) return;
    e.preventDefault();
    if (state.playing) pause(); else play();
  });
  window.addEventListener('resize', () => { if (!state.playing) render(); });
  window.addEventListener('pagehide', () => {
    state.stream?.getTracks().forEach((t) => t.stop());
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  });

  // 브라우저 지원 확인
  if (typeof WebAssembly !== 'object') {
    setStatus('이 브라우저는 WebAssembly를 지원하지 않아 동작 추출을 할 수 없습니다. 최신 Chrome 또는 Edge를 사용하세요.', 'error');
    for (const b of [el.btnCam, el.fileInput]) b.disabled = true;
  } else if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('이 환경에서는 웹캠을 쓸 수 없습니다 (https 또는 localhost 필요). 영상 파일 업로드는 사용할 수 있습니다.', 'error');
    setSource('file');
  } else {
    setStatus('준비됨 — 카메라를 켜거나 영상 파일을 고르세요. 처음 한 번은 모델(약 14MB)을 내려받습니다.');
  }

  // 녹화 대기열
  initQueue({
    getClip: () => (state.processed.length ? { fps: state.fps, frames: state.processed } : null),
    getForm: () => readForm(),
    getMode: () => state.mode,
    getJamo: () => state.jamo,
    setMode,
    setMessage: (text) => { el.saveMsg.textContent = text; },
    selectJamo: (jamo) => {
      const b = [...el.jamoList.querySelectorAll('button')].find((x) => x.textContent === jamo);
      b?.click();
    },
    fillWord: (entry) => {
      if (!entry) return;
      el.fWord.value = entry.word;
      el.fForms.value = (entry.forms || []).join(', ');
      el.fSynonyms.value = (entry.synonyms || []).join(', ');
      el.fPos.value = entry.pos || '명사';
      el.fCategory.value = entry.category || '';
      el.fLevel.value = String(entry.level || 1);
      el.fMeaning.value = entry.meaning || '';
      // 임시 동작의 설명은 실제 수어가 아니므로 비워 두고 새로 적게 한다
      const placeholder = /^\(임시 동작\)/.test(entry.description || '');
      el.fDescription.value = placeholder ? '' : entry.description || '';
      el.fHandshape.value = placeholder ? '' : entry.handshape || '';
      el.fNonManual.value = placeholder ? '' : entry.nonManual || '';
      updateSaveHint();
    },
    onDownloaded: (fn) => { onDownloaded = fn; },
  });
}

init();
