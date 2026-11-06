import { z } from "zod";

// ── LLM 이 채우는 스키마 (Claude 구조화 출력에 그대로 사용) ─────────────────────
// 주의: 구조화 출력은 숫자 범위·정규식 같은 제약을 지원하지 않으므로 형식 검증은
//       worker/ai/normalize.ts 에서 후처리로 한다.

export const PRIORITIES = ["high", "medium", "low"] as const;
export const EVENT_KINDS = ["meeting", "deadline", "milestone", "other"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

const LlmActionItemSchema = z.object({
  task: z.string().describe("해야 할 일"),
  owner: z.string().describe("담당자 이름. 전사본에 없으면 '미확인'"),
  dueDate: z.string().describe("YYYY-MM-DD. 기한이 없거나 특정할 수 없으면 '미확인'"),
  priority: z.enum(PRIORITIES),
  evidenceTime: z.string().nullable().describe("근거 발화의 타임스탬프 HH:MM:SS, 모르면 null"),
});

const LlmEventSchema = z.object({
  title: z.string().describe("일정 이름 (예: 2차 디자인 리뷰)"),
  kind: z.enum(EVENT_KINDS),
  date: z.string().nullable().describe("YYYY-MM-DD. 기준 달력으로 확정할 수 없으면 null"),
  time: z.string().nullable().describe("24시간제 HH:MM. 시간 언급이 없으면 null"),
  endTime: z.string().nullable().describe("24시간제 HH:MM. 종료 시각 언급이 없으면 null"),
  dateText: z.string().describe("전사본에 나온 날짜·시간 원문 표현 (예: '다음 주 화요일 오후 3시')"),
  location: z.string().nullable().describe("장소 또는 온라인 링크/플랫폼, 없으면 null"),
  attendees: z.array(z.string()).describe("언급된 참석자. 없으면 빈 배열"),
  confidence: z.enum(CONFIDENCES),
  evidenceTime: z.string().nullable().describe("근거 발화의 타임스탬프 HH:MM:SS, 모르면 null"),
});

export const LlmSummarySchema = z.object({
  title: z.string().describe("회의 제목"),
  tldr: z.string().describe("3문장 이내 요약"),
  decisions: z.array(z.string()).describe("결정된 사항"),
  actionItems: z.array(LlmActionItemSchema),
  events: z.array(LlmEventSchema).describe("앞으로 잡힌 일정(회의·마감·행사 등)"),
  openQuestions: z.array(z.string()).describe("미해결 질문"),
});

export type LlmSummary = z.infer<typeof LlmSummarySchema>;
export type LlmEvent = z.infer<typeof LlmEventSchema>;
export type LlmActionItem = z.infer<typeof LlmActionItemSchema>;

// ── DB(jobs.summary)와 API 로 나가는 최종 형태 ───────────────────────────────
// evidenceTime(문자열)을 evidenceMs(숫자)로 바꿔 프런트가 바로 재생 위치로 점프할 수 있게 한다.

export type MeetingEvent = Omit<LlmEvent, "evidenceTime"> & { evidenceMs: number | null };
export type MeetingActionItem = Omit<LlmActionItem, "evidenceTime"> & { evidenceMs: number | null };

export interface MeetingSummary {
  title: string;
  tldr: string;
  decisions: string[];
  actionItems: MeetingActionItem[];
  events: MeetingEvent[];
  openQuestions: string[];
}
