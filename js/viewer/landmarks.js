// 관절 번호와 연결선 정의 (MediaPipe 기준)
// 정규화 좌표계: 양 어깨 중점 = 원점, 어깨 너비 = 1
//   x+ = 보는 사람 기준 오른쪽(수어하는 사람의 왼쪽), y+ = 위, z+ = 보는 사람(카메라) 쪽

export const POSE_COUNT = 25; // MediaPipe Pose 0~24 (상체만)
export const HAND_COUNT = 21;

export const POSE = {
  NOSE: 0,
  LEFT_EYE: 2, RIGHT_EYE: 5,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
};

// 손 데이터가 있을 때는 그리지 않는 포즈 손 관절(17~22)
export const POSE_HAND_POINTS = [17, 18, 19, 20, 21, 22];

export const POSE_CONNECTIONS = [
  // 몸통
  [11, 12], [11, 23], [12, 24], [23, 24],
  // 팔
  [11, 13], [13, 15], [12, 14], [14, 16],
  // 포즈의 손 (손 데이터가 없을 때만)
  [15, 17], [15, 19], [15, 21], [17, 19],
  [16, 18], [16, 20], [16, 22], [18, 20],
];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // 엄지
  [0, 5], [5, 6], [6, 7], [7, 8],        // 검지
  [5, 9], [9, 10], [10, 11], [11, 12],   // 중지
  [9, 13], [13, 14], [14, 15], [15, 16], // 약지
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20], // 새끼
];

// 얼굴: 468개 중 표정에 필요한 핵심 점만 저장한다.
// sign JSON의 face 배열은 FACE_INDICES 순서를 그대로 따른다.
export const FACE_GROUPS = [
  { name: 'leftBrow',  closed: false, indices: [300, 293, 334, 296, 336] },
  { name: 'rightBrow', closed: false, indices: [70, 63, 105, 66, 107] },
  { name: 'leftEye',   closed: true,  indices: [362, 385, 387, 263, 373, 380] },
  { name: 'rightEye',  closed: true,  indices: [33, 160, 158, 133, 153, 144] },
  { name: 'outerLips', closed: true,  indices: [61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91] },
  { name: 'innerLips', closed: true,  indices: [78, 81, 13, 311, 308, 402, 14, 178] },
  { name: 'nose',      closed: false, indices: [6, 4, 1] },
  { name: 'oval',      closed: true,  indices: [10, 297, 284, 389, 454, 361, 397, 379, 152, 150, 172, 132, 234, 162, 54, 67] },
];

export const FACE_INDICES = FACE_GROUPS.flatMap((g) => g.indices);
export const FACE_COUNT = FACE_INDICES.length;

// FACE_GROUPS의 각 그룹이 face 배열에서 차지하는 위치 [시작, 끝)
export const FACE_GROUP_RANGES = (() => {
  let start = 0;
  return FACE_GROUPS.map((g) => {
    const r = { name: g.name, closed: g.closed, start, end: start + g.indices.length };
    start = r.end;
    return r;
  });
})();

// 중립 자세 판정 등에 쓰는 손목 번호
export const HAND_WRIST = 0;
