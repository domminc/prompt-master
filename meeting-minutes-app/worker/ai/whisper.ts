import type { Env } from "../env";
import { explainStatus, PipelineFatalError } from "../lib/errors";
import { fetchWithRetry, UpstreamError } from "../lib/http";
import { whisperToSegments, type WhisperSegment } from "../lib/segments";
import type { Segment } from "../../shared/types";

/**
 * 오디오 조각 하나를 Whisper 호환 API(OpenAI /audio/transcriptions)로 전사한다.
 * - WHISPER_BASE_URL 만 바꾸면 Groq 같은 Whisper 호환 서비스도 쓸 수 있다.
 * - 타임스탬프는 조각 기준이라 offsetMs 를 더해 전체 기준으로 바꾼다.
 */
export async function transcribeChunk(
  env: Env,
  audio: Uint8Array,
  opts: { index: number; language: string; offsetMs: number },
): Promise<Segment[]> {
  if (!env.WHISPER_API_KEY) {
    throw new PipelineFatalError("전사 실패: WHISPER_API_KEY 가 설정되지 않았습니다. 관리자에게 문의해 주세요.");
  }
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), `chunk-${String(opts.index).padStart(3, "0")}.mp3`);
  form.append("model", env.WHISPER_MODEL || "whisper-1");
  form.append("language", opts.language);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");

  const base = (env.WHISPER_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${base}/audio/transcriptions`,
      { method: "POST", headers: { Authorization: `Bearer ${env.WHISPER_API_KEY}` }, body: form },
      { timeoutMs: 180_000, retries: 2, baseDelayMs: 2000, label: "Whisper API" },
    );
  } catch (e) {
    if (e instanceof UpstreamError) {
      const msg = `${explainStatus("전사", "Whisper", e.status)} [${e.message}]`;
      // 키 오류·잘못된 요청은 다시 해도 같다. 429/5xx/네트워크는 Workflow 단계 재시도에 맡긴다.
      if (!e.retryable) throw new PipelineFatalError(msg);
      throw new Error(msg);
    }
    throw e;
  }

  const json = (await res.json().catch(() => null)) as { segments?: WhisperSegment[] } | null;
  if (!json || !Array.isArray(json.segments)) {
    throw new PipelineFatalError(
      "전사 실패: 전사 서비스가 구간별 타임스탬프를 돌려주지 않았습니다. WHISPER_MODEL 이 verbose_json(구간 타임스탬프)을 지원하는지 확인해 주세요.",
    );
  }
  return whisperToSegments(json.segments, opts.offsetMs);
}
