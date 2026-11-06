import { Hono } from "hono";
import { MAX_AUDIO_BYTES } from "../../shared/limits";
import type { CreateUploadResponse } from "../../shared/types";
import { claimForTranscribing, failJob, getJob, insertJob, markUploading } from "../db";
import { chunkSeconds } from "../env";
import { ApiError } from "../lib/errors";
import { planMp3Chunks, readMp3Info, Mp3Error } from "../lib/mp3";
import { todayKst } from "../lib/refdates";
import { parseCreateUpload } from "../lib/validate";
import { audioKey, isPresignConfigured, presignPut } from "../r2";
import { parseJobId, toDto, type AppEnv } from "./helpers";

export const uploads = new Hono<AppEnv>();

/** 짧게 유지: 업로드가 시작될 때까지만 유효하면 된다 */
const PRESIGN_TTL_SEC = 20 * 60;

// 1) 업로드 사전 요청: 검증 → jobs(queued) 생성 → R2 presigned PUT URL 발급
uploads.post("/", async (c) => {
  const req = parseCreateUpload(await c.req.json().catch(() => null));
  const id = crypto.randomUUID();
  const fileKey = audioKey(id);

  await insertJob(c.var.sql!, {
    id,
    fileKey,
    fileName: req.fileName,
    mimeType: req.mimeType,
    sizeBytes: req.sizeBytes,
    language: req.language,
    meetingDate: req.meetingDate ?? todayKst(),
  });

  const uploadUrl = isPresignConfigured(c.env) ? await presignPut(c.env, fileKey, PRESIGN_TTL_SEC) : `/api/uploads/${id}/audio`;
  const body: CreateUploadResponse = {
    jobId: id,
    uploadUrl,
    fileKey,
    expiresAt: new Date(Date.now() + PRESIGN_TTL_SEC * 1000).toISOString(),
  };
  return c.json(body, 201);
});

// 2) 클라이언트가 업로드를 시작했음을 알린다 (queued → uploading)
uploads.post("/:id/start", async (c) => {
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(c.var.sql!, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");
  await markUploading(c.var.sql!, id);
  return c.json({ ok: true });
});

// 로컬 개발용: R2 presigned URL 설정이 없을 때만 Worker 가 업로드를 대신 R2 에 저장한다.
uploads.put("/:id/audio", async (c) => {
  if (isPresignConfigured(c.env)) throw new ApiError(404, "사용할 수 없는 경로입니다");
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(c.var.sql!, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");
  if (job.status !== "queued" && job.status !== "uploading") throw new ApiError(409, "이미 업로드가 끝난 작업입니다");

  const len = Number(c.req.header("content-length") ?? 0);
  if (!len || len > MAX_AUDIO_BYTES) throw new ApiError(413, "오디오 크기가 올바르지 않습니다");
  if (!c.req.raw.body) throw new ApiError(400, "본문이 비어 있습니다");
  await c.env.BUCKET.put(job.fileKey, c.req.raw.body, { httpMetadata: { contentType: "audio/mpeg" } });
  return c.body(null, 200);
});

// 3) 업로드 완료 확인 → 파일 검증 → 상태 transcribing → 전사·요약 Workflow 시작
uploads.post("/:id/complete", async (c) => {
  const sql = c.var.sql!;
  const id = parseJobId(c.req.param("id"));
  const job = await getJob(sql, id);
  if (!job) throw new ApiError(404, "작업을 찾을 수 없습니다");

  const body = (await c.req.json().catch(() => ({}))) as { fileKey?: string };
  if (body.fileKey && body.fileKey !== job.fileKey) throw new ApiError(400, "파일 경로가 일치하지 않습니다");

  // 이미 시작된 작업이면(중복 호출·재시도) 현재 상태를 그대로 돌려준다
  if (job.status !== "queued" && job.status !== "uploading") return c.json(toDto(job));

  // R2 에 실제 객체가 있는지, 크기가 정상인지, 우리가 만든 형식(CBR MP3)인지 확인한다
  const head = await c.env.BUCKET.head(job.fileKey);
  if (!head) throw new ApiError(409, "업로드된 파일을 찾을 수 없습니다. 업로드가 끝난 뒤에 다시 시도해 주세요");
  if (head.size > MAX_AUDIO_BYTES) {
    await failJob(sql, id, "녹음이 너무 깁니다. 약 8시간 이하로 나눠서 올려 주세요.");
    await c.env.BUCKET.delete(job.fileKey);
    throw new ApiError(413, "녹음이 너무 깁니다. 약 8시간 이하로 나눠서 올려 주세요");
  }
  const headBytes = await c.env.BUCKET.get(job.fileKey, { range: { offset: 0, length: 65536 } });
  let durationMs: number;
  let chunkCount: number;
  try {
    const info = readMp3Info(new Uint8Array(await headBytes!.arrayBuffer()), head.size);
    durationMs = info.durationMs;
    chunkCount = planMp3Chunks(info, chunkSeconds(c.env)).length;
  } catch (e) {
    const msg = e instanceof Mp3Error ? e.message : "오디오 파일을 읽을 수 없습니다";
    await failJob(sql, id, `업로드된 오디오가 올바르지 않습니다: ${msg}`);
    throw new ApiError(422, `업로드된 오디오가 올바르지 않습니다: ${msg}`);
  }

  const claimed = await claimForTranscribing(sql, id, { durationMs, chunkCount });
  if (!claimed) {
    // 동시에 들어온 다른 complete 호출이 먼저 시작했다
    const cur = await getJob(sql, id);
    return c.json(toDto(cur ?? job));
  }
  try {
    await c.env.PIPELINE.create({ id: `${id}-${Date.now().toString(36)}`, params: { jobId: id } });
  } catch (e) {
    console.error("workflow create failed", e);
    await failJob(sql, id, "처리를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    throw new ApiError(502, "처리를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요");
  }
  return c.json(toDto(claimed));
});
