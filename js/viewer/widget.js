// 뷰어 + 재생 컨트롤 + 범례를 한 묶음으로 만드는 도우미
import { SignViewer } from './viewer.js';
import { createPlayerControls } from './player.js';
import { getState } from '../learn/progress.js';

// ctx: 라우터 ctx (onCleanup), options: { controls, compact, keyboard, mirror, speed, loop, small, interactive, legend }
export function createViewerBlock(ctx, {
  controls = true, compact = false, keyboard = false, mirror, speed = 1, loop = true,
  small = false, interactive = true, legend = true, showViewTools = true,
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'viewer-wrap';
  const stage = document.createElement('div');
  stage.className = 'viewer-stage' + (small ? ' small' : '');
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', '수어 동작 3D 시뮬레이션');
  wrap.append(stage);

  const viewer = new SignViewer(stage, {
    interactive,
    mirror: mirror ?? getState().settings.mirrorDefault,
  });
  viewer.player.setSpeed(speed);
  viewer.player.setLoop(loop);

  if (legend) {
    const lg = document.createElement('div');
    lg.className = 'viewer-legend';
    lg.innerHTML = '<span>드래그해서 돌려보기</span><span>궤적 색: <i style="background:var(--right)"></i>오른손 <i style="background:var(--left)"></i>왼손</span>';
    wrap.append(lg);
  }

  let pc = null;
  if (controls) {
    pc = createPlayerControls(viewer, { compact, keyboard, showViewTools });
    wrap.append(pc.el);
  }
  const dispose = () => { pc?.dispose(); viewer.dispose(); };
  ctx?.onCleanup(dispose);
  return { el: wrap, stage, viewer, player: viewer.player, controls: pc, dispose };
}
