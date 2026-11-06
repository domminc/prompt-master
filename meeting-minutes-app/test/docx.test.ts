import { writeFileSync } from "node:fs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { clean, toDocx } from "../worker/lib/docx-export";
import type { ExportJob } from "../worker/lib/exporters";
import type { MeetingSummary } from "../shared/summary-schema";

const summary: MeetingSummary = {
  title: "신규 기능 출시 일정 회의",
  tldr: "출시일을 12월 첫째 주로 확정했다.",
  decisions: ["신규 기능 출시일을 12월 첫째 주로 확정한다.", "QA 일정을 1주 앞당긴다."],
  actionItems: [
    { task: "QA 체크리스트 작성", owner: "민수", dueDate: "2026-11-06", priority: "high", evidenceMs: 65_000 },
    { task: "마케팅 일정 초안 | 공유", owner: "미확인", dueDate: "미확인", priority: "medium", evidenceMs: null },
  ],
  events: [
    { title: "2차 디자인 리뷰", kind: "meeting", date: "2026-11-10", time: "15:00", endTime: null, dateText: "다음 주 화요일 오후 3시", location: "3층 회의실", attendees: ["민수", "지연"], confidence: "medium", evidenceMs: 120_000 },
    { title: "연말 정산 서류 제출", kind: "deadline", date: "2026-11-30", time: null, endTime: null, dateText: "이번 달 말까지", location: null, attendees: [], confidence: "high", evidenceMs: null },
    { title: "마케팅 공개", kind: "milestone", date: null, time: null, endTime: null, dateText: "추후 협의", location: null, attendees: [], confidence: "low", evidenceMs: null },
  ],
  openQuestions: ["마케팅 공개 일정은 언제로 할지"],
};
const segments = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 4000, endMs: i * 4000 + 3800, text: `${i}번째 발언입니다.` }));
const job: ExportJob = {
  id: "11111111-1111-1111-1111-111111111111", fileName: "주간 회의.mp4", language: "ko", meetingDate: "2026-11-06", durationMs: 3_723_000, segments, summary,
};

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (name: string) => (await zip.file(name)!.async("string"));
  return { zip, text, doc: await text("word/document.xml"), styles: await text("word/styles.xml") };
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("Word(.docx) 내보내기", () => {
  it("유효한 ZIP(docx)이고 폴더 항목이 없다", async () => {
    const bytes = await toDocx(job);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    const { zip } = await open(bytes);
    for (const f of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/footer1.xml", "docProps/core.xml"]) expect(zip.file(f), f).not.toBeNull();
    expect(Object.values(zip.files).filter((f) => f.dir)).toHaveLength(0); // 폴더 항목이 있으면 일부 Word 환경에서 열리지 않는다
  });

  it("A4 세로, 한국어 문서, Pretendard 글꼴", async () => {
    const { doc, styles, zip } = await open(await toDocx(job));
    expect(doc).toContain('w:w="11906"');
    expect(doc).toContain('w:h="16838"');
    expect(styles).toContain("Pretendard");
    expect(styles).toContain('w:eastAsia="ko-KR"');
    expect(await zip.file("docProps/core.xml")!.async("string")).toContain("신규 기능 출시 일정 회의");
  });

  it("내용: 제목·요약·결정·일정·액션·질문이 들어간다", async () => {
    const { doc } = await open(await toDocx(job));
    for (const t of [
      "신규 기능 출시 일정 회의", "2026년 11월 6일 (금)", "1시간 2분", "주간 회의.mp4",
      "1. 한눈에 보기", "2. 핵심 결정사항", "3. 일정", "4. 액션 아이템", "5. 미해결 질문",
      "QA 일정을 1주 앞당긴다.", "2차 디자인 리뷰", "2026-11-10 (화)", "15:00", "3층 회의실", "참석: 민수, 지연", "계산됨",
      "종일", "날짜 미정", "확인 필요", "QA 체크리스트 작성", "2026-11-06 (금)", "높음", "마케팅 공개 일정은 언제로 할지",
    ]) expect(doc, t).toContain(t);
  });

  it("실제 Word 제목 스타일을 쓰고(탐색창·목차용), 표는 3개이며 모든 표에 행이 있다", async () => {
    const { doc } = await open(await toDocx(job));
    expect(count(doc, /<w:pStyle w:val="Heading1"/g)).toBe(5);
    expect(count(doc, /<w:pStyle w:val="Title"/g)).toBe(1);
    const tables = doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
    expect(tables).toHaveLength(3); // 정보 · 일정 · 액션
    for (const t of tables) expect(count(t, /<w:tr[ >]/g)).toBeGreaterThan(0);
  });

  it("표의 열 너비 합이 모두 본문 폭(9638 DXA)과 같다", async () => {
    const { doc } = await open(await toDocx(job));
    for (const t of doc.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
      const widths = [...(t.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)![0].matchAll(/<w:gridCol w:w="(\d+)"/g))].map((m) => Number(m[1]));
      expect(widths.reduce((a, b) => a + b, 0)).toBe(9638);
      expect(t).toContain('w:type="dxa"'); // 퍼센트 폭은 Google Docs 에서 깨진다
    }
  });

  it("바닥글에 쪽 번호 필드(PAGE / NUMPAGES), 일정·액션 표는 머리글 행 반복", async () => {
    const { text, doc } = await open(await toDocx(job));
    const footer = await text("word/footer1.xml");
    expect(footer).toMatch(/PAGE/);
    expect(footer).toMatch(/NUMPAGES/);
    expect(count(doc, /<w:tblHeader/g)).toBe(2);
    expect(count(doc, /<w:cantSplit/g)).toBeGreaterThan(5); // 행이 쪽 사이에서 잘리지 않게
  });

  it("기본은 요약본: 대화록 부록이 없다", async () => {
    const { doc } = await open(await toDocx(job));
    expect(doc).not.toContain("부록. 대화록");
    expect(doc).not.toContain("[00:00:00]");
  });

  it("includeTranscript: 새 쪽에서 시작하는 부록에 모든 발언이 타임스탬프와 함께 들어간다", async () => {
    const { doc } = await open(await toDocx(job, { includeTranscript: true }));
    expect(doc).toContain("부록. 대화록");
    expect(count(doc, /<w:pageBreakBefore/g)).toBe(1);
    expect(doc).toContain("[00:00:00]");
    expect(doc).toContain("[00:02:36]"); // 39번째 = 156초
    expect(doc).toContain("39번째 발언입니다.");
    expect(count(doc, /\[\d\d:\d\d:\d\d\]/g)).toBe(40);
    expect(count(doc, /<w:tab\/>/g)).toBeGreaterThanOrEqual(40);
  });

  it("제어 문자·줄바꿈을 정리하고 XML 특수문자는 이스케이프한다", async () => {
    expect(clean("a\u0007b\r\nc\td ")).toBe("ab c d");
    const nasty: ExportJob = {
      ...job,
      segments: [{ startMs: 0, endMs: 1000, text: "줄\n바꿈\u0000과 <태그> & \"따옴표\"" }],
      summary: { ...summary, title: "R&D <킥오프>\u000B회의", decisions: ["결정\n두 줄"] },
    };
    const { doc } = await open(await toDocx(nasty, { includeTranscript: true }));
    expect(doc).toContain("R&amp;D &lt;킥오프&gt;회의");
    expect(doc).toContain("줄 바꿈과 &lt;태그&gt; &amp;");
    expect(doc).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(doc).not.toMatch(/<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/);
  });

  it("일정·액션·결정이 하나도 없으면 빈 표 대신 안내 문구 (빈 표는 Word 에서 오류)", async () => {
    const { doc } = await open(await toDocx({ ...job, summary: { ...summary, decisions: [], actionItems: [], events: [], openQuestions: [] } }));
    expect(count(doc, /<w:tbl>/g)).toBe(1); // 정보 표만
    for (const msg of ["확정된 결정사항이 없습니다.", "대화에서 확인된 일정이 없습니다.", "확인된 액션 아이템이 없습니다."]) expect(doc).toContain(msg);
  });

  it("요약이 없으면 만들지 않는다", async () => {
    await expect(toDocx({ ...job, summary: null })).rejects.toThrow("요약이 없는");
  });

  it("1시간 회의 규모(대화록 3,000문장)도 몇 초 안에 만든다", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => ({ startMs: i * 1200, endMs: i * 1200 + 1100, text: `${i}번째 발언으로 제품 로드맵과 팀 운영 방식을 이야기합니다.` }));
    const t0 = performance.now();
    const bytes = await toDocx({ ...job, segments: big }, { includeTranscript: true });
    const ms = performance.now() - t0;
    console.log(`대화록 3,000문장 docx: ${(bytes.length / 1024).toFixed(0)}KB, ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(5000);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
  });

  // 렌더링 확인용 샘플 저장 (DOCX_OUT_DIR 지정 시): LibreOffice 로 PDF 변환해 눈으로 확인할 때 쓴다
  it.skipIf(!process.env.DOCX_OUT_DIR)("샘플 저장", async () => {
    const dir = process.env.DOCX_OUT_DIR!;
    writeFileSync(`${dir}/summary.docx`, await toDocx(job));
    writeFileSync(`${dir}/full.docx`, await toDocx(job, { includeTranscript: true }));
  });
});
