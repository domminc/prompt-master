import type { Context } from "hono";
import type { JobDto, Segment } from "../../shared/types";
import type { JobRow, Sql } from "../db";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";

export type AppEnv = { Bindings: Env; Variables: { sql: Sql | undefined } };
export type AppContext = Context<AppEnv>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 경로의 :id 가 UUID 인지 확인 (아니면 DB 오류 대신 404) */
export function parseJobId(raw: string | undefined): string {
  if (!raw || !UUID_RE.test(raw)) throw new ApiError(404, "작업을 찾을 수 없습니다");
  return raw.toLowerCase();
}

export function toDto(job: JobRow, segments: Segment[] = []): JobDto {
  return {
    id: job.id,
    status: job.status,
    fileName: job.fileName,
    language: job.language,
    meetingDate: job.meetingDate,
    durationMs: job.durationMs,
    progress: { done: job.progressDone, total: job.progressTotal },
    errorMessage: job.errorMessage,
    segments,
    summary: job.summary,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
