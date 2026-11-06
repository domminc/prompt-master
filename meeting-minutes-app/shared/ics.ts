import { compactDate, compactDateTime, eventTiming } from "./calendar";
import { CONFIDENCE_LABEL } from "./labels";
import { TIMEZONE } from "./limits";
import type { MeetingEvent } from "./summary-schema";

const enc = new TextEncoder();

const escapeText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545: 한 줄은 75옥텟 이하. 넘으면 CRLF + 공백으로 이어 쓴다. 한글 같은 멀티바이트 문자는 쪼개지 않는다. */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74; // 이어지는 줄은 앞의 공백 1바이트가 있다
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// 한국 표준시는 일광절약시간이 없어 VTIMEZONE 이 단순하다.
const VTIMEZONE_SEOUL = [
  "BEGIN:VTIMEZONE",
  `TZID:${TIMEZONE}`,
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "TZNAME:KST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export interface IcsOptions {
  calendarName: string;
  /** UID 접두사 (작업 id) */
  uidPrefix: string;
  /** 회의 제목 — 설명에 덧붙인다 */
  meetingTitle?: string;
  now?: Date;
}

/** 날짜가 확정된 일정만 .ics 로 만든다. 날짜 미확인 일정은 건너뛴다. */
export function buildIcs(events: MeetingEvent[], opts: IcsOptions): string {
  const stamp = utcStamp(opts.now ?? new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//meeting-minutes-app//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${TIMEZONE}`,
    ...VTIMEZONE_SEOUL,
  ];

  events.forEach((ev, i) => {
    const t = eventTiming(ev);
    if (!t) return;
    const desc = [
      ev.dateText ? `회의 중 표현: ${ev.dateText}` : "",
      ev.attendees.length ? `참석자: ${ev.attendees.join(", ")}` : "",
      `확신도: ${CONFIDENCE_LABEL[ev.confidence]}`,
      opts.meetingTitle ? `출처 회의: ${opts.meetingTitle}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    lines.push("BEGIN:VEVENT", `UID:${opts.uidPrefix}-${i}@meeting-minutes`, `DTSTAMP:${stamp}`);
    if (t.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(t.startDate)}`, `DTEND;VALUE=DATE:${compactDate(t.endDateExclusive)}`);
    } else {
      lines.push(
        `DTSTART;TZID=${TIMEZONE}:${compactDateTime(t.startDate, t.startTime)}`,
        `DTEND;TZID=${TIMEZONE}:${compactDateTime(t.endDate, t.endTime)}`,
      );
    }
    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push(`DESCRIPTION:${escapeText(desc)}`, "END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
