// 화면과 Markdown 내보내기가 같은 문구를 쓰도록 모아 둔다.
export const PRIORITY_LABEL = { high: "높음", medium: "보통", low: "낮음" } as const;
export const CONFIDENCE_LABEL = { high: "확실", medium: "계산됨", low: "확인 필요" } as const;
export const EVENT_KIND_LABEL = {
  meeting: "회의",
  deadline: "마감",
  milestone: "마일스톤",
  other: "기타",
} as const;
