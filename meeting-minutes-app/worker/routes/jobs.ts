import { Hono } from "hono";
import { EXPORT_FORMATS, type ExportFormat } from "../../shared/types";
import { STALE_AFTER_MS } from "../../shared/limits";
import { claimRetry, deleteJob, failIfStale, failJob, getJob, getSegments } from "../db";
import { ApiError } from "../lib/errors";
import { buildIcs } from "../../shared/ics";
import {
  contentDisposition, safeBaseName, toJson, toMarkdown, toSrt, toTxt, type ExportJob,
} from "../lib/exporters";
import { audioKey, deletePrefix, exportKey } from "../r2";
import { parseJobId, toDto, type AppEnv } from "./helpers";

export const jobs = new Hono<AppEnv>();

const STALE_MESSAGE = "처리가 20분 넘게 응답하지 않아 중단했어요. '다시 시도'를 눌러 주세요.";

// 작업 상태 + 결과 조회 (폴링용). segments 는 완료됐을 때만 내려 폴링 응답을 가볍게 유지한다.
jobs.get("/:id", async (c) => {
  const sql = c.var.sql!;
  const id = parseJobId(c.req.param("id"));
  let job = await getJob(sql, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");

  // 워커·Workflow 가 어떤 이유로 사라져도 화면이 영원히 "처리 중"에 멈추지 않게 한다
  if (job.status !== "completed" && job.status !== "failed" && (await failIfStale(sql, id, STALE_AFTER_MS, STALE_MESSAGE))) {
    job = (await getJob(sql, id)) ?? job;
  }
  const segments = job.status === "completed" ? await getSegments(sql, id) : [];
  return c.json(toDto(job, segments));
});

// 실패한 작업 재시도: 이미 전사된 조각은 건너뛰고 실패한 단계부터 이어서 한다
jobs.post("/:id/retry", async (c) => {
  const sql = c.var.sql!;
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(sql, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");
  if (job.status !== "failed") throw new ApiError(409, "실패한 작업만 다시 시도할 수 있어요");
  if (!job.durationMs) throw new ApiError(409, "업로드가 끝나지 않은 작업입니다. 파일을 처음부터 다시 올려 주세요");

  const claimed = await claimRetry(sql, id);
  if (!claimed) return c.json(toDto((await getJob(sql, id)) ?? job));
  await deletePrefix(c.env.BUCKET, `exports/${id}/`);
  try {
    await c.env.PIPELINE.create({ id: `${id}-${Date.now().toString(36)}`, params: { jobId: id } });
  } catch (e) {
    console.error("workflow create failed (retry)", e);
    await failJob(sql, id, "처리를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    throw new ApiError(502, "처리를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요");
  }
  return c.json(toDto(claimed));
});

// 삭제: 녹음·전사·요약을 모두 지운다 (회의 내용은 민감할 수 있다)
jobs.delete("/:id", async (c) => {
  const sql = c.var.sql!;
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(sql, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");
  await c.env.BUCKET.delete(audioKey(id));
  await deletePrefix(c.env.BUCKET, `exports/${id}/`);
  await deleteJob(sql, id);
  return c.json({ ok: true });
});

// 플레이어용 오디오 스트림 (Range 지원: 대화록을 눌러 특정 시간으로 이동하려면 필요)
jobs.get("/:id/media", async (c) => {
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(c.var.sql!, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");

  const wantsRange = c.req.header("range");
  const obj = await c.env.BUCKET.get(job.fileKey, wantsRange ? { range: c.req.raw.headers } : undefined);
  if (!obj) throw new ApiError(404, "오디오 파일을 찾을 수 없습니다");

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  let status = 200;
  let length = obj.size;
  if (wantsRange && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.offset ?? (r.suffix !== undefined ? obj.size - r.suffix : 0);
    length = r.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    status = 206;
  }
  headers.set("Content-Length", String(length));
  return new Response(obj.body, { status, headers });
});

const CONTENT_TYPES: Record<ExportFormat, string> = {
  srt: "application/x-subrip; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  ics: "text/calendar; charset=utf-8",
};

// 내보내기: srt / txt / md / json / ics. 처음 요청 때 만들어 R2(exports/{id}/)에 캐시한다.
jobs.get("/:id/export", async (c) => {
  const sql = c.var.sql!;
  const id = parseJobId(c.req.param("id"));
  const format = c.req.query("format") as ExportFormat | undefined;
  if (!format || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ApiError(400, `format 은 ${EXPORT_FORMATS.join(", ")} 중 하나여야 합니다`);
  }
  const job = await getJob(sql, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");
  if (job.status !== "completed" || !job.summary) throw new ApiError(409, "아직 처리 중이에요. 완료된 뒤에 내려받을 수 있어요");

  const key = exportKey(id, format);
  let text: string;
  const cached = await c.env.BUCKET.get(key);
  if (cached) {
    text = await cached.text();
  } else {
    const exportJob: ExportJob = {
      id: job.id,
      fileName: job.fileName,
      language: job.language,
      meetingDate: job.meetingDate,
      durationMs: job.durationMs,
      segments: await getSegments(sql, id),
      summary: job.summary,
    };
    text =
      format === "srt" ? toSrt(exportJob.segments)
      : format === "txt" ? toTxt(exportJob)
      : format === "md" ? toMarkdown(exportJob)
      : format === "json" ? toJson(exportJob)
      : buildIcs(job.summary.events, { calendarName: `${job.summary.title} 일정`, uidPrefix: id, meetingTitle: job.summary.title });
    c.executionCtx.waitUntil(c.env.BUCKET.put(key, text, { httpMetadata: { contentType: CONTENT_TYPES[format] } }));
  }

  const filename = `${safeBaseName(job.summary.title || job.fileName)}.${format}`;
  return new Response(text, {
    headers: {
      "Content-Type": CONTENT_TYPES[format],
      "Content-Disposition": contentDisposition(filename),
      "X-Content-Type-Options": "nosniff",
    },
  });
});
