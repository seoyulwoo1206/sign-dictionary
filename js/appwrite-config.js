// Appwrite 설정 (계정·학습 기록 저장)
//
// 이 값은 비밀번호가 아니라 "어느 Appwrite 프로젝트인지" 알려 주는 주소 같은 것이라 공개 저장소에 올라가도 괜찮다.
// 각자의 기록을 지키는 것은 Appwrite 콘솔의 권한 설정이다 (docs/appwrite-설정.md).
//
// projectId 를 null 로 두면 로그인 기능이 꺼지고, 기록은 그 브라우저에만 저장된다.
export const appwriteConfig = {
  endpoint: 'https://sgp.cloud.appwrite.io/v1',
  projectId: '6b04e5c5003191ba7638',
  databaseId: 'signdict',
  tableId: 'progress',
  // 공부 알림 (docs/appwrite-설정.md 의 "알림")
  remindersTableId: 'reminders',
  reminderFunctionId: 'reminders',
};
