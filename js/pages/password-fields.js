// 새 비밀번호 + 비밀번호 확인 칸 (가입, 비밀번호 재설정에서 같이 쓴다)
//  - 두 칸이 같은지 적는 동안 바로 알려 준다
//  - "비밀번호 보기"로 적은 글자를 확인할 수 있다
import { h } from '../ui.js';
import { MIN_PASSWORD } from '../account.js';

export function passwordFields({ label = '비밀번호' } = {}) {
  const attrs = { type: 'password', required: true, minlength: String(MIN_PASSWORD), autocomplete: 'new-password' };
  const pw = h('input', { ...attrs, name: 'new-password', placeholder: `${MIN_PASSWORD}자 이상` });
  const pw2 = h('input', { ...attrs, name: 'confirm-password', placeholder: '한 번 더 적어 주세요' });
  const hint = h('span.pw-hint', { 'aria-live': 'polite' });
  const show = h('input', { type: 'checkbox' });

  const update = () => {
    hint.className = 'pw-hint';
    if (!pw2.value) { hint.textContent = ''; return; }
    const same = pw.value === pw2.value;
    hint.textContent = same ? '✓ 두 비밀번호가 같아요' : '두 비밀번호가 달라요';
    hint.classList.add(same ? 'ok' : 'bad');
    pw2.setAttribute('aria-invalid', String(!same));
  };
  pw.addEventListener('input', update);
  pw2.addEventListener('input', update);
  show.addEventListener('change', () => { pw.type = pw2.type = show.checked ? 'text' : 'password'; });

  return {
    fields: [
      h('label.field', h('span', label), pw),
      h('label.field', h('span', `${label} 확인`), pw2, hint),
      h('label.pw-show', show, h('span', '비밀번호 보기')),
    ],
    // 문제가 있으면 알려 줄 말, 없으면 ''
    check() {
      if (pw.value.length < MIN_PASSWORD) { pw.focus(); return `비밀번호는 ${MIN_PASSWORD}자 이상이어야 해요.`; }
      if (pw.value !== pw2.value) { pw2.focus(); return '비밀번호 확인이 달라요. 같은 비밀번호를 두 번 적어 주세요.'; }
      return '';
    },
    value: () => pw.value,
  };
}
