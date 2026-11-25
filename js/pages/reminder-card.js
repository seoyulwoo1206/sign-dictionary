// 내 정보 → "공부 알림" 카드
import { h, toast } from '../ui.js';
import { mascotSay } from '../mascot.js';
import { accountInfo } from '../account.js';
import {
  pushSupport, supportMessage, getReminder, enableReminder, disableReminder, setReminderTime, sendTestReminder,
} from '../reminders.js';

export function reminderCard() {
  const body = h('div.reminder-body', h('p.muted.small', '알림 설정을 확인하는 중…'));
  const card = h('section.card.reminder-card',
    h('h2', '공부 알림'),
    mascotSay('wave', '정해 둔 시간에 제가 알려 드릴게요! 그날 이미 공부했으면 조용히 있을게요.', { size: 76 }),
    body,
  );
  fill(body);
  return card;
}

async function fill(body) {
  const info = accountInfo();
  if (!info.enabled) { body.replaceChildren(h('p.muted.small', '이 사이트에서는 알림 기능이 꺼져 있어요.')); return; }
  if (!info.user) {
    body.replaceChildren(h('p.muted.small', '로그인하면 알림을 받을 수 있어요. 위의 계정 칸에서 로그인해 주세요.'));
    return;
  }
  const support = pushSupport();
  let st;
  try {
    st = await getReminder();
  } catch (e) {
    body.replaceChildren(h('p.notice.small', e.message || '알림 설정을 불러오지 못했어요.'));
    return;
  }

  // 알림은 서버가 1시간마다 확인해서 보내므로 '몇 시' 단위로 고른다
  const hourLabel = (hr) => (hr === 0 ? '밤 12시' : hr === 12 ? '낮 12시' : `${hr < 12 ? '오전' : '오후'} ${hr % 12}시`);
  const curHour = Number((st.time || '20:00').slice(0, 2));
  const time = h('select.input.time-input', { 'aria-label': '알림 시간' },
    Array.from({ length: 24 }, (_, i) => (i + 6) % 24).map((hr) => {
      const v = `${String(hr).padStart(2, '0')}:00`;
      return h('option', { value: v, selected: hr === curHour }, hourLabel(hr));
    }));
  const timeText = (t) => hourLabel(Number(t.slice(0, 2)));
  const sw = h('input', { type: 'checkbox', checked: st.thisDevice, 'aria-label': '이 기기에서 알림 받기', disabled: support !== 'ok' && !st.thisDevice });
  const status = h('p.muted.small.reminder-status');
  const testBtn = h('button.btn.small', { type: 'button', hidden: !st.thisDevice }, '🔔 시험 알림 보내기');

  const showStatus = (s) => {
    const others = s.devices - (s.thisDevice ? 1 : 0);
    status.textContent = s.thisDevice
      ? `매일 ${timeText(s.time)}쯤(그 시간 안에) 이 기기로 알려 드려요.${others > 0 ? ` (다른 기기 ${others}대에서도 받는 중)` : ''}`
      : s.enabled ? `다른 기기 ${s.devices}대에서 매일 ${timeText(s.time)}쯤 받고 있어요.` : '알림이 꺼져 있어요.';
  };
  showStatus(st);

  const busy = (on) => { sw.disabled = on; time.disabled = on; testBtn.disabled = on; };

  sw.addEventListener('change', async () => {
    busy(true);
    try {
      if (sw.checked) {
        await enableReminder(time.value || '20:00');
        toast('알림을 켰어요! 🦦', { type: 'good' });
      } else {
        await disableReminder();
        toast('이 기기의 알림을 껐어요.');
      }
      st = await getReminder();
    } catch (e) {
      console.error(e);
      sw.checked = !sw.checked;
      toast(e.message || '알림 설정을 바꾸지 못했어요.');
    }
    busy(false);
    sw.checked = st.thisDevice;
    testBtn.hidden = !st.thisDevice;
    showStatus(st);
  });

  time.addEventListener('change', async () => {
    if (!time.value) return;
    st.time = time.value;
    if (!st.enabled) { showStatus(st); return; }
    busy(true);
    try {
      await setReminderTime(time.value);
      toast(`알림 시간을 ${timeText(time.value)}로 바꿨어요.`, { type: 'good' });
    } catch (e) {
      toast(e.message || '시간을 바꾸지 못했어요.');
    }
    busy(false);
    showStatus(st);
  });

  testBtn.addEventListener('click', async () => {
    busy(true);
    try {
      await sendTestReminder();
      toast('시험 알림을 보냈어요. 몇 초 안에 도착해요.', { type: 'good' });
    } catch (e) {
      toast(e.message || '시험 알림을 보내지 못했어요.');
    }
    busy(false);
  });

  body.replaceChildren(...[
    support !== 'ok' ? h('p.notice.small', supportMessage(support)) : null,
    h('div.settings-row', h('span', '이 기기에서 알림 받기'), h('label.switch', sw, h('span'))),
    h('div.settings-row', h('label', { for: 'reminder-time' }, '알림 시간'), Object.assign(time, { id: 'reminder-time' })),
    status,
    testBtn,
  ].filter(Boolean));
}
