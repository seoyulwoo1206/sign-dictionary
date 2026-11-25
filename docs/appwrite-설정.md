# 계정 기능 (Appwrite) 설정 기록

사람마다 학습 기록을 계정에 저장하기 위해 **Appwrite Cloud**(무료 플랜)를 씁니다.
아래는 Appwrite 콘솔(https://cloud.appwrite.io)에 이미 해 둔 설정입니다. 다시 만들거나 확인할 때 보세요.

## 프로젝트

- 이름: `sign-dictionary` · 지역: Singapore (`sgp`)
- 프로젝트 ID: `6b04e5c5003191ba7638`
- API 주소(endpoint): `https://sgp.cloud.appwrite.io/v1`
- 코드에 들어 있는 곳: `js/appwrite-config.js` (공개돼도 괜찮은 값)

## 앱(접속을 허락한 사이트 주소) — Overview → Apps

| 이름 | 호스트 |
|---|---|
| Local development | `localhost` (내 컴퓨터에서 시험할 때) |
| GitHub Pages | `seoyulwoo1206.github.io` |

사이트 주소가 바뀌면 여기에 새 주소를 추가해야 로그인이 됩니다.

## 로그인 방법 — Auth → Settings

- **Email/Password** 켜짐 (가입하면 바로 로그인, 이메일 확인 없음)
- 비밀번호는 8자 이상, 가입할 때 "비밀번호 확인" 칸에 한 번 더 적어야 함

## 기록 저장소 — Databases

- 데이터베이스: `signdict` (TablesDB)
- 표: `progress`
  - 열: `progressJson` (Mediumtext) — 한 사람의 학습 기록 전체를 JSON 글자로
  - 행 ID = 사용자 ID (한 사람당 한 줄)
- 권한 (표의 Security 탭)
  - 표 권한: **All users → Create** 만 체크 (로그인한 사람은 자기 줄을 만들 수 있음)
  - **Row level security(RLS) 켜짐**: 줄을 만들 때 코드가 "그 사람만 읽기·고치기·지우기" 권한을 붙인다
  - 그래서 다른 사람의 기록은 읽을 수도, 고칠 수도 없다

## 알아 두기

- 가입한 사람 목록: Auth → Users. 기록: Databases → signdict → progress → Rows.
- 비밀번호 찾기: 내 정보 → "비밀번호를 잊었어요" → Appwrite가 재설정 메일(한국어)을 보내고, 메일 링크(`사이트주소/?userId=…&secret=…`)를 누르면 `#/reset-password` 화면에서 새 비밀번호를 정합니다. 링크는 1시간 동안 유효하고, 위 "앱"에 등록된 주소에서만 동작합니다. 메일 문구는 Auth → Templates 에서 바꿀 수 있습니다.
- 로그인하면 이 기기의 기록과 계정 기록을 합치고, 로그아웃하면 이 기기의 학습 기록을 지웁니다(설정은 남김).
- 코드: `js/account.js` (로그인·저장), `js/learn/progress.js`의 `mergeProgress` (기록 합치기), `js/pages/profile.js` (계정 화면).

## 공부 알림 (웹 푸시)

정해 둔 시간에 마스코트 수달이가 "오늘 공부할 시간이에요" 알림을 보냅니다.

- **표 `reminders`** (데이터베이스 signdict)
  - 행 ID = 사용자 ID. 열: `enabled`(boolean), `time`(varchar 5, "20:00"), `tz`(varchar 64, 시간대), `lastSent`(varchar 10, 마지막으로 보낸 날짜), `subs`(mediumtext, 알림을 받는 기기 목록 JSON)
  - 권한: progress 표와 같음 — 표는 **All users → Create**, **RLS 켜짐**(행은 만든 사람만)
- **표 `config`**: 열 `value`(text). 권한 없음 → 서버(함수)만 읽고 씀. 행 `vapid` 에 알림 서명 키가 있고, 함수가 처음 실행될 때 스스로 만들었다. (이 키는 어디에도 복사하지 않는다)
- **함수 `reminders`** (Functions)
  - 코드: 저장소의 `functions/reminders/` (Node 22, 진입점 `src/main.js`, 빌드 명령 `npm install`)
  - 일정: **1시간마다**(Interval · Hourly). 무료 요금제는 cron 과 60분보다 짧은 간격을 쓸 수 없다. Appwrite 가 매시간 같은 분을 골라 실행하므로, 20시로 정하면 20:00~20:59 사이 날마다 거의 같은 때에 도착한다.
  - 실행 권한(Execute access): **Users** (로그인한 사람이 공개 키 받기·시험 알림 보내기)
  - Scopes: `rows.read`, `rows.write` (실행마다 Appwrite 가 넣어 주는 임시 키로 표를 읽고 씀)
- 코드를 고친 뒤 다시 올리기: `functions/reminders` 에서 `tar -czf reminders.tar.gz package.json package-lock.json src` → 콘솔 함수 → Deployments → Create deployment → Manual 로 올림
- 시험: `functions/reminders/test.local.mjs` (가짜 표·가짜 푸시 서버로 판단 로직 확인, 저장소에는 안 올림)
- 아이폰·아이패드는 Safari 에서 "홈 화면에 추가"한 앱에서만 웹 알림을 받을 수 있다(iOS 16.4 이상).
