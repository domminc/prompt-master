import { Check, Loader2 } from "lucide-react";

export const STEPS = ["오디오 준비", "업로드", "전사", "요약", "완료"] as const;

interface Props {
  /** 지금 진행 중인 단계 (0~4). 4 면 모두 완료 */
  current: number;
  /** 0..1, 없으면 진행률 바를 숨긴다 */
  ratio?: number | null;
  detail?: string;
  failed?: boolean;
}

/** 단계별 진행 표시. 브라우저 단계(오디오 준비·업로드)와 서버 단계(전사·요약)를 한 줄로 보여 준다. */
export function Stepper({ current, ratio, detail, failed }: Props) {
  return (
    <div>
      <ol className="flex items-start" aria-label="진행 단계">
        {STEPS.map((label, i) => {
          const done = i < current;
          const active = i === current && !failed;
          const error = i === current && failed;
          return (
            <li key={label} className="relative flex flex-1 flex-col items-center gap-1.5 text-center" aria-current={active ? "step" : undefined}>
              {i > 0 && (
                <span
                  aria-hidden
                  className={`absolute left-[-50%] top-[15px] -z-0 h-0.5 w-full ${i <= current ? "bg-indigo-600" : "bg-slate-200"}`}
                />
              )}
              <span
                className={`relative z-10 grid size-8 place-items-center rounded-full text-xs font-bold ${
                  done
                    ? "bg-indigo-600 text-white"
                    : active
                      ? "bg-white text-indigo-600 ring-2 ring-indigo-600"
                      : error
                        ? "bg-rose-600 text-white"
                        : "bg-slate-100 text-slate-400"
                }`}
              >
                {done ? <Check className="size-4" aria-hidden /> : active ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : error ? "!" : i + 1}
              </span>
              <span className={`text-[11px] font-semibold sm:text-xs ${done || active ? "text-slate-900" : error ? "text-rose-700" : "text-slate-400"}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {(ratio !== null && ratio !== undefined) && (
        <div
          className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <div className="h-full rounded-full bg-indigo-600 transition-[width] duration-500" style={{ width: `${Math.max(2, ratio * 100)}%` }} />
        </div>
      )}
      {detail && <p className="mt-3 text-center text-sm text-slate-600" aria-live="polite">{detail}</p>}
    </div>
  );
}
