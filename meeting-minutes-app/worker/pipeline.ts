import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { LlmSummary } from "../shared/summary-schema";
import { extractFromChunk, mergePartials } from "./ai/summarize";
import { normalizeSummary } from "./ai/normalize";
import { transcribeChunk } from "./ai/whisper";
import {
  completeJob, connect, failJob, getJob, getSegments, hasChunk, replaceChunkSegments,
  saveFullTranscript, setProgress, setStatus, touchJob, type Sql,
} from "./db";
import { chunkSeconds, llmChunkChars, type Env, type PipelineParams } from "./env";
import { buildTranscriptChunks } from "./lib/chunking";
import { PipelineFatalError, userMessage } from "./lib/errors";
import { planMp3Chunks, readMp3Info, sliceMp3Chunk, type Mp3Chunk, type Mp3Info } from "./lib/mp3";

/**
 * 전사 → 요약 → 저장을 단계(step)로 쪼갠 Cloudflare Workflow.
 * - 단계마다 결과가 영속화되어, 실패한 단계만 재시도하고 이미 끝난 단계는 건너뛴다.
 * - 긴 작업이라도 Worker 요청 시간 제한에 걸리지 않는다.
 * - 각 단계는 멱등이다 (같은 단계를 다시 실행해도 데이터가 중복되지 않는다).
 */

const TRANSCRIBE_STEP = { retries: { limit: 3, delay: "15 seconds", backoff: "exponential" }, timeout: "6 minutes" } as const;
const LLM_STEP = { retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "8 minutes" } as const;
const DB_STEP = { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" }, timeout: "1 minute" } as const;

interface Plan {
  info: Mp3Info;
  chunks: Mp3Chunk[];
  language: string;
  meetingDate: string;
  fileKey: string;
}

/** DB 연결을 열고 닫는 단계 실행 헬퍼. 재시도해도 소용없는 오류는 NonRetryableError 로 바꾼다. */
async function withSql<T>(env: Env, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = connect(env);
  try {
    return await fn(sql);
  } catch (e) {
    if (e instanceof PipelineFatalError) throw new NonRetryableError(e.message);
    throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export class MeetingPipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: Readonly<WorkflowEvent<PipelineParams>>, step: WorkflowStep) {
    const { jobId } = event.payload;
    const env = this.env;

    try {
      // 1) 오디오 파일을 읽어 전사 조각 계획을 세운다
      const plan = (await step.do("plan", DB_STEP, () =>
        withSql(env, async (sql) => {
          const job = await getJob(sql, jobId);
          if (!job) throw new PipelineFatalError("작업을 찾을 수 없습니다.");
          const head = await env.BUCKET.get(job.fileKey, { range: { offset: 0, length: 65536 } });
          if (!head) throw new PipelineFatalError("업로드된 오디오 파일을 찾을 수 없습니다. 다시 올려 주세요.");
          const info = readMp3Info(new Uint8Array(await head.arrayBuffer()), head.size);
          const chunks = planMp3Chunks(info, chunkSeconds(env));
          return { info, chunks, language: job.language, meetingDate: job.meetingDate, fileKey: job.fileKey } satisfies Plan;
        }),
      )) as unknown as Plan;

      // 2) 조각별 전사 (조각 하나가 한 단계 — 실패해도 그 조각만 재시도)
      for (const c of plan.chunks) {
        await step.do(`transcribe-${c.index + 1}-of-${plan.chunks.length}`, TRANSCRIBE_STEP, () =>
          withSql(env, async (sql) => {
            if (await hasChunk(sql, jobId, c.index)) return { index: c.index, segments: -1 }; // 이미 끝난 조각 (재시도 시)
            const obj = await env.BUCKET.get(plan.fileKey, { range: { offset: c.start, length: c.readLength } });
            if (!obj) throw new PipelineFatalError("오디오 파일을 읽지 못했습니다.");
            const piece = sliceMp3Chunk(new Uint8Array(await obj.arrayBuffer()), c, plan.info);
            const segs = await transcribeChunk(env, piece, { index: c.index, language: plan.language, offsetMs: c.offsetMs });
            await replaceChunkSegments(sql, jobId, c.index, segs);
            await setProgress(sql, jobId, c.index + 1);
            return { index: c.index, segments: segs.length };
          }),
        );
      }

      // 3) 전체 전사본 저장 + 요약 단계로 전환
      const prepared = await step.do("prepare-summary", DB_STEP, () =>
        withSql(env, async (sql) => {
          const n = await saveFullTranscript(sql, jobId);
          if (n === 0) {
            throw new PipelineFatalError(
              "전사 결과가 비어 있습니다. 녹음에 말소리가 없거나 언어 설정이 맞지 않을 수 있어요. 언어를 확인하고 다시 시도해 주세요.",
            );
          }
          const chunks = buildTranscriptChunks(await getSegments(sql, jobId), { maxChars: llmChunkChars(env) });
          await setStatus(sql, jobId, "summarizing");
          return { count: chunks.length };
        }),
      );

      // 4) 구간별 추출 (map). 청크 경계는 DB 의 세그먼트로 다시 계산하므로 단계 출력은 작게 유지된다.
      const parts: LlmSummary[] = [];
      for (let i = 0; i < prepared.count; i++) {
        const part = await step.do(`extract-${i + 1}-of-${prepared.count}`, LLM_STEP, () =>
          withSql(env, async (sql) => {
            const chunks = buildTranscriptChunks(await getSegments(sql, jobId), { maxChars: llmChunkChars(env) });
            const transcript = chunks[i];
            if (!transcript) throw new PipelineFatalError("요약할 전사본을 찾지 못했습니다.");
            const out = await extractFromChunk(env, { transcript, meetingDate: plan.meetingDate, part: i + 1, partCount: prepared.count });
            await touchJob(sql, jobId);
            return out;
          }),
        );
        parts.push(part as unknown as LlmSummary);
      }

      // 5) 통합 (reduce) — 구간이 하나면 그 결과가 곧 최종본
      const merged =
        parts.length === 1
          ? parts[0]!
          : ((await step.do("merge", LLM_STEP, () =>
              withSql(env, async (sql) => {
                const out = await mergePartials(env, parts, plan.meetingDate);
                await touchJob(sql, jobId);
                return out;
              }),
            )) as unknown as LlmSummary);

      // 6) 후처리(날짜 검증·중복 제거·정렬) 후 저장하고 완료 처리
      await step.do("save", DB_STEP, () =>
        withSql(env, async (sql) => {
          await completeJob(sql, jobId, normalizeSummary(merged, { meetingDate: plan.meetingDate }));
        }),
      );
    } catch (e) {
      // 조용히 죽지 않는다: 원인을 DB 에 남겨 화면에서 보이게 한다.
      const message = userMessage(e);
      await step.do("record-failure", DB_STEP, () => withSql(env, (sql) => failJob(sql, jobId, message)));
      throw e;
    }
  }
}
