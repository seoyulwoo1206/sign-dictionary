// 2D 캔버스 미리보기: 정규화 스켈레톤(정면/측면) + 촬영 화면 위 원시 관절 표시

import { POSE, POSE_CONNECTIONS, POSE_HAND_POINTS, HAND_CONNECTIONS, FACE_GROUP_RANGES } from '../viewer/landmarks.js';

export const COLORS = {
  body: '#9aa3ad',
  left: '#4c9bff',   // 수어하는 사람의 왼손 — 파랑
  right: '#ff9a3c',  // 오른손 — 주황
  face: '#e6ebf0',
  background: '#14171c',
  guide: '#2a3038',
};

// 정면에서 보이는 범위 (어깨 너비 단위)
const VIEW = { xMin: -1.7, xMax: 1.7, yMin: -2.3, yMax: 1.4, zHalf: 1.3 };

// 캔버스 실제 픽셀 크기를 CSS 크기 × 기기 배율에 맞춘다
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function drawLines(ctx, pts, connections, project, skip) {
  ctx.beginPath();
  for (const [a, b] of connections) {
    if (skip?.(a, b) || !pts[a] || !pts[b]) continue;
    const [x1, y1] = project(pts[a]);
    const [x2, y2] = project(pts[b]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

function drawDots(ctx, pts, project, radius, skip) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    if (skip?.(i)) return;
    const [x, y] = project(p);
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  });
  ctx.fill();
}

// 정규화 프레임 하나를 그린다. view: 'front'(x-y) | 'side'(z-y)
export function drawSkeleton(canvas, frame, { view = 'front', label = '' } = {}) {
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, w, h);

  const side = view === 'side';
  const hMin = side ? -VIEW.zHalf : VIEW.xMin;
  const hMax = side ? VIEW.zHalf : VIEW.xMax;
  const scale = Math.min(w / (hMax - hMin), h / (VIEW.yMax - VIEW.yMin));
  const cx = w / 2 - ((hMin + hMax) / 2) * scale;
  const cy = h / 2 + ((VIEW.yMin + VIEW.yMax) / 2) * scale;
  const project = (p) => [cx + (side ? p[2] : p[0]) * scale, cy - p[1] * scale];
  const unit = Math.max(1, scale / 90); // 선 굵기 기준

  // 어깨 높이 안내선
  ctx.strokeStyle = COLORS.guide;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, h);
  ctx.stroke();

  if (label) {
    ctx.fillStyle = '#6b7684';
    ctx.font = `${Math.round(11 * Math.min(window.devicePixelRatio || 1, 2))}px sans-serif`;
    ctx.fillText(label, 8, 16 * Math.min(window.devicePixelRatio || 1, 2));
  }
  if (!frame?.pose) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 몸 — 손 데이터가 있는 쪽은 포즈의 손 관절(17~22)을 그리지 않는다
  const hiddenPosePoint = (i) => POSE_HAND_POINTS.includes(i) && (i % 2 === 1 ? frame.left : frame.right);
  ctx.strokeStyle = COLORS.body;
  ctx.fillStyle = COLORS.body;
  ctx.lineWidth = 3 * unit;
  drawLines(ctx, frame.pose, POSE_CONNECTIONS, project, (a, b) => hiddenPosePoint(a) || hiddenPosePoint(b));
  drawDots(ctx, frame.pose, project, 3 * unit, (i) => i < POSE.LEFT_SHOULDER || hiddenPosePoint(i));

  // 얼굴
  if (frame.face) {
    ctx.fillStyle = COLORS.face;
    ctx.strokeStyle = 'rgba(230, 235, 240, 0.45)';
    ctx.lineWidth = 1 * unit;
    for (const g of FACE_GROUP_RANGES) {
      ctx.beginPath();
      for (let i = g.start; i < g.end; i++) {
        const [x, y] = project(frame.face[i]);
        if (i === g.start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (g.closed) ctx.closePath();
      ctx.stroke();
    }
    drawDots(ctx, frame.face, project, 1.2 * unit);
  } else {
    // 얼굴 데이터가 없으면 포즈의 머리 점만 표시
    ctx.fillStyle = COLORS.face;
    drawDots(ctx, frame.pose.slice(0, 11), project, 2 * unit);
  }

  // 손
  for (const part of ['left', 'right']) {
    const pts = frame[part];
    if (!pts) continue;
    ctx.strokeStyle = COLORS[part];
    ctx.fillStyle = COLORS[part];
    ctx.lineWidth = 2.2 * unit;
    drawLines(ctx, pts, HAND_CONNECTIONS, project);
    drawDots(ctx, pts, project, 2.2 * unit);
  }
}

// 촬영/영상 화면 위에 원시 프레임(이미지 좌표)을 겹쳐 그린다
export function drawRawOverlay(canvas, raw) {
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!raw) return;
  const project = (p) => [p[0] * w, p[1] * h];
  const unit = Math.max(1, w / 480);
  ctx.lineCap = 'round';

  if (raw.pose) {
    const hidden = (i) => POSE_HAND_POINTS.includes(i) && (i % 2 === 1 ? raw.left : raw.right);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 2.5 * unit;
    drawLines(ctx, raw.pose, POSE_CONNECTIONS, project, (a, b) => hidden(a) || hidden(b));
    drawDots(ctx, raw.pose, project, 2.5 * unit, (i) => i < POSE.LEFT_SHOULDER || hidden(i));
  }
  if (raw.face) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    drawDots(ctx, raw.face, project, 1 * unit);
  }
  for (const part of ['left', 'right']) {
    if (!raw[part]) continue;
    ctx.strokeStyle = COLORS[part];
    ctx.fillStyle = COLORS[part];
    ctx.lineWidth = 2 * unit;
    drawLines(ctx, raw[part], HAND_CONNECTIONS, project);
    drawDots(ctx, raw[part], project, 2 * unit);
  }
}
