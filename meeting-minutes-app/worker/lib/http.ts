/** 외부 API(Whisper 등) 호출 실패. retryable=false 면 재시도해도 소용없는 오류(키 오류·잘못된 요청). */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface RetryOptions {
  /** 시도 1회당 제한 시간 */
  timeoutMs: number;
  /** 첫 시도 이후 추가 재시도 횟수 */
  retries: number;
  baseDelayMs?: number;
  /** 오류 메시지에 붙는 이름 (예: "Whisper API") */
  label: string;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function snippet(s: string, n = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.min(sec * 1000, 30_000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - Date.now(), 0), 30_000);
}

/**
 * 타임아웃 + 지수 백오프 재시도가 붙은 fetch.
 * 408/429/5xx 와 네트워크 오류·타임아웃만 재시도하고, 그 외 4xx 는 즉시 실패한다.
 * body 는 재전송 가능해야 한다(문자열·FormData·ArrayBuffer — 스트림 불가).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.baseDelayMs ?? 1000;
  let lastError: UpstreamError | undefined;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    let delay = base * 2 ** attempt;
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      lastError = new UpstreamError(`${opts.label} 연결 실패 또는 시간 초과 (${reason})`, 0, true);
    }

    if (res) {
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      lastError = new UpstreamError(`${opts.label} 오류 ${res.status}: ${snippet(body)}`, res.status, retryable);
      delay = retryAfterMs(res) ?? delay;
    }

    if (!lastError!.retryable || attempt === opts.retries) throw lastError!;
    await sleep(delay);
  }
  throw lastError!; // 도달 불가 (타입 만족용)
}
