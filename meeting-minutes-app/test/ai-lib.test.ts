import { describe, expect, it } from "vitest";
import { normalizeSummary } from "../worker/ai/normalize";
import { buildTranscriptChunks } from "../worker/lib/chunking";
import { buildCalendarContext, todayKst } from "../worker/lib/refdates";
import { whisperToSegments } from "../worker/lib/segments";
import { parseCreateUpload } from "../worker/lib/validate";
import { ApiError, userMessage } from "../worker/lib/errors";
import type { LlmSummary } from "../shared/summary-schema";

describe("기준 달력", () => {
  const ctx = buildCalendarContext("2026-11-06");
  it("회의일과 요일을 명시한다", () => {
    expect(ctx).toContain("2026-11-06 (금요일)");
  });
  it("이번 주/다음 주/다다음 주 범위가 월~일 기준으로 맞다", () => {
    expect(ctx).toContain("이번 주: 2026-11-02(월) ~ 2026-11-08(일)");
    expect(ctx).toContain("다음 주: 2026-11-09(월) ~ 2026-11-15(일)");
    expect(ctx).toContain("다다음 주: 2026-11-16(월) ~ 2026-11-22(일)");
  });
  it("월말·다음 달 정보와 날짜표를 포함한다", () => {
    expect(ctx).toContain("이번 달 말일: 2026-11-30");
    expect(ctx).toContain("다음 달: 2026-12-01 ~ 2026-12-31");
    expect(ctx).toContain("2026-11-06 (금) ← 오늘");
    expect(ctx).toContain("2026-11-10 (화)");
    expect(ctx).toContain("2026-12-03 (목)");
  });
  it("12월 → 다음 해 1월을 넘긴다", () => {
    expect(buildCalendarContext("2026-12-15")).toContain("다음 달: 2027-01-01 ~ 2027-01-31");
  });
  it("한국 시간 기준 오늘 날짜", () => {
    expect(todayKst(new Date("2026-11-05T16:00:00Z"))).toBe("2026-11-06"); // UTC 16시 = KST 다음날 01시
    expect(todayKst(new Date("2026-11-06T14:59:00Z"))).toBe("2026-11-06");
  });
});

describe("청킹", () => {
  const seg = (i: number, len = 100) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: "가".repeat(len) });
  it("짧으면 청크 1개", () => {
    expect(buildTranscriptChunks([seg(0), seg(1)])).toHaveLength(1);
  });
  it("빈 입력은 빈 배열", () => {
    expect(buildTranscriptChunks([])).toEqual([]);
  });
  it("글자 수 한도를 넘지 않게 나누고 모든 줄이 한 번 이상 들어간다", () => {
    const segs = Array.from({ length: 200 }, (_, i) => seg(i));
    const chunks = buildTranscriptChunks(segs, { maxChars: 2000, overlapLines: 2 });
    expect(chunks.length).toBeGreaterThan(5);
    // 겹침 2줄(≈2*112자)까지 감안
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000 + 2 * 120);
    const stamps = new Set(chunks.flatMap((c) => c.split("\n").map((l) => l.slice(0, 10))));
    expect(stamps.size).toBe(200);
  });
  it("다음 청크는 이전 청크의 마지막 줄들로 시작한다 (문맥 겹침)", () => {
    const segs = Array.from({ length: 40 }, (_, i) => seg(i));
    const [a, b] = buildTranscriptChunks(segs, { maxChars: 1000, overlapLines: 2 });
    const aLines = a!.split("\n");
    const bLines = b!.split("\n");
    expect(bLines[0]).toBe(aLines[aLines.length - 2]);
    expect(bLines[1]).toBe(aLines[aLines.length - 1]);
  });
  it("같은 입력이면 항상 같은 결과 (Workflow 재실행 안전)", () => {
    const segs = Array.from({ length: 80 }, (_, i) => seg(i));
    expect(buildTranscriptChunks(segs, { maxChars: 1500 })).toEqual(buildTranscriptChunks(segs, { maxChars: 1500 }));
  });
  it("한 줄이 한도보다 길어도 무한 루프 없이 자기 청크가 된다", () => {
    const chunks = buildTranscriptChunks([seg(0, 5000), seg(1, 10)], { maxChars: 1000 });
    expect(chunks).toHaveLength(2);
  });
});

describe("Whisper 결과 정리", () => {
  it("오프셋을 더해 ms 로 바꾸고 공백을 정리한다", () => {
    const out = whisperToSegments([{ start: 1.5, end: 3.25, text: "  안녕하세요   여러분 " }], 600_000);
    expect(out).toEqual([{ startMs: 601_500, endMs: 603_250, text: "안녕하세요 여러분" }]);
  });
  it("빈 텍스트와 무음 환각을 버린다", () => {
    const out = whisperToSegments(
      [
        { start: 0, end: 1, text: "  " },
        { start: 1, end: 2, text: "정상 발화", avg_logprob: -0.3, no_speech_prob: 0.01 },
        { start: 2, end: 3, text: "의미 없는 문장", avg_logprob: -1.6, no_speech_prob: 0.95 },
        { start: 3, end: 4, text: "시청해주셔서 감사합니다", avg_logprob: -0.5, no_speech_prob: 0.6 },
        { start: 4, end: 5, text: "아 아 아 아 아 아 아", avg_logprob: -1.2, compression_ratio: 3.1 },
      ],
      0,
    );
    expect(out.map((s) => s.text)).toEqual(["정상 발화"]);
  });
  it("무음 확률이 낮은 정상 발화에 같은 문구가 있으면 살린다", () => {
    const out = whisperToSegments(
      [{ start: 0, end: 4, text: "오늘도 시청해주셔서 감사합니다라고 인사했죠", avg_logprob: -0.2, no_speech_prob: 0.02 }],
      0,
    );
    expect(out).toHaveLength(1);
  });
  it("end 가 start 이하여도 최소 길이를 보장한다", () => {
    const [s] = whisperToSegments([{ start: 5, end: 5, text: "x" }], 0);
    expect(s!.endMs).toBeGreaterThan(s!.startMs);
  });
});

describe("요약 후처리 (normalizeSummary)", () => {
  const base: LlmSummary = {
    title: "  주간 회의 ",
    tldr: "요약",
    decisions: ["A 확정", "A 확정", " "],
    actionItems: [
      { task: "문서 작성", owner: " ", dueDate: "내일쯤", priority: "high", evidenceTime: "00:01:05" },
      { task: " ", owner: "민수", dueDate: "2026-11-12", priority: "low", evidenceTime: null },
    ],
    events: [
      { title: "디자인 리뷰", kind: "meeting", date: "2026-11-10", time: "15:00", endTime: "99:99", dateText: "다음 주 화요일 오후 3시", location: " ", attendees: ["민수", "민수"], confidence: "medium", evidenceTime: "00:02:00" },
      { title: "디자인  리뷰", kind: "meeting", date: "2026-11-10", time: "15:00", endTime: "16:30", dateText: "화요일 3시", location: "3층", attendees: ["지연"], confidence: "high", evidenceTime: null },
      { title: "지난 일정", kind: "other", date: "2026-11-01", time: null, endTime: null, dateText: "지난주 일요일", location: null, attendees: [], confidence: "high", evidenceTime: null },
      { title: "날짜 미정 워크숍", kind: "other", date: "2026-02-30", time: "10:00", endTime: null, dateText: "조만간", location: null, attendees: [], confidence: "low", evidenceTime: null },
      { title: "마감", kind: "deadline", date: "2026-11-08", time: null, endTime: "10:00", dateText: "이번 주 일요일", location: null, attendees: [], confidence: "high", evidenceTime: null },
      { title: "", kind: "other", date: null, time: null, endTime: null, dateText: "", location: null, attendees: [], confidence: "low", evidenceTime: null },
    ],
    openQuestions: ["Q1", "Q1"],
  };
  const out = normalizeSummary(base, { meetingDate: "2026-11-06" });

  it("제목·결정사항·질문을 정리하고 중복을 제거한다", () => {
    expect(out.title).toBe("주간 회의");
    expect(out.decisions).toEqual(["A 확정"]);
    expect(out.openQuestions).toEqual(["Q1"]);
  });
  it("액션 아이템: 빈 항목 제거, 담당자·기한 기본값, 타임스탬프를 ms 로", () => {
    expect(out.actionItems).toHaveLength(1);
    expect(out.actionItems[0]).toMatchObject({ owner: "미확인", dueDate: "미확인", evidenceMs: 65_000 });
  });
  it("같은 일정(공백만 다른 제목)은 합치고, 비어 있던 값(종료·장소)을 채운다", () => {
    const review = out.events.filter((e) => e.title.replace(/\s/g, "") === "디자인리뷰");
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ endTime: "16:30", location: "3층", attendees: ["민수", "지연"], evidenceMs: 120_000 });
  });
  it("존재하지 않는 날짜는 null 로, 날짜가 null 이면 시간도 버린다", () => {
    const e = out.events.find((x) => x.title === "날짜 미정 워크숍")!;
    expect(e.date).toBeNull();
    expect(e.time).toBeNull();
  });
  it("시간이 없는데 종료 시각만 있으면 종료 시각을 버린다", () => {
    expect(out.events.find((x) => x.title === "마감")!.endTime).toBeNull();
  });
  it("회의일보다 과거 날짜는 확신도를 low 로 낮춘다", () => {
    expect(out.events.find((x) => x.title === "지난 일정")!.confidence).toBe("low");
  });
  it("제목 없는 일정은 버리고, 날짜순으로 정렬하며 날짜 미확인은 맨 뒤", () => {
    expect(out.events.map((e) => e.title)).toEqual(["지난 일정", "마감", "디자인 리뷰", "날짜 미정 워크숍"]);
  });
});

describe("업로드 요청 검증", () => {
  const ok = { fileName: "meeting.mp4", mimeType: "video/mp4", sizeBytes: 50_000_000, audioSizeBytes: 10_000_000, language: "ko" };
  const fail = (body: unknown) => {
    try {
      parseCreateUpload(body);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      return (e as ApiError).message;
    }
    throw new Error("통과하면 안 되는 요청이 통과했습니다");
  };
  it("정상 요청 통과", () => {
    expect(parseCreateUpload(ok).fileName).toBe("meeting.mp4");
    expect(parseCreateUpload({ ...ok, mimeType: "" }).mimeType).toBe("");
    for (const f of ["a.MP3", "a.wav", "a.m4a", "a.MP4"]) expect(() => parseCreateUpload({ ...ok, fileName: f, mimeType: "" })).not.toThrow();
  });
  it("허용되지 않은 확장자·MIME 을 막는다", () => {
    expect(fail({ ...ok, fileName: "virus.exe" })).toContain("지원하지 않는 파일 형식");
    expect(fail({ ...ok, fileName: "noext" })).toContain("지원하지 않는 파일 형식");
    expect(fail({ ...ok, mimeType: "application/x-msdownload" })).toContain("지원하지 않는 파일 형식");
  });
  it("200MB 초과를 막는다 (정확히 200MB 는 통과)", () => {
    expect(() => parseCreateUpload({ ...ok, sizeBytes: 200 * 1024 * 1024 })).not.toThrow();
    expect(fail({ ...ok, sizeBytes: 200 * 1024 * 1024 + 1 })).toContain("200MB");
  });
  it("변환 오디오가 너무 크거나 비어 있으면 막는다", () => {
    expect(fail({ ...ok, audioSizeBytes: 121 * 1024 * 1024 })).toContain("녹음이 너무 깁니다");
    expect(fail({ ...ok, audioSizeBytes: 0 })).toContain("비어");
  });
  it("언어·날짜 형식을 검증한다", () => {
    expect(fail({ ...ok, language: "xx" })).toBeTruthy();
    expect(fail({ ...ok, meetingDate: "2026-02-30" })).toContain("회의 날짜");
    expect(parseCreateUpload({ ...ok, meetingDate: "2026-11-06" }).meetingDate).toBe("2026-11-06");
  });
  it("본문이 객체가 아니면 400", () => {
    expect(fail(null)).toBeTruthy();
    expect(fail("x")).toBeTruthy();
  });
});

describe("사용자용 오류 메시지", () => {
  it("Workflow 가 붙인 클래스명 접두사를 제거한다", () => {
    expect(userMessage(new Error("NonRetryableError: 전사 실패: API 키가 올바르지 않습니다."))).toBe("전사 실패: API 키가 올바르지 않습니다.");
    expect(userMessage(new Error("Error: NonRetryableError: 요약 실패: 한도 초과"))).toBe("요약 실패: 한도 초과");
  });
  it("한국어 메시지는 그대로 둔다 (기술 정보 대괄호 포함)", () => {
    expect(userMessage(new Error("전사 실패: 키 오류 [Whisper API 오류 401: bad]"))).toBe("전사 실패: 키 오류 [Whisper API 오류 401: bad]");
  });
  it("한글이 없는 예상 밖 내부 오류는 안내 문구로 감싸고 원문은 대괄호에 남긴다", () => {
    const m = userMessage(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(m).toMatch(/^예기치 않은 오류가 발생했어요/);
    expect(m).toContain("[Cannot read properties");
    expect(m.length).toBeLessThan(400);
  });
  it("빈 값·비Error 입력도 안전", () => {
    expect(userMessage(new Error(""))).toContain("알 수 없는 오류");
    expect(userMessage("문자열 오류")).toBe("문자열 오류");
  });
});
