/** REST 응답으로 그대로 내려가는 오류. message 는 사용자에게 보여도 되는 한국어 문구여야 한다. */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 재시도해도 소용없는 파이프라인 오류(잘못된 키·설정 오류 등). message 는 사용자에게 보이는 한국어 문구. */
export class PipelineFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineFatalError";
  }
}

/** HTTP 상태코드에 맞는 사용자용 안내 문구 */
export function explainStatus(stage: string, service: string, status: number): string {
  if (status === 401 || status === 403) return `${stage} 실패: ${service} API 키가 올바르지 않거나 권한이 없습니다. 관리자에게 문의해 주세요.`;
  if (status === 429) return `${stage} 실패: ${service} 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.`;
  if (status === 413) return `${stage} 실패: ${service} 가 허용하는 파일 크기를 넘었습니다.`;
  if (status >= 500 || status === 0) return `${stage} 실패: ${service} 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.`;
  return `${stage} 실패: ${service} 가 요청을 받아들이지 않았습니다 (${status}).`;
}

/**
 * jobs.error_message 에 저장할 문구.
 * - Workflow 가 붙이는 "NonRetryableError: " 같은 클래스명 접두사를 제거한다.
 * - 우리가 만든 메시지는 항상 한국어다. 한글이 없으면 예상하지 못한 내부 오류이므로
 *   안내 문구로 감싸고 원문은 [대괄호] 안에 남긴다 (화면에서는 "자세히 보기"로 접힌다).
 */
export function userMessage(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^(?:\w*Error:\s*)+/, "").trim();
  if (!raw) return "알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해 주세요.";
  if (/[가-힣]/.test(raw)) return raw;
  return `예기치 않은 오류가 발생했어요. 잠시 후 다시 시도해 주세요. [${raw.slice(0, 300)}]`;
}
