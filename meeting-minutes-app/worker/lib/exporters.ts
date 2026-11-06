import { eventTiming, weekdayKo } from "../../shared/calendar";
import { formatDuration, formatTimestamp } from "../../shared/format";
import { CONFIDENCE_LABEL, EVENT_KIND_LABEL, PRIORITY_LABEL } from "../../shared/labels";
import type { Segment } from "../../shared/types";
import type { MeetingSummary } from "../../shared/summary-schema";

export interface ExportJob {
  id: string;
  fileName: string | null;
  language: string;
  meetingDate: string;
  durationMs: number | null;
  segments: Segment[];
  summary: MeetingSummary | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** SRT 시간 형식: HH:MM:SS,mmm */
export function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor((t % 3_600_000) / 60_000))}:${pad(
    Math.floor((t % 60_000) / 1000),
  )},${pad(t % 1000, 3)}`;
}

export function toSrt(segments: Segment[]): string {
  return (
    segments
      .map((s, i) => {
        const end = Math.max(s.endMs, s.startMs + 1);
        return `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(end)}\n${s.text}\n`;
      })
      .join("\n") || ""
  );
}

export function toTxt(job: ExportJob): string {
  const head = [job.summary?.title ?? job.fileName ?? "회의록", `회의일: ${job.meetingDate} (${weekdayKo(job.meetingDate)})`];
  if (job.durationMs) head.push(`길이: ${formatDuration(job.durationMs)}`);
  head.push("");
  const body = job.segments.map((s) => `[${formatTimestamp(s.startMs)}] ${s.text}`);
  return [...head, ...body].join("\n") + "\n";
}

const cell = (s: string | null | undefined) =>
  (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

export function toMarkdown(job: ExportJob): string {
  const sum = job.summary;
  const L: string[] = [];
  L.push(`# ${sum?.title ?? job.fileName ?? "회의록"}`, "");
  L.push(`- 회의일: ${job.meetingDate} (${weekdayKo(job.meetingDate)})`);
  if (job.fileName) L.push(`- 파일: ${job.fileName}`);
  if (job.durationMs) L.push(`- 길이: ${formatDuration(job.durationMs)}`);
  L.push("");

  if (sum) {
    L.push("## 한눈에 보기", "", sum.tldr, "");

    L.push("## 핵심 결정사항", "");
    L.push(...(sum.decisions.length ? sum.decisions.map((d) => `- ${d}`) : ["- 없음"]), "");

    L.push("## 일정", "");
    if (sum.events.length) {
      L.push("| 날짜 | 시간 | 일정 | 구분 | 장소 | 확신도 | 회의 중 표현 |", "|---|---|---|---|---|---|---|");
      for (const e of sum.events) {
        const t = eventTiming(e);
        const date = e.date ? `${e.date} (${weekdayKo(e.date)})` : "미확인";
        const time = t && !t.allDay ? `${t.startTime}~${t.endTime}` : e.time ?? "-";
        L.push(
          `| ${date} | ${time} | ${cell(e.title)} | ${EVENT_KIND_LABEL[e.kind]} | ${cell(e.location)} | ${
            CONFIDENCE_LABEL[e.confidence]
          } | ${cell(e.dateText)} |`,
        );
      }
    } else {
      L.push("- 대화에서 확인된 일정이 없습니다.");
    }
    L.push("");

    L.push("## 액션 아이템", "");
    if (sum.actionItems.length) {
      L.push("| 할 일 | 담당자 | 기한 | 우선순위 |", "|---|---|---|---|");
      for (const a of sum.actionItems) {
        L.push(`| ${cell(a.task)} | ${cell(a.owner)} | ${cell(a.dueDate)} | ${PRIORITY_LABEL[a.priority]} |`);
      }
    } else {
      L.push("- 없음");
    }
    L.push("");

    L.push("## 미해결 질문", "");
    L.push(...(sum.openQuestions.length ? sum.openQuestions.map((q) => `- ${q}`) : ["- 없음"]), "");
  }

  L.push("## 대화록", "");
  for (const s of job.segments) L.push(`**[${formatTimestamp(s.startMs)}]** ${s.text}`, "");
  return L.join("\n");
}

export function toJson(job: ExportJob): string {
  return JSON.stringify(
    {
      id: job.id,
      fileName: job.fileName,
      language: job.language,
      meetingDate: job.meetingDate,
      durationMs: job.durationMs,
      segments: job.segments,
      summary: job.summary,
    },
    null,
    2,
  );
}

/** Content-Disposition 용 파일 이름 (경로·특수문자 제거) */
export function safeBaseName(name: string | null | undefined): string {
  const base = (name ?? "").replace(/\.[^./\\]{1,5}$/, "");
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "meeting";
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
