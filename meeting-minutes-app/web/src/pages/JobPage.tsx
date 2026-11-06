import { AlertTriangle, RotateCcw, UploadCloud, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { JobDto } from "../../../shared/types";
import { ResultView } from "../components/ResultView";
import { Stepper } from "../components/Stepper";
import { Button, Card } from "../components/ui";
import { api, ApiClientError } from "../lib/api";
import { rememberJob } from "../lib/recent";

const POLL_MS = 2500;

export function JobPage({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [job, setJob] = useState<JobDto | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [restart, setRestart] = useState(0); // 값이 바뀌면 폴링을 다시 시작한다
  const [retrying, setRetrying] = useState(false);

  // 처리 중에는 주기적으로 상태를 가져온다. 끝나면(완료·실패) 멈춘다.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = await api.getJob(id);
        if (stopped) return;
        setJob(j);
        setOffline(false);
        setFatal(null);
        if (j.status !== "completed" && j.status !== "failed") timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiClientError && e.status === 404) {
          setFatal("이 회의록을 찾을 수 없어요. 삭제되었거나 주소가 잘못됐을 수 있어요.");
          return;
        }
        setOffline(true); // 일시적인 네트워크 문제: 조용히 다시 시도
        timer = setTimeout(tick, POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, restart]);

  useEffect(() => {
    if (job?.status === "completed" && job.summary) {
      rememberJob({ id: job.id, title: job.summary.title, fileName: job.fileName, createdAt: job.createdAt });
      document.title = `${job.summary.title} · 회의록 AI`;
    }
    return () => {
      document.title = "회의록 AI";
    };
  }, [job]);

  async function retry() {
    setRetrying(true);
    try {
      setJob(await api.retry(id));
      setRestart((n) => n + 1);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "다시 시도하지 못했어요.");
    } finally {
      setRetrying(false);
    }
  }

  if (fatal) {
    return (
      <Shell>
        <Card className="p-8 text-center">
          <p className="text-base font-semibold text-slate-900">{fatal}</p>
          <Button variant="primary" className="mt-5" onClick={() => navigate("/")}>처음으로</Button>
        </Card>
      </Shell>
    );
  }

  if (!job) {
    return (
      <Shell>
        <Card className="p-10 text-center text-sm text-slate-500" >
          <p aria-live="polite">{offline ? "연결이 불안정해요. 다시 연결하는 중…" : "불러오는 중…"}</p>
        </Card>
      </Shell>
    );
  }

  if (job.status === "completed" && job.summary) {
    return <ResultView job={job} navigate={navigate} />;
  }

  if (job.status === "failed") {
    const canRetry = job.durationMs !== null; // 업로드까지 끝난 작업만 서버에서 이어서 다시 할 수 있다
    return (
      <Shell>
        <Card className="p-6 sm:p-8">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
              <AlertTriangle className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-slate-900">처리하지 못했어요</h1>
              <FailureMessage message={job.errorMessage} />
              {canRetry && <p className="mt-3 text-sm text-slate-600">이미 끝난 전사는 다시 하지 않고 실패한 단계부터 이어서 처리해요.</p>}
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {canRetry && (
              <Button variant="primary" loading={retrying} onClick={() => void retry()}>
                <RotateCcw className="size-4" aria-hidden /> 다시 시도
              </Button>
            )}
            <Button variant={canRetry ? "secondary" : "primary"} onClick={() => navigate("/")}>
              <UploadCloud className="size-4" aria-hidden /> 새 파일 올리기
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  // 업로드가 끝나지 않은 작업 (이 화면에는 업로드가 끝난 뒤에만 오므로, 새로고침·이탈로 끊긴 경우다)
  if (job.status === "queued" || job.status === "uploading") {
    return (
      <Shell>
        <Card className="p-6 text-center sm:p-8">
          <h1 className="text-lg font-bold text-slate-900">업로드가 끝나지 않았어요</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-600">
            업로드 도중에 화면을 닫거나 새로고침하면 이어서 올릴 수 없어요. 파일을 처음부터 다시 올려 주세요.
          </p>
          <Button variant="primary" className="mt-5" onClick={() => navigate("/")}>
            <UploadCloud className="size-4" aria-hidden /> 새 파일 올리기
          </Button>
        </Card>
      </Shell>
    );
  }

  // 전사 / 요약 진행 중
  const { done, total } = job.progress;
  const transcribing = job.status === "transcribing";
  return (
    <Shell>
      <Card className="p-6 sm:p-8">
        <h1 className="mb-6 text-center text-lg font-bold text-slate-900">
          {transcribing ? "녹음을 글로 옮기고 있어요" : "회의 내용을 정리하고 있어요"}
        </h1>
        <Stepper
          current={transcribing ? 2 : 3}
          ratio={transcribing && total > 0 ? done / total : null}
          detail={
            transcribing
              ? total > 1
                ? `전사 중 · ${total}개 구간 중 ${done}개 완료`
                : "전사 중이에요"
              : "요약, 결정사항, 액션 아이템, 일정을 뽑는 중이에요"
          }
        />
        {offline && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-amber-700">
            <WifiOff className="size-3.5" aria-hidden /> 연결이 불안정해요. 다시 연결하는 중…
          </p>
        )}
        <p className="mx-auto mt-6 max-w-sm rounded-lg bg-slate-50 px-4 py-3 text-center text-xs leading-relaxed text-slate-500">
          이 화면을 닫아도 처리는 계속돼요. 나중에 이 주소로 다시 들어오거나 첫 화면의 '최근 회의록'에서 결과를 볼 수 있어요.
        </p>
      </Card>
    </Shell>
  );
}

/** "친절한 설명 [기술 정보]" 형식의 메시지에서 기술 정보는 접어 둔다 (관리자에게 전달할 때 필요) */
function FailureMessage({ message }: { message: string | null }) {
  const raw = message ?? "알 수 없는 오류가 발생했어요.";
  const m = /^([\s\S]*?)\s*\[([\s\S]+)\]\s*$/.exec(raw);
  const friendly = m ? m[1]! : raw;
  const detail = m ? m[2]! : null;
  return (
    <div className="mt-2">
      <p role="alert" className="break-words rounded-lg bg-rose-50 px-3 py-2.5 text-sm leading-relaxed text-rose-900">
        {friendly}
      </p>
      {detail && (
        <details className="mt-2 text-xs text-slate-500">
          <summary className="min-h-8 cursor-pointer select-none py-1.5 font-semibold">기술 정보 (관리자 문의 시 전달)</summary>
          <code className="mt-1 block break-all rounded-md bg-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-700">{detail}</code>
        </details>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-xl px-4 pb-16 pt-10">{children}</div>;
}
