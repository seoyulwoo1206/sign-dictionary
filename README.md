# 수어 시뮬레이션 사전

수어 동작을 영상 대신 **관절 좌표 기반 3D 시뮬레이션**으로 보여주는 정적 웹 서비스입니다. 명세는 `sign-dictionary-plan.md`를 보세요.

- 사이트: https://seoyulwoo1206.github.io/sign-dictionary/
- 한국수어 단어 541개 + 지문자 40개. 모든 동작은 국립국어원 한국수어사전의 수형 설명을 읽고 새로 만든 것입니다 (영상에서 뽑지 않음).

## 실행

```
python -m http.server 8770
```
브라우저에서 http://localhost:8770 을 엽니다 (`file://`로는 데이터를 불러올 수 없음).

## 구성

| 화면 | 주소 |
|---|---|
| 홈 · 학습 경로 · 레슨 · 복습 | `#/`, `#/learn`, `#/lesson/:id`, `#/review` |
| 사전 · 단어 상세 | `#/dict`, `#/word/:word` |
| 문장 → 수어 | `#/sentence?q=문장` |
| 내 정보 (계정·통계·설정·진도 내보내기) | `#/profile` |
| 동작 데이터 제작 도구 | `recorder.html` |
| 문장 분석 테스트 | `tests/tokenizer.test.html` |

## 계정 (이메일 로그인)

- 내 정보 → 계정에서 이메일과 비밀번호로 가입·로그인하면 학습 기록(XP·연속 학습일·배운 단어·레슨·설정)이 계정에 저장돼 다른 기기에서도 이어집니다. 로그인하지 않으면 그 브라우저에만 저장됩니다.
- Appwrite Cloud(무료)를 씁니다. 설정 기록: **`docs/appwrite-설정.md`**, 연결 값: `js/appwrite-config.js` (`projectId`가 `null`이면 로그인 기능이 꺼짐).
- 각 사람의 기록은 `signdict/progress` 표의 한 줄이고, 본인만 읽고 쓸 수 있습니다(행 단위 보안).
- 코드: `js/account.js`, 기록 합치기: `js/learn/progress.js`의 `mergeProgress`. 로그인하면 이 기기의 기록과 계정 기록을 합치고, 로그아웃하면 이 기기의 학습 기록을 지웁니다(설정은 남김).

## 아바타

- **내 아바타:** 내 정보 → 설정 → "내 아바타"에서 VRoid Studio 등으로 만든 VRM(.vrm) 파일을 불러오면 그 아바타로 보여 줍니다. 파일은 서버로 보내지 않고 그 브라우저(IndexedDB)에만 저장되며, "기본 아바타로 되돌리기"로 지울 수 있습니다. 읽을 수 없는 파일이면 기본 아바타로 돌아갑니다.
- 기본은 `assets/avatar.vrm` 의 VRM 아바타입니다. 지금 들어 있는 것은 pixiv의 샘플 모델 `VRM1_Constraint_Twist_Sample` (© 2022 pixiv Inc., [VRM 라이선스 1.0](https://vrm.dev/licenses/1.0/) — 재배포·수정 허용)입니다. 이 파일을 바꿔 넣으면 사이트의 기본 아바타가 바뀝니다.
- 이 파일이 없으면 `_local-test/sample.vrm`(로컬 테스트 전용, 배포 안 함) → 그것도 없으면 마네킹으로 보여 줍니다.
- 내 정보 → 사람 모습에서 아바타 / 마네킹을 바꿀 수 있습니다.

## 데이터

- 사전의 모든 단어는 수어로 표현됩니다: 동작이 녹화된 단어는 그 동작을, 아직 없는 단어(`sign: null`)는 **지문자**로 보여 줍니다.
- `signStatus`: `recorded`(직접 녹화) / `described`(국립국어원 한국수어사전의 수형 설명을 보고 만든 동작) / `placeholder`(기능 시험용 임시 동작) / `missing`(동작 없음 → 지문자).
- `data/signs/*.json`(541개)과 `data/fingerspelling/*.json` 40개는 **사전 설명 기반 동작**입니다 (`source: "described-ksl-dictionary"`). 사전의 영상·사진에서 좌표를 뽑은 것이 아니라, 수형 설명을 읽고 새로 만든 동작이며 검수 전(`verified: false`)입니다.
  - 다시 만들기: `node tools/gen-fake-data.mjs` (일부만: `node tools/gen-fake-data.mjs 먹다 ㄱ`). `words.json`의 `sign`·`signStatus`·`ref`·`description`도 함께 갱신합니다.
  - 동작 정의: `tools/ksl/signs/*.mjs`(단어), `tools/ksl/jamo.mjs`(지문자). 쓰는 법은 **`tools/ksl/README.md`**.
  - 어휘(손 모양·위치·방향·움직임): `tools/ksl/vocab.mjs`, 움직임 엔진: `tools/ksl/engine.mjs`.
  - 동작의 근거는 세 가지로 나눠 보여 줍니다 (사전 화면의 "동작" 필터):
    - **사전 기반** — 사전 항목(`ref`)이 있는 단어. 단어 화면에 설명 원문과 영상 링크가 붙습니다.
    - **추정 동작** — 사전에 항목이 없어(30개) 사전의 다른 수어를 이어 붙이거나 일반적인 표현으로 만든 단어. 농인 확인이 필요합니다.
    - **확인 필요** — 사전 설명만으로 정하지 못한 부분이 있는 단어와 그 이유: `data/review.json`. 단어 화면에 이유가 나옵니다. 확인을 마치면 이 파일에서 지우세요.
  - 사전 설명 원문: `data/ksl-ref.json` (`node tools/fetch-ksl-ref.mjs`로 모음. 출처: 국립국어원 한국수어사전, CC BY-NC-ND 2.0 KR — 설명 원문을 그대로 보관·표시하고 영상·사진은 저장하지 않음).
- 녹화: `recorder.html` → 0. 녹화 대기열에서 단어·자모를 골라 녹화 → Chrome·Edge에서는 "data 폴더 연결" 후 저장 한 번으로 파일 저장과 `words.json` 갱신까지 됩니다. 직접 녹화한 단어(`signStatus: "recorded"`)와 지문자(`source: "self-recorded"`)는 `gen-fake-data.mjs`를 다시 돌려도 덮어쓰지 않습니다.
- 좌표계: 양 어깨 중점 = 원점, 어깨 너비 = 1, x+ = 보는 사람 기준 오른쪽, y+ = 위, z+ = 카메라 쪽 (`js/viewer/landmarks.js`).

## 라이선스와 외부 저작물

- 프로젝트 자체 코드와 직접 만든 데이터(3D 동작 등): **MIT** (`LICENSE`). 아래 외부 저작물은 각자의 라이선스를 따릅니다.
- 국립국어원 한국수어사전 설명 원문(CC BY-NC-ND 2.0 KR), VRM 아바타, 글꼴·라이브러리: **`THIRD_PARTY_NOTICES.md`**
- 사전 영상 이용 허락 요청 초안: `docs/국립국어원-이용허락-요청.md`

## 주의

한국수어는 한국어와 문법이 다른 독립된 언어입니다. 문장 기능은 단어를 나열해 표현을 돕는 보조 도구이며 정확한 번역이 아닙니다. 검수(`verified`) 전 데이터는 학습 참고용입니다.

## 마스코트와 공부 알림

- 마스코트 **수달이**(아기 수달, `js/mascot.js`): 홈, 레슨·복습 결과, 정답/오답 바, 잠긴 레슨, 알림 설정, 내 정보 → 수달이 키우기에 나온다. 기분에 따라 손 흔들기·만세·웃음·시무룩·갸웃·졸림 모습.
  - **성장**: 총 XP에 따라 아기(0) → 꼬마(30, 목도리) → 학생(100, 책가방) → 선생님(250, 학사모) → 수어 달인(500, 왕관). 레슨·복습으로 다음 단계가 되면 결과 화면에서 자라는 장면이 나온다.
  - **움직임**: 가만히 있을 때 숨쉬기·눈 깜빡임·꼬리 흔들기. 정답이면 폴짝, 오답이면 도리도리, 레슨·복습을 끝내면 한 바퀴 돌며 축하, 누르면 쓰다듬기(하트). 동작 줄이기 설정을 켠 기기에서는 움직이지 않는다.
- **공부 알림**: 내 정보 → 공부 알림에서 켜고 시간을 고른다(로그인 필요). 그날 이미 공부했으면 보내지 않는다. 서버는 Appwrite Function(`functions/reminders`), 설정은 `docs/appwrite-설정.md`.
- 사이트를 앱처럼 설치할 수 있다(`manifest.webmanifest`, `sw.js`, `icons/`). 서비스 워커는 알림만 처리하고 파일을 캐시하지 않는다.
