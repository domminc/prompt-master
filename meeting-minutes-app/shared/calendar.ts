import { TIMEZONE } from "./limits";
import type { MeetingEvent } from "./summary-schema";

export const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

export function isValidYmd(s: string | null | undefined): s is string {
  if (!s) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidHm(s: string | null | undefined): s is string {
  return !!s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDate(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function addDaysYmd(ymd: string, n: number): string {
  const dt = toDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromDate(dt);
}

/** 0=일 … 6=토 */
export function weekdayIndex(ymd: string): number {
  return toDate(ymd).getUTCDay();
}

export function weekdayKo(ymd: string): string {
  return WEEKDAYS_KO[weekdayIndex(ymd)] as string;
}

/** 시각(HH:MM)에 분을 더해 날짜가 넘어가는 경우까지 계산 */
export function addMinutes(ymd: string, hm: string, minutes: number): { date: string; time: string } {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  const dt = toDate(ymd);
  dt.setUTCHours(h, m + minutes, 0, 0);
  return { date: fromDate(dt), time: `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}` };
}

export type EventTiming =
  | { allDay: true; startDate: string; endDateExclusive: string }
  | { allDay: false; startDate: string; startTime: string; endDate: string; endTime: string };

type TimingInput = Pick<MeetingEvent, "date" | "time" | "endTime">;

/**
 * 캘린더에 넣을 수 있는 형태로 변환. 날짜를 모르면 null (캘린더에 넣을 수 없음).
 * 시간이 없으면 종일 일정, 종료 시각이 없거나 시작보다 빠르면 1시간짜리로 본다.
 */
export function eventTiming(ev: TimingInput): EventTiming | null {
  if (!isValidYmd(ev.date)) return null;
  if (!isValidHm(ev.time)) {
    return { allDay: true, startDate: ev.date, endDateExclusive: addDaysYmd(ev.date, 1) };
  }
  let end = { date: ev.date, time: ev.time };
  if (isValidHm(ev.endTime) && ev.endTime > ev.time) {
    end = { date: ev.date, time: ev.endTime };
  } else {
    end = addMinutes(ev.date, ev.time, 60);
  }
  return { allDay: false, startDate: ev.date, startTime: ev.time, endDate: end.date, endTime: end.time };
}

export const compactDate = (ymd: string) => ymd.replaceAll("-", "");
export const compactDateTime = (ymd: string, hm: string) => `${compactDate(ymd)}T${hm.replace(":", "")}00`;

export interface CalendarLinkOptions {
  /** 일정 설명에 덧붙일 문구 (예: 회의 제목) */
  details?: string;
}

/** Google 캘린더 "일정 추가" 링크. 날짜를 모르면 null */
export function googleCalendarUrl(
  ev: Pick<MeetingEvent, "title" | "date" | "time" | "endTime" | "location" | "dateText" | "attendees">,
  opts: CalendarLinkOptions = {},
): string | null {
  const t = eventTiming(ev);
  if (!t) return null;
  const dates = t.allDay
    ? `${compactDate(t.startDate)}/${compactDate(t.endDateExclusive)}`
    : `${compactDateTime(t.startDate, t.startTime)}/${compactDateTime(t.endDate, t.endTime)}`;
  const details = [
    ev.dateText ? `회의에서의 표현: ${ev.dateText}` : "",
    ev.attendees.length ? `참석자: ${ev.attendees.join(", ")}` : "",
    opts.details ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const p = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates, ctz: TIMEZONE });
  if (details) p.set("details", details);
  if (ev.location) p.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
