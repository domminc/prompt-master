import { describe, expect, it } from "vitest";
import {
  contentDisposition,
  safeBaseName,
  srtTime,
  toJson,
  toMarkdown,
  toSrt,
  toTxt,
  type ExportJob,
} from "../worker/lib/exporters";
import { buildIcs, foldLine } from "../shared/ics";
import type { MeetingSummary } from "../shared/summary-schema";

const summary: MeetingSummary = {
  title: "신규 기능 출시 일정 회의",
  tldr: "출시일을 12월 첫째 주로 확정했다.",
  decisions: ["출시일: 12월 첫째 주"],
  actionItems: [{ task: "QA 체크리스트 | 작성", owner: "미확인", dueDate: "미확인", priority: "high", evidenceMs: 65_000 }],
  events: [
    {
      title: "2차 디자인 리뷰", kind: "meeting", date: "2026-11-10", time: "15:00", endTime: null,
      dateText: "다음 주 화요일 오후 3시", location: "3층 회의실, 온라인 병행", attendees: ["민수", "지연"],
      confidence: "medium", evidenceMs: 120_000,
    },
    {
      title: "연말 정산 제출", kind: "deadline", date: "2026-11-30", time: null, endTime: null,
      dateText: "이번 달 말까지", location: null, attendees: [], confidence: "high", evidenceMs: null,
    },
    {
      title: "마케팅 공개", kind: "milestone", date: null, time: null, endTime: null,
      dateText: "추후 협의", location: null, attendees: [], confidence: "low", evidenceMs: null,
    },
  ],
  openQuestions: ["마케팅 공개 일정"],
};
const job: ExportJob = {
  id: "11111111-1111-1111-1111-111111111111",
  fileName: "주간 회의.mp4",
  language: "ko",
  meetingDate: "2026-11-06",
  durationMs: 3_723_000,
  segments: [
    { startMs: 0, endMs: 5200, text: "오늘 회의에서는 신규 기능 출시 일정을 논의했습니다." },
    { startMs: 5200, endMs: 3_723_456, text: "다음 주 화요일 오후 3시에 디자인 리뷰를 합니다." },
  ],
  summary,
};

describe("SRT", () => {
  it("시간 형식이 HH:MM:SS,mmm 이다", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(5200)).toBe("00:00:05,200");
    expect(srtTime(3_723_456)).toBe("01:02:03,456");
  });
  it("번호·구간·본문 형식을 지킨다", () => {
    const srt = toSrt(job.segments);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:05,200\n오늘 회의에서는 신규 기능 출시 일정을 논의했습니다.\n\n" +
        "2\n00:00:05,200 --> 01:02:03,456\n다음 주 화요일 오후 3시에 디자인 리뷰를 합니다.\n",
    );
  });
  it("끝 시각이 시작보다 빠르면 최소 1ms 로 보정한다", () => {
    expect(toSrt([{ startMs: 1000, endMs: 900, text: "x" }])).toContain("00:00:01,000 --> 00:00:01,001");
  });
});

describe("TXT / Markdown / JSON", () => {
  it("TXT 는 [HH:MM:SS] 줄 형식", () => {
    const txt = toTxt(job);
    expect(txt).toContain("신규 기능 출시 일정 회의");
    expect(txt).toContain("[00:00:05] 다음 주 화요일");
  });
  it("Markdown 에 요약·일정·액션 아이템이 들어가고 표의 | 가 이스케이프된다", () => {
    const md = toMarkdown(job);
    expect(md).toContain("# 신규 기능 출시 일정 회의");
    expect(md).toContain("## 일정");
    expect(md).toContain("| 2026-11-10 (화) | 15:00~16:00 | 2차 디자인 리뷰 |");
    expect(md).toContain("| 미확인 | - | 마케팅 공개 |");
    expect(md).toContain("QA 체크리스트 \\| 작성");
    expect(md).toContain("**[00:00:00]**");
  });
  it("요약이 없어도 Markdown·TXT 가 만들어진다", () => {
    const md = toMarkdown({ ...job, summary: null });
    expect(md).toContain("# 주간 회의.mp4");
    expect(md).not.toContain("## 일정");
  });
  it("JSON 은 파싱 가능하고 요약을 포함한다", () => {
    const parsed = JSON.parse(toJson(job));
    expect(parsed.summary.events).toHaveLength(3);
    expect(parsed.segments[0].startMs).toBe(0);
  });
});

describe("파일 이름", () => {
  it("확장자와 위험 문자를 제거한다", () => {
    expect(safeBaseName("주간 회의.mp4")).toBe("주간 회의");
    expect(safeBaseName('a/b\\c:d*e?"f<g>h|i.mp3')).toBe("a b c d e f g h i");
    expect(safeBaseName(null)).toBe("meeting");
    expect(safeBaseName("   ")).toBe("meeting");
  });
  it("한글 파일명을 RFC 5987 로 인코딩한다", () => {
    const h = contentDisposition("주간 회의.srt");
    expect(h).toContain("attachment;");
    expect(h).toContain("filename*=UTF-8''%EC%A3%BC%EA%B0%84%20%ED%9A%8C%EC%9D%98.srt");
    expect(h).toMatch(/filename="[\x20-\x7e]+"/);
  });
});

describe("ICS", () => {
  const ics = buildIcs(summary.events, {
    calendarName: "회의 일정", uidPrefix: job.id, meetingTitle: summary.title, now: new Date("2026-11-06T00:00:00Z"),
  });
  it("CRLF 줄바꿈과 필수 구조를 가진다", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics).toContain("TZID:Asia/Seoul");
  });
  it("날짜가 확정된 일정만 VEVENT 로 넣는다 (3개 중 2개)", () => {
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).not.toContain("마케팅 공개");
  });
  it("시간 일정과 종일 일정을 구분한다", () => {
    expect(ics).toContain("DTSTART;TZID=Asia/Seoul:20261110T150000");
    expect(ics).toContain("DTEND;TZID=Asia/Seoul:20261110T160000");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130");
    expect(ics).toContain("DTEND;VALUE=DATE:20261201");
    expect(ics).toContain("DTSTAMP:20261106T000000Z");
  });
  it("쉼표를 이스케이프하고 UID 가 일정마다 다르다", () => {
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("LOCATION:3층 회의실\\, 온라인 병행");
    const uids = unfolded.match(/UID:.+/g)!;
    expect(new Set(uids).size).toBe(uids.length);
  });
  it("긴 줄은 75옥텟 이하로 접고, 한글을 쪼개지 않는다", () => {
    const long = "가".repeat(60); // 180바이트
    const folded = foldLine(`SUMMARY:${long}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${long}`);
  });
});
