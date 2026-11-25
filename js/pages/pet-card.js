// 내 정보 → "수달이 키우기" 카드: 지금 단계, 다음 단계까지 남은 XP, 단계 목록. 수달이를 누르면 반응한다.
import { h } from '../ui.js';
import { mascot, react, petInfo, STAGES } from '../mascot.js';

export function petCard() {
  const info = petInfo();
  const pet = mascot('wave', { size: 116, label: `수달이 (${info.name})` });
  const bubble = h('p.bubble', info.desc);
  return h('section.card.pet-card',
    h('h2', '수달이 키우기'),
    h('div.pet-main',
      h('div.mascot-say', pet, bubble),
    ),
    h('div.pet-stage',
      h('div.pet-name', h('b', info.name), h('span.muted.small', `${info.stage + 1}단계 / ${STAGES.length}단계`)),
      h('div.progress', { role: 'progressbar', 'aria-label': '다음 단계까지', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': info.pct },
        h('i', { style: { width: info.pct + '%' } })),
      h('p.muted.small', info.next
        ? `${info.next.name}까지 ${info.toNext} XP 남았어요. 레슨을 끝내고 복습하면 XP가 쌓여요.`
        : '최고 단계까지 자랐어요! 앞으로도 같이 공부해요.'),
    ),
    h('ol.pet-steps', { 'aria-label': '성장 단계' },
      STAGES.map((s, i) => h('li', { class: i < info.stage ? 'done' : i === info.stage ? 'now' : 'locked' },
        i <= info.stage ? mascot('happy', { size: 52, stage: i, pet: false }) : h('span.pet-lock', { 'aria-hidden': 'true' }, '?'),
        h('span', i <= info.stage ? s.name : `${s.xp} XP`),
      ))),
    h('button.btn.small', { type: 'button', onclick: () => react(pet, 'love') }, '🤚 쓰다듬기'),
  );
}
