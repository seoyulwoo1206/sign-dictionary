// Firebase 웹 앱 설정 — docs/firebase-설정.md 를 따라 Firebase 콘솔에서 받은 값을 붙여 넣는다.
//
// 이 값은 비밀번호가 아니라 "어느 Firebase 프로젝트인지" 알려 주는 주소 같은 것이라 공개 저장소에 올라가도 괜찮다.
// 각자의 기록을 지키는 것은 firestore.rules 의 보안 규칙이다 (본인 기록만 읽고 쓸 수 있음).
//
// null 이면 로그인 기능이 꺼지고, 기록은 지금처럼 이 브라우저에만 저장된다.
//
// 예)
// export const firebaseConfig = {
//   apiKey: 'AIza...',
//   authDomain: '프로젝트ID.firebaseapp.com',
//   projectId: '프로젝트ID',
//   storageBucket: '프로젝트ID.firebasestorage.app',
//   messagingSenderId: '123456789',
//   appId: '1:123456789:web:abcdef',
// };
export const firebaseConfig = null;
