// 비밀번호 재설정: 메일의 링크(…/?userId=…&secret=…#/reset-password)로 들어와 새 비밀번호를 정한다
import { h, toast } from '../ui.js';
import { resetPassword } from '../account.js';
import { passwordFields } from './password-fields.js';

// 주소창의 ?userId=…&secret=… 를 지운다 (비밀 값이 기록·공유되지 않게)
function cleanUrl(hash) {
  history.replaceState(null, '', location.pathname + hash);
}

export async function render(root) {
  const q = new URLSearchParams(location.search);
  const userId = q.get('userId');
  const secret = q.get('secret');

  if (!userId || !secret) {
    root.append(h('div.stack',
      h('div.page-head', h('h1', '비밀번호 재설정')),
      h('section.card',
        h('p', '재설정 링크가 올바르지 않아요. 메일의 링크를 다시 눌러 보거나, 비밀번호 찾기를 다시 해 주세요.'),
        h('div.row', h('a.btn.primary', { href: '#/profile' }, '내 정보로 가기')),
      ),
    ));
    return;
  }

  const pwSet = passwordFields({ label: '새 비밀번호' });
  const msg = h('p.notice.small', { role: 'alert', hidden: true });
  const submit = h('button.btn.primary', { type: 'submit' }, '새 비밀번호 저장');
  const form = h('form.account-form', { novalidate: true }, pwSet.fields, msg, h('div.row', submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bad = pwSet.check();
    if (bad) { msg.textContent = bad; msg.hidden = false; return; }
    submit.disabled = true;
    msg.hidden = true;
    try {
      await resetPassword(userId, secret, pwSet.value());
      cleanUrl('#/profile');
      toast('새 비밀번호로 바꿨어요. 이제 로그인해 주세요.', { type: 'good', duration: 4000 });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      msg.textContent = err.message || '비밀번호를 바꾸지 못했어요.';
      msg.hidden = false;
      submit.disabled = false;
    }
  });

  root.append(h('div.stack',
    h('div.page-head', h('h1', '비밀번호 재설정'), h('p', '새로 쓸 비밀번호를 두 번 적어 주세요.')),
    h('section.card.account-card', form),
  ));
}
