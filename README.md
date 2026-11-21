# 수어 시뮬레이션 사전

수어 동작을 영상 대신 **관절 좌표 기반 3D 시뮬레이션**으로 보여주는 정적 웹 서비스입니다. 명세는 `sign-dictionary-plan.md`를 보세요.

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
| 내 정보 (통계·설정·진도 내보내기) | `#/profile` |
| 동작 데이터 제작 도구 | `recorder.html` |
| 문장 분석 테스트 | `tests/tokenizer.test.html` |

## 아바타

- `assets/avatar.vrm` 의 VRM 아바타로 보여 줍니다. 지금 들어 있는 것은 pixiv의 샘플 모델 `VRM1_Constraint_Twist_Sample` (© 2022 pixiv Inc., [VRM 라이선스 1.0](https://vrm.dev/licenses/1.0/) — 재배포·수정 허용)입니다. VRoid Studio에서 만든 내 캐릭터로 바꿔 넣어도 됩니다.
- 이 파일이 없으면 `_local-test/sample.vrm`(로컬 테스트 전용, 배포 안 함) → 그것도 없으면 마네킹으로 보여 줍니다.
- 내 정보 → 사람 모습에서 아바타 / 마네킹을 바꿀 수 있습니다.

## 데이터

- 사전의 모든 단어는 수어로 표현됩니다: 동작이 녹화된 단어는 그 동작을, 아직 없는 단어(`sign: null`)는 **지문자**로 보여 줍니다.
- `signStatus`: `recorded`(직접 녹화) / `described`(국립국어원 한국수어사전의 수형 설명을 보고 만든 동작) / `placeholder`(기능 시험용 임시 동작) / `missing`(동작 없음 → 지문자).
- `data/signs/*.json`(지금 37개)과 `data/fingerspelling/*.json` 40개는 **사전 설명 기반 동작**입니다 (`source: "described-ksl-dictionary"`). 사전의 영상·사진에서 좌표를 뽑은 것이 아니라, 수형 설명을 읽고 새로 만든 동작이며 검수 전(`verified: false`)입니다.
  - 다시 만들기: `node tools/gen-fake-data.mjs` (일부만: `node tools/gen-fake-data.mjs 먹다 ㄱ`). `words.json`의 `sign`·`signStatus`·`ref`·`description`도 함께 갱신합니다.
  - 동작 정의: `tools/ksl/signs/*.mjs`(단어), `tools/ksl/jamo.mjs`(지문자). 쓰는 법은 **`tools/ksl/README.md`**.
  - 어휘(손 모양·위치·방향·움직임): `tools/ksl/vocab.mjs`, 움직임 엔진: `tools/ksl/engine.mjs`.
  - 사전 설명 원문: `data/ksl-ref.json` (`node tools/fetch-ksl-ref.mjs`로 모음. 출처: 국립국어원 한국수어사전, CC BY-NC-ND 2.0 KR — 설명 원문을 그대로 보관·표시하고 영상·사진은 저장하지 않음).
- 녹화: `recorder.html` → 0. 녹화 대기열에서 단어·자모를 골라 녹화 → Chrome·Edge에서는 "data 폴더 연결" 후 저장 한 번으로 파일 저장과 `words.json` 갱신까지 됩니다. 지문자 40개를 먼저 녹화하면 모든 단어가 실제 지문자로 표현됩니다.
- 좌표계: 양 어깨 중점 = 원점, 어깨 너비 = 1, x+ = 보는 사람 기준 오른쪽, y+ = 위, z+ = 카메라 쪽 (`js/viewer/landmarks.js`).

## 주의

한국수어는 한국어와 문법이 다른 독립된 언어입니다. 문장 기능은 단어를 나열해 표현을 돕는 보조 도구이며 정확한 번역이 아닙니다. 검수(`verified`) 전 데이터는 학습 참고용입니다.
