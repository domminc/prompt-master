import { isValidHm, isValidYmd } from "../../shared/calendar";
import { parseTimestamp } from "../../shared/format";
import type {
  LlmActionItem,
  LlmEvent,
  LlmSummary,
  MeetingActionItem,
  MeetingEvent,
  MeetingSummary,
} from "../../shared/summary-schema";

const UNKNOWN = "미확인";
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cleanList = (xs: string[]) => [...new Set(xs.map(clean).filter(Boolean))];

function normalizeAction(a: LlmActionItem): MeetingActionItem | null {
  const task = clean(a.task);
  if (!task) return null;
  const { evidenceTime, ...rest } = a;
  return {
    ...rest,
    task,
    owner: clean(a.owner) || UNKNOWN,
    dueDate: isValidYmd(a.dueDate) ? a.dueDate : UNKNOWN,
    evidenceMs: parseTimestamp(evidenceTime),
  };
}

const eventKey = (e: MeetingEvent) => `${e.title.toLowerCase().replace(/\s+/g, "")}|${e.date ?? ""}|${e.time ?? ""}`;

function normalizeEvent(e: LlmEvent, meetingDate: string): MeetingEvent | null {
  const title = clean(e.title);
  if (!title) return null;
  const { evidenceTime, ...rest } = e;
  const date = isValidYmd(e.date) ? e.date : null;
  const time = date && isValidHm(e.time) ? e.time : null;
  const endTime = time && isValidHm(e.endTime) ? e.endTime : null;
  // 이 앱은 "앞으로의 일정"을 뽑는다. 회의일보다 이전 날짜가 나오면 모델이 잘못 계산했을 가능성이 높다.
  const confidence = date && date < meetingDate ? "low" : e.confidence;
  return {
    ...rest,
    title,
    date,
    time,
    endTime,
    dateText: clean(e.dateText),
    location: clean(e.location) || null,
    attendees: cleanList(e.attendees),
    confidence,
    evidenceMs: parseTimestamp(evidenceTime),
  };
}

/** 같은 일정이 구간별로 중복 추출됐을 때 합친다: 첫 항목을 기준으로 비어 있는 값만 채운다. */
function dedupeEvents(events: MeetingEvent[]): MeetingEvent[] {
  const map = new Map<string, MeetingEvent>();
  for (const e of events) {
    const k = eventKey(e);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, e);
      continue;
    }
    map.set(k, {
      ...prev,
      endTime: prev.endTime ?? e.endTime,
      location: prev.location ?? e.location,
      attendees: cleanList([...prev.attendees, ...e.attendees]),
      evidenceMs: prev.evidenceMs ?? e.evidenceMs,
    });
  }
  return [...map.values()];
}

/** 날짜순 정렬. 날짜 미확인 일정은 맨 뒤. */
function sortEvents(events: MeetingEvent[]): MeetingEvent[] {
  return [...events].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "");
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });
}

/** LLM 출력(형식 검증은 스키마가, 의미 검증은 여기서)을 저장·응답용 최종 형태로 다듬는다. */
export function normalizeSummary(llm: LlmSummary, ctx: { meetingDate: string }): MeetingSummary {
  const events = sortEvents(
    dedupeEvents(llm.events.map((e) => normalizeEvent(e, ctx.meetingDate)).filter((e): e is MeetingEvent => !!e)),
  );
  return {
    title: clean(llm.title) || "제목 없는 회의",
    tldr: clean(llm.tldr),
    decisions: cleanList(llm.decisions),
    actionItems: llm.actionItems.map(normalizeAction).filter((a): a is MeetingActionItem => !!a),
    events,
    openQuestions: cleanList(llm.openQuestions),
  };
}
