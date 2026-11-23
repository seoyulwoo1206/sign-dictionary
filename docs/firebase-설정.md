# 구글 로그인 켜기 (Firebase 설정 안내)

사람마다 학습 기록을 계정에 저장하려면 기록을 보관할 곳이 필요합니다. 이 사이트는 Google의 무료 서비스 **Firebase**를 씁니다.
아래 순서대로 한 번만 만들면 되고, 10분쯤 걸립니다. 돈은 들지 않습니다 (무료 요금제 "Spark").

준비물: 구글 계정 하나

---

## 1. 프로젝트 만들기

1. https://console.firebase.google.com 에 들어가서 구글 계정으로 로그인합니다.
2. **프로젝트 만들기**(또는 "Firebase 프로젝트 시작하기")를 누릅니다.
3. 프로젝트 이름: `sign-dictionary` (아무 이름이나 괜찮아요) → 계속
4. Google 애널리틱스는 **사용 안 함**으로 두고 → 프로젝트 만들기

## 2. 웹 앱 등록하고 설정값 받기

1. 프로젝트 첫 화면에서 **웹 아이콘 `</>`**(앱 추가 → 웹)을 누릅니다.
2. 앱 닉네임: `수어사전` → "Firebase 호스팅 설정"은 **체크하지 않음** → 앱 등록
3. 화면에 이런 코드가 나옵니다. `const firebaseConfig = { ... };` 부분을 **통째로 복사**해 두세요.
   ```js
   const firebaseConfig = {
     apiKey: "AIza....",
     authDomain: "sign-dictionary-xxxx.firebaseapp.com",
     projectId: "sign-dictionary-xxxx",
     ...
   };
   ```
   이 값은 비밀번호가 아니라 "어느 프로젝트인지" 알려 주는 주소 같은 것이라, 공개 저장소(GitHub)에 올라가도 괜찮습니다.
   각자의 기록은 5단계의 보안 규칙이 지켜 줍니다.

## 3. 구글 로그인 켜기 ("로그인 방법" 단계)

1. 왼쪽 메뉴 **빌드 → Authentication** → 시작하기
2. **로그인 방법(Sign-in method)** 탭 → **Google** → 사용 설정 켜기
3. 프로젝트 지원 이메일: 내 구글 계정 선택 → 저장

## 4. 사이트 주소 등록하기 ("승인된 도메인" 단계)

1. Authentication → **설정(Settings)** 탭 → **승인된 도메인(Authorized domains)**
2. **도메인 추가** → `seoyulwoo1206.github.io` 입력 → 추가
   (`localhost`는 처음부터 들어 있어서 내 컴퓨터에서 시험할 때도 됩니다.)

## 5. 기록 저장소 만들기 ("보안 규칙" 단계)

1. 왼쪽 메뉴 **빌드 → Firestore Database** → 데이터베이스 만들기
2. 위치: **asia-northeast3 (서울)** → 다음
3. **프로덕션 모드**로 시작 → 만들기
4. 다 만들어지면 위쪽 **규칙(Rules)** 탭을 누르고, 안에 있는 내용을 모두 지운 뒤
   이 저장소의 **`firestore.rules`** 파일 내용을 그대로 붙여 넣고 → **게시(Publish)**

## 6. 설정값 넣기

2단계에서 복사한 `firebaseConfig` 값을 Claude에게 보내 주면 넣어 드립니다.
직접 넣으려면 `js/firebase-config.js`의 `export const firebaseConfig = null;`을 복사한 값으로 바꾸면 됩니다:

```js
export const firebaseConfig = {
  apiKey: "AIza....",
  authDomain: "....firebaseapp.com",
  projectId: "....",
  storageBucket: "....",
  messagingSenderId: "....",
  appId: "....",
};
```

GitHub에 올리면 1~2분 뒤 사이트의 "내 정보" 화면에 **구글 계정으로 로그인** 버튼이 생깁니다.

---

## 알아 두기

- **저장되는 것:** XP, 연속 학습일, 배운 단어와 복습 일정, 레슨 기록, 화면 설정. (이름·이메일·사진은 구글이 로그인 화면에서 보여 주는 것만 쓰고, 기록 저장소에는 넣지 않습니다.)
- **저장 위치:** Firestore의 `users/{로그인한 사람 번호}` 문서 하나. 본인만 읽고 쓸 수 있습니다.
- **로그인하면:** 이 기기에서 로그인 전에 한 공부와 계정의 기록을 합칩니다. 어느 쪽 공부도 사라지지 않습니다.
- **로그아웃하면:** 기록은 계정에 남고, 이 기기에서는 지워집니다 (같은 컴퓨터를 쓰는 다음 사람에게 보이지 않게).
- **누가 가입했는지 보기 / 기록 지우기:** Firebase 콘솔의 Authentication(사용자 목록), Firestore Database(기록)에서 볼 수 있습니다.
- **무료 한도:** 하루 읽기 5만 번, 쓰기 2만 번까지 무료입니다. 기록은 바뀐 뒤 잠깐 모아서 한 번에 저장하므로, 수백 명이 써도 충분합니다.
