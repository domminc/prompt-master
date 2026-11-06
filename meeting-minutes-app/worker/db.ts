import postgres from "postgres";
import type { Env } from "./env";
import type { JobStatus, Segment } from "../shared/types";
import type { MeetingSummary } from "../shared/summary-schema";

export type Sql = ReturnType<typeof postgres>;

/**
 * Hyperdrive 연결. Workers 에서는 요청마다 클라이언트를 만들고 끝나면 닫는다
 * (연결 풀링은 Hyperdrive 가 맡는다).
 */
export function connect(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, onnotice: () => {} });
}

export interface JobRow {
  id: string;
  status: JobStatus;
  fileKey: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  language: string;
  meetingDate: string;
  durationMs: number | null;
  progressDone: number;
  progressTotal: number;
  errorMessage: string | null;
  summary: MeetingSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawJob {
  id: string;
  status: JobStatus;
  file_key: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  language: string;
  meeting_date: string;
  duration_ms: number | null;
  progress_done: number;
  progress_total: number;
  error_message: string | null;
  summary: MeetingSummary | null;
  created_at: Date;
  updated_at: Date;
}

// bigint/date 는 문자열로 받아 와서(타임존·정밀도 문제 방지) 여기서 변환한다.
const JOB_COLUMNS = (sql: Sql) => sql`
  id, status, file_key, file_name, mime_type, size_bytes::text as size_bytes, language,
  meeting_date::text as meeting_date, duration_ms, progress_done, progress_total,
  error_message, summary, created_at, updated_at`;

const mapJob = (r: RawJob): JobRow => ({
  id: r.id,
  status: r.status,
  fileKey: r.file_key,
  fileName: r.file_name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  language: r.language,
  meetingDate: r.meeting_date,
  durationMs: r.duration_ms,
  progressDone: r.progress_done,
  progressTotal: r.progress_total,
  errorMessage: r.error_message,
  summary: r.summary,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const one = (rows: RawJob[]): JobRow | null => (rows[0] ? mapJob(rows[0]) : null);

export async function insertJob(
  sql: Sql,
  j: { id: string; fileKey: string; fileName: string; mimeType: string; sizeBytes: number; language: string; meetingDate: string },
): Promise<void> {
  await sql`
    insert into jobs (id, status, file_key, file_name, mime_type, size_bytes, language, meeting_date)
    values (${j.id}, 'queued', ${j.fileKey}, ${j.fileName}, ${j.mimeType}, ${j.sizeBytes}, ${j.language}, ${j.meetingDate})`;
}

export async function getJob(sql: Sql, id: string): Promise<JobRow | null> {
  return one(await sql<RawJob[]>`select ${JOB_COLUMNS(sql)} from jobs where id = ${id}`);
}

/** queued → uploading. 이미 넘어갔으면 아무것도 하지 않는다. */
export async function markUploading(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set status = 'uploading', updated_at = now() where id = ${id} and status = 'queued'`;
}

/**
 * 업로드 완료 → 전사 시작. 조건부 UPDATE 라서 complete 를 두 번 호출해도
 * 한 번만 성공(= Workflow 도 한 번만 생성)한다.
 */
export async function claimForTranscribing(
  sql: Sql,
  id: string,
  v: { durationMs: number; chunkCount: number },
): Promise<JobRow | null> {
  return one(await sql<RawJob[]>`
    update jobs set status = 'transcribing', duration_ms = ${v.durationMs}, progress_total = ${v.chunkCount},
      progress_done = 0, error_message = null, updated_at = now()
    where id = ${id} and status in ('queued', 'uploading')
    returning ${JOB_COLUMNS(sql)}`);
}

/** failed → transcribing (재시도). 실패한 작업만 되살린다. */
export async function claimRetry(sql: Sql, id: string): Promise<JobRow | null> {
  return one(await sql<RawJob[]>`
    update jobs set status = 'transcribing', error_message = null, summary = null, updated_at = now()
    where id = ${id} and status = 'failed' and duration_ms is not null
    returning ${JOB_COLUMNS(sql)}`);
}

export async function failJob(sql: Sql, id: string, message: string): Promise<void> {
  await sql`
    update jobs set status = 'failed', error_message = ${message.slice(0, 1000)}, updated_at = now()
    where id = ${id} and status <> 'completed'`;
}

export async function setStatus(sql: Sql, id: string, status: JobStatus): Promise<void> {
  await sql`update jobs set status = ${status}, updated_at = now() where id = ${id}`;
}

export async function setProgress(sql: Sql, id: string, done: number): Promise<void> {
  await sql`update jobs set progress_done = greatest(progress_done, ${done}), updated_at = now() where id = ${id}`;
}

export async function touchJob(sql: Sql, id: string): Promise<void> {
  await sql`update jobs set updated_at = now() where id = ${id}`;
}

export async function completeJob(sql: Sql, id: string, summary: MeetingSummary): Promise<void> {
  await sql`
    update jobs set status = 'completed', summary = ${sql.json(summary as unknown as Parameters<typeof sql.json>[0])},
      error_message = null, updated_at = now()
    where id = ${id}`;
}

/** 진행 중인데 오래 갱신이 없는 작업을 실패로 돌린다. 바뀌었으면 true. */
export async function failIfStale(sql: Sql, id: string, staleMs: number, message: string): Promise<boolean> {
  const rows = await sql`
    update jobs set status = 'failed', error_message = ${message}, updated_at = now()
    where id = ${id} and status in ('queued', 'uploading', 'transcribing', 'summarizing')
      and updated_at < now() - make_interval(secs => ${staleMs / 1000})
    returning id`;
  return rows.length > 0;
}

export async function deleteJob(sql: Sql, id: string): Promise<void> {
  await sql`delete from jobs where id = ${id}`; // transcript_segments 는 on delete cascade
}

// ── 전사 세그먼트 ───────────────────────────────────────────────

export async function hasChunk(sql: Sql, jobId: string, chunkIndex: number): Promise<boolean> {
  const rows = await sql`select 1 from transcript_segments where job_id = ${jobId} and chunk_index = ${chunkIndex} limit 1`;
  return rows.length > 0;
}

/** 조각 단위로 지우고 다시 넣는다 — 같은 조각을 재시도해도 중복이 생기지 않는다. */
export async function replaceChunkSegments(sql: Sql, jobId: string, chunkIndex: number, segs: Segment[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from transcript_segments where job_id = ${jobId} and chunk_index = ${chunkIndex}`;
    if (segs.length === 0) return;
    const rows = segs.map((s) => ({ job_id: jobId, chunk_index: chunkIndex, start_ms: s.startMs, end_ms: s.endMs, text: s.text }));
    await tx`insert into transcript_segments ${tx(rows, "job_id", "chunk_index", "start_ms", "end_ms", "text")}`;
  });
}

export async function getSegments(sql: Sql, jobId: string): Promise<Segment[]> {
  const rows = await sql<{ start_ms: number; end_ms: number; text: string }[]>`
    select start_ms, end_ms, text from transcript_segments where job_id = ${jobId} order by start_ms, id`;
  return rows.map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, text: r.text }));
}

/** jobs.transcript 에 전체 전사본을 한 덩어리로 저장하고 세그먼트 수를 돌려준다. */
export async function saveFullTranscript(sql: Sql, jobId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    with agg as (
      select string_agg(text, E'\n' order by start_ms, id) as t, count(*)::int as n
      from transcript_segments where job_id = ${jobId}
    ), up as (
      update jobs set transcript = (select t from agg), updated_at = now() where id = ${jobId}
    )
    select n from agg`;
  return rows[0]?.n ?? 0;
}
