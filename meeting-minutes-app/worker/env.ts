export interface PipelineParams {
  jobId: string;
}

export interface Env {
  // 바인딩
  BUCKET: R2Bucket;
  HYPERDRIVE: Hyperdrive;
  PIPELINE: Workflow<PipelineParams>;

  // 설정 (wrangler.jsonc vars)
  R2_BUCKET_NAME: string;
  WHISPER_BASE_URL?: string;
  WHISPER_MODEL?: string;
  LLM_MODEL?: string;
  /** 전사 조각 길이(초). 기본 600 */
  CHUNK_SECONDS?: string;
  /** LLM 요약 청크 크기(글자). 기본 12000 */
  LLM_CHUNK_CHARS?: string;

  // 비밀 (wrangler secret put / .dev.vars)
  WHISPER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** 선택: Cloudflare AI Gateway 등 프록시를 쓸 때 */
  ANTHROPIC_BASE_URL?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export const chunkSeconds = (env: Env) => clampInt(env.CHUNK_SECONDS, 600, 60, 1200);
export const llmChunkChars = (env: Env) => clampInt(env.LLM_CHUNK_CHARS, 12_000, 4_000, 40_000);

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
