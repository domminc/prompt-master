import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  addMinutes,
  eventTiming,
  googleCalendarUrl,
  isValidHm,
  isValidYmd,
  weekdayKo,
} from "../shared/calendar";
import { formatClock, formatDuration, formatTimestamp, parseTimestamp } from "../shared/format";

describe("format", () => {
  it("밀리초를 HH:MM:SS 로 바꾼다", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(3_723_999)).toBe("01:02:03");
    expect(formatClock(75_000)).toBe("01:15");
    expect(formatClock(3_700_000)).toBe("01:01:40");
  });
  it("타임스탬프 문자열을 파싱한다", () => {
    expect(parseTimestamp("00:12:34")).toBe(754_000);
    expect(parseTimestamp("12:34")).toBe(754_000);
    expect(parseTimestamp("1:02:03")).toBe(3_723_000);
    expect(parseTimestamp("12:75")).toBeNull();
    expect(parseTimestamp("abc")).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });
  it("길이를 읽기 쉽게 표시한다", () => {
    expect(formatDuration(45_000)).toBe("45초");
    expect(formatDuration(12 * 60_000)).toBe("12분");
    expect(formatDuration(83 * 60_000)).toBe("1시간 23분");
    expect(formatDuration(2 * 3_600_000)).toBe("2시간");
  });
});

describe("calendar", () => {
  it("날짜·시간 형식을 검증한다", () => {
    expect(isValidYmd("2026-11-06")).toBe(true);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-13-01")).toBe(false);
    expect(isValidYmd("26-11-06")).toBe(false);
    expect(isValidYmd(null)).toBe(false);
    expect(isValidHm("09:30")).toBe(true);
    expect(isValidHm("24:00")).toBe(false);
    expect(isValidHm("9:30")).toBe(false);
  });
  it("요일 계산이 맞다 (2026-11-06 은 금요일)", () => {
    expect(weekdayKo("2026-11-06")).toBe("금");
    expect(weekdayKo("2026-11-10")).toBe("화");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("종료 시각이 자정을 넘어가면 날짜를 넘긴다", () => {
    expect(addMinutes("2026-11-10", "23:30", 60)).toEqual({ date: "2026-11-11", time: "00:30" });
  });
  it("시간이 없으면 종일 일정, 종료 시각이 없으면 1시간", () => {
    expect(eventTiming({ date: "2026-11-10", time: null, endTime: null })).toEqual({
      allDay: true,
      startDate: "2026-11-10",
      endDateExclusive: "2026-11-11",
    });
    expect(eventTiming({ date: "2026-11-10", time: "15:00", endTime: null })).toMatchObject({
      allDay: false,
      startTime: "15:00",
      endTime: "16:00",
    });
    // 종료가 시작보다 빠르면(모델 오류) 1시간으로 대체
    expect(eventTiming({ date: "2026-11-10", time: "15:00", endTime: "14:00" })).toMatchObject({ endTime: "16:00" });
    expect(eventTiming({ date: null, time: "15:00", endTime: null })).toBeNull();
  });
  it("Google 캘린더 링크를 만든다 (날짜 미확인이면 null)", () => {
    const base = { title: "디자인 리뷰", time: "15:00", endTime: null, location: "3층 회의실", dateText: "다음 주 화요일", attendees: ["민수"] };
    const url = googleCalendarUrl({ ...base, date: "2026-11-10" })!;
    const q = new URL(url).searchParams;
    expect(q.get("text")).toBe("디자인 리뷰");
    expect(q.get("dates")).toBe("20261110T150000/20261110T160000");
    expect(q.get("ctz")).toBe("Asia/Seoul");
    expect(q.get("location")).toBe("3층 회의실");
    expect(q.get("details")).toContain("다음 주 화요일");
    expect(googleCalendarUrl({ ...base, date: null })).toBeNull();
    const allDay = new URL(googleCalendarUrl({ ...base, date: "2026-11-10", time: null })!).searchParams;
    expect(allDay.get("dates")).toBe("20261110/20261111");
  });
});
