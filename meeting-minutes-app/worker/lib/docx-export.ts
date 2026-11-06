import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, Packer, PageNumber,
  Paragraph, ShadingType, Tab, Table, TableCell, TableRow, TabStopType, TextRun, WidthType,
} from "docx";
import { eventTimeLabel, formatKoreanDate, weekdayKo } from "../../shared/calendar";
import { formatDuration, formatTimestamp } from "../../shared/format";
import { CONFIDENCE_LABEL, EVENT_KIND_LABEL, PRIORITY_LABEL } from "../../shared/labels";
import type { ExportJob } from "./exporters";

// 회의록 Word(.docx) 문서. 편집해서 바로 쓸 수 있도록 실제 Word 제목 스타일·표·머리글/바닥글(쪽 번호)을 쓴다.
// 글꼴은 Pretendard 로 지정한다 — 열람하는 PC 에 설치돼 있지 않으면 Word 가 대체 글꼴로 보여 준다.

const FONT = { ascii: "Pretendard", hAnsi: "Pretendard", eastAsia: "Pretendard", cs: "Pretendard", hint: "eastAsia" } as const;
const COLOR = {
  text: "1E293B", title: "0F172A", muted: "64748B", accent: "4F46E5", accentBg: "EEF2FF",
  line: "CBD5E1", headBg: "F1F5F9", warn: "B45309", danger: "BE123C",
};

// A4, 좌우 여백 2cm → 본문 폭 9638 DXA (1440 DXA = 1인치)
const PAGE = { width: 11906, height: 16838 };
const MARGIN = { top: 1304, bottom: 1304, left: 1134, right: 1134 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/** XML 에서 허용되지 않는 제어 문자와 줄바꿈을 정리한다 (Word 가 파일을 거부하지 않도록) */
export const clean = (s: string | null | undefined): string =>
  (s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/[\r\n\t]+/g, " ").trim();

const thin = { style: BorderStyle.SINGLE, size: 4, color: COLOR.line };
const TABLE_BORDERS = { top: thin, bottom: thin, left: thin, right: thin, insideHorizontal: thin, insideVertical: thin };

interface RunOpts { bold?: boolean; color?: string; size?: number; italics?: boolean }
const run = (text: string, o: RunOpts = {}) => new TextRun({ text: clean(text), ...o });
const para = (children: TextRun[], extra: Record<string, unknown> = {}) =>
  new Paragraph({ spacing: { after: 60 }, children, ...extra });

const h1 = (text: string, pageBreakBefore = false) =>
  new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore, children: [run(text)] });

const none = (text: string) => para([run(text, { color: COLOR.muted, italics: true })]);
const bullet = (text: string) =>
  new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 }, children: [run(text)] });

function cell(width: number, children: Paragraph[], o: { fill?: string } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    ...(o.fill ? { shading: { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } } : {}),
    children,
  });
}

/** 열 너비 합이 곧 표 너비 — Word·LibreOffice·Google Docs 에서 같은 모양이 나오도록 둘 다 DXA 로 지정한다 */
function table(widths: number[], rows: TableRow[]) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    borders: TABLE_BORDERS,
    rows,
  });
}

const headRow = (widths: number[], labels: string[]) =>
  new TableRow({
    tableHeader: true, // 쪽이 넘어가도 머리글 행 반복
    cantSplit: true,
    children: labels.map((l, i) =>
      cell(widths[i]!, [para([run(l, { bold: true, size: 18, color: COLOR.muted })], { spacing: { after: 0 } })], { fill: COLOR.headBg }),
    ),
  });

const cellText = (text: string, o: RunOpts = {}) => para([run(text, { size: 19, ...o })], { spacing: { after: 20 } });

function infoTable(job: ExportJob) {
  const widths = [1700, CONTENT_WIDTH - 1700];
  const rows: Array<[string, string]> = [["회의일", formatKoreanDate(job.meetingDate)]];
  if (job.durationMs) rows.push(["녹음 길이", formatDuration(job.durationMs)]);
  if (job.fileName) rows.push(["원본 파일", job.fileName]);
  rows.push(["작성 방식", "회의록 AI 자동 생성 — 중요한 내용은 원본 녹음과 대조해 확인하세요"]);
  return table(
    widths,
    rows.map(
      ([k, v]) =>
        new TableRow({
          cantSplit: true,
          children: [
            cell(widths[0]!, [cellText(k, { bold: true, color: COLOR.muted })], { fill: COLOR.headBg }),
            cell(widths[1]!, [cellText(v)]),
          ],
        }),
    ),
  );
}

function eventsTable(events: NonNullable<ExportJob["summary"]>["events"]) {
  const widths = [1700, 1500, 2600, 2238, 1600]; // 합 9638
  const rows = events.map((e) => {
    const date = e.date ? `${e.date} (${weekdayKo(e.date)})` : "날짜 미정";
    const where = [e.location, e.attendees.length ? `참석: ${e.attendees.join(", ")}` : ""].filter(Boolean) as string[];
    const sub = [EVENT_KIND_LABEL[e.kind], e.dateText ? `원문 “${clean(e.dateText)}”` : ""].filter(Boolean).join(" · ");
    return new TableRow({
      cantSplit: true,
      children: [
        cell(widths[0]!, [cellText(date, e.date ? { bold: true } : { color: COLOR.muted })]),
        cell(widths[1]!, [cellText(eventTimeLabel(e) ?? "-")]),
        cell(widths[2]!, [cellText(e.title, { bold: true }), cellText(sub, { size: 16, color: COLOR.muted })]),
        cell(widths[3]!, where.length ? where.map((w) => cellText(w)) : [cellText("-", { color: COLOR.muted })]),
        cell(widths[4]!, [cellText(CONFIDENCE_LABEL[e.confidence], e.confidence === "low" ? { bold: true, color: COLOR.warn } : {})]),
      ],
    });
  });
  return table(widths, [headRow(widths, ["날짜", "시간", "일정", "장소 · 참석자", "확신도"]), ...rows]);
}

function actionsTable(items: NonNullable<ExportJob["summary"]>["actionItems"]) {
  const widths = [4300, 1700, 1900, 1738]; // 합 9638
  const rows = items.map(
    (a) =>
      new TableRow({
        cantSplit: true,
        children: [
          cell(widths[0]!, [cellText(a.task)]),
          cell(widths[1]!, [cellText(a.owner)]),
          cell(widths[2]!, [cellText(/^\d{4}-\d{2}-\d{2}$/.test(a.dueDate) ? `${a.dueDate} (${weekdayKo(a.dueDate)})` : a.dueDate)]),
          cell(widths[3]!, [cellText(PRIORITY_LABEL[a.priority], a.priority === "high" ? { bold: true, color: COLOR.danger } : {})]),
        ],
      }),
  );
  return table(widths, [headRow(widths, ["할 일", "담당자", "기한", "우선순위"]), ...rows]);
}

/** 쪽 번호가 들어가는 바닥글. 공백을 지키려고 정리 함수 없이 TextRun 을 직접 쓴다. */
function footer() {
  const style = { size: 16, color: COLOR.muted };
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "회의록 AI 가 자동으로 만든 문서입니다   |   ", ...style }),
          new TextRun({ children: [PageNumber.CURRENT], ...style }),
          new TextRun({ text: " / ", ...style }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], ...style }),
        ],
      }),
    ],
  });
}

export interface DocxOptions {
  /** 부록으로 전체 대화록을 붙일지 */
  includeTranscript?: boolean;
}

/** 완료된 작업을 Word 문서(.docx) 바이트로 만든다. */
export async function toDocx(job: ExportJob, opts: DocxOptions = {}): Promise<Uint8Array> {
  const sum = job.summary;
  if (!sum) throw new Error("요약이 없는 작업은 Word 문서로 만들 수 없습니다");
  const title = clean(sum.title) || "회의록";

  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [run(title)] }),
    infoTable(job),

    h1("1. 한눈에 보기"),
    new Paragraph({
      spacing: { before: 60, after: 120, line: 340 },
      indent: { left: 200, right: 120 },
      shading: { type: ShadingType.CLEAR, fill: COLOR.accentBg, color: "auto" },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: COLOR.accent, space: 8 } },
      children: [run(sum.tldr || "요약이 없습니다.")],
    }),

    h1("2. 핵심 결정사항"),
    ...(sum.decisions.length ? sum.decisions.map(bullet) : [none("확정된 결정사항이 없습니다.")]),

    h1("3. 일정"),
    ...(sum.events.length
      ? [
          eventsTable(sum.events),
          para(
            [run("※ ‘계산됨’은 “다음 주 화요일” 같은 표현을 회의일 기준으로 계산한 날짜입니다. ‘확인 필요’는 날짜·시간이 불확실하니 캘린더에 넣기 전에 확인해 주세요.", { size: 16, color: COLOR.muted })],
            { spacing: { before: 80, after: 60 } },
          ),
        ]
      : [none("대화에서 확인된 일정이 없습니다.")]),

    h1("4. 액션 아이템"),
    ...(sum.actionItems.length ? [actionsTable(sum.actionItems)] : [none("확인된 액션 아이템이 없습니다.")]),

    h1("5. 미해결 질문"),
    ...(sum.openQuestions.length ? sum.openQuestions.map(bullet) : [none("없음")]),
  ];

  if (opts.includeTranscript) {
    children.push(h1("부록. 대화록", true));
    for (const s of job.segments) {
      children.push(
        new Paragraph({
          spacing: { after: 50, line: 300 },
          indent: { left: 1300, hanging: 1300 }, // 타임스탬프 칸을 고정하고 이어지는 줄은 본문 칸에 맞춘다
          tabStops: [{ type: TabStopType.LEFT, position: 1300 }],
          children: [run(`[${formatTimestamp(s.startMs)}]`, { size: 17, color: COLOR.muted }), new TextRun({ children: [new Tab()] }), run(s.text, { size: 19 })],
        }),
      );
    }
  }

  const doc = new Document({
    creator: "회의록 AI",
    lastModifiedBy: "회의록 AI",
    title,
    description: "회의록 AI 가 자동 생성한 회의록",
    styles: {
      default: {
        document: { run: { font: FONT, size: 20, color: COLOR.text, language: { value: "ko-KR", eastAsia: "ko-KR" } }, paragraph: { spacing: { line: 324 } } },
        title: { run: { font: FONT, size: 40, bold: true, color: COLOR.title }, paragraph: { spacing: { before: 0, after: 200 }, keepNext: true } },
        heading1: {
          run: { font: FONT, size: 26, bold: true, color: COLOR.accent },
          paragraph: {
            spacing: { before: 360, after: 120 },
            keepNext: true,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E2E8F0", space: 4 } },
          },
        },
        heading2: { run: { font: FONT, size: 22, bold: true, color: COLOR.title }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true } },
      },
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }],
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: PAGE, margin: MARGIN }, titlePage: true },
        // 첫 쪽에는 제목이 이미 크게 있으므로 머리글을 비우고, 둘째 쪽부터 회의 제목을 작게 보여 준다
        headers: {
          first: new Header({ children: [new Paragraph({})] }),
          default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(title, { size: 16, color: COLOR.muted })] })] }),
        },
        footers: { first: footer(), default: footer() },
        children,
      },
    ],
  });

  // Node 전용 Buffer 대신 ArrayBuffer 로 받는다 (Workers 에서도 동일하게 동작)
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
