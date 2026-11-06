import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmSummarySchema, type LlmSummary } from "../../shared/summary-schema";
import type { Env } from "../env";
import { PipelineFatalError } from "../lib/errors";
import { buildExtractUser, buildMergeUser, SYSTEM_EXTRACT, SYSTEM_MERGE } from "./prompts";

export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

function makeClient(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new PipelineFatalError("요약 실패: ANTHROPIC_API_KEY 가 설정되지 않았습니다. 관리자에게 문의해 주세요.");
  }
  // SDK 가 429/5xx/연결 오류를 지수 백오프로 재시도한다(maxRetries). 시도 1회당 제한 시간은 timeout.
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL, timeout: 180_000, maxRetries: 3 });
}

/** 구조화 출력(JSON 스키마 강제)으로 한 번 호출한다. 스키마가 보장되므로 JSON 파싱 재요청이 필요 없다. */
async function ask(env: Env, system: string, user: string): Promise<LlmSummary> {
  const client = makeClient(env);
  let res;
  try {
    res = await client.messages.parse({
      model: env.LLM_MODEL || DEFAULT_LLM_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(LlmSummarySchema), effort: "medium" },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new PipelineFatalError("요약 실패: Anthropic API 키가 올바르지 않거나 권한이 없습니다. 관리자에게 문의해 주세요.");
    }
    if (e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) {
      throw new PipelineFatalError(`요약 실패: 요청이 거부되었습니다 (모델 이름 LLM_MODEL 을 확인해 주세요). ${e.message}`);
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("요약 실패: Anthropic 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (e instanceof Anthropic.APIError) throw new Error(`요약 실패: Anthropic API 오류 ${e.status ?? ""} ${e.message}`);
    throw new Error(`요약 실패: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (res.stop_reason === "refusal") {
    throw new PipelineFatalError("요약 실패: AI 가 이 내용의 요약을 거부했습니다.");
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("요약 실패: 결과가 너무 길어 중간에 끊겼습니다.");
  }
  if (!res.parsed_output) {
    throw new Error("요약 실패: AI 응답을 해석하지 못했습니다.");
  }
  return res.parsed_output;
}

/** 전사본 청크 하나에서 요약·결정·액션 아이템·일정을 뽑는다. 청크가 1개면 결과가 곧 최종본이다. */
export function extractFromChunk(
  env: Env,
  args: { transcript: string; meetingDate: string; part: number; partCount: number },
): Promise<LlmSummary> {
  return ask(env, SYSTEM_EXTRACT, buildExtractUser(args));
}

/** 구간별 결과를 하나의 최종 회의록으로 통합한다. */
export function mergePartials(env: Env, parts: LlmSummary[], meetingDate: string): Promise<LlmSummary> {
  return ask(env, SYSTEM_MERGE, buildMergeUser(parts, meetingDate));
}
