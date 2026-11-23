# 외부 저작물 고지

이 프로젝트가 쓰거나 담고 있는 다른 사람의 저작물과 그 라이선스입니다.
아래 저작물은 프로젝트의 MIT 라이선스(`LICENSE`)에 포함되지 않고, 각자의 라이선스를 따릅니다.

## 국립국어원 한국수어사전

- 출처: 국립국어원 한국수어사전 — https://sldict.korean.go.kr
- 라이선스: 크리에이티브 커먼즈 **저작자표시-비영리-변경금지 2.0 대한민국 (CC BY-NC-ND 2.0 KR)**
- 이 프로젝트에 담긴 부분
  - `data/ksl-ref.json`의 `description`(수형 설명), `title`, `korean`(한국어 대응표현): 사전 원문을 **바꾸지 않고** 그대로 보관합니다.
  - `data/words.json`의 `ref.description`: 위 수형 설명 원문을 그대로 옮긴 것입니다.
  - 단어 화면의 "국립국어원 한국수어사전" 카드: 위 원문과 출처, 사전 항목 링크를 보여 줍니다.
- 담지 않은 것: 사전의 **영상·사진은 내려받거나 저장하지 않으며**, 영상에서 좌표를 뽑지도 않았습니다. `images` 항목은 사전 사이트의 주소(링크)만 적어 둔 것입니다.
- 비영리 조건: 이 원문이 들어 있는 상태로는 이 프로젝트를 영리 목적으로 쓸 수 없습니다.
- 3D 동작 데이터(`data/signs/`, `data/fingerspelling/`)는 영상에서 뽑은 것이 아니라, 위 설명을 읽고 이 프로젝트에서 **새로 적은** 것입니다(`tools/ksl/`). 사전 영상과 다를 수 있습니다.

## VRM 아바타 — `assets/avatar.vrm`

- 모델: `VRM1_Constraint_Twist_Sample` — © 2022 pixiv Inc.
- 라이선스: VRM Public License 1.0 — https://vrm.dev/licenses/1.0/
  - 파일 안의 이용 조건: 재배포 허용, 수정·수정본 재배포 허용, 기업 상업 이용 허용, 누구나 아바타로 사용 가능, 저작자 표시 불필요(이 문서에 적어 둡니다).
  - 반사회적·혐오 표현에는 쓸 수 없습니다.

## 웹에서 불러 쓰는 라이브러리 (CDN, 저장소에는 들어 있지 않음)

| 이름 | 쓰는 곳 | 라이선스 |
|---|---|---|
| three.js 0.170.0 | 3D 화면 | MIT |
| @pixiv/three-vrm 3.5.1 | VRM 아바타 읽기·움직이기 | MIT |
| Pretendard 1.3.9 (길형진) | 글꼴 | SIL Open Font License 1.1 |
| MediaPipe Tasks Vision 0.10.14 + 손·몸·얼굴 모델 (Google) | 녹화 도구(`recorder.html`)의 동작 추출 | Apache License 2.0 |
