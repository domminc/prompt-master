import { CalendarDays, CloudUpload, FileAudio, FileVideo, History, Languages, Lock, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { formatBytes, formatDuration } from "../../../shared/format";
import {
  ALLOWED_EXTENSIONS, LANGUAGES, MAX_UPLOAD_BYTES, type LanguageCode,
} from "../../../shared/limits";
import { Stepper } from "../components/Stepper";
import { Button, Card } from "../components/ui";
import { api, ApiClientError, putBlob } from "../lib/api";
import { AudioExtractError, cancelExtraction, extractAudio, probeDurationMs } from "../lib/audio";
import { localYmd, longDate } from "../lib/dates";
import { loadRecent, rememberJob, type RecentJob } from "../lib/recent";

interface Working {
  step: 0 | 1;
  ratio: number | null;
  detail: string;
}

/** 파일 선택 단계에서 서버와 같은 규칙으로 미리 걸러낸다 */
function validateFile(f: File): string | null {
  const ext = /\.[^./\\]+$/.exec(f.name.toLowerCase())?.[0] ?? "";
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `지원하지 않는 형식이에요. ${ALLOWED_EXTENSIONS.join(", ")} 파일을 올려 주세요.`;
  }
  if (f.size > MAX_UPLOAD_BYTES) return `파일이 너무 커요 (${formatBytes(f.size)}). 최대 200MB 까지 올릴 수 있어요.`;
  if (f.size === 0) return "빈 파일이에요. 다른 파일을 선택해 주세요.";
  return null;
}

export function UploadPage({ navigate }: { navigate: (to: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [language, setLanguage] = useState<LanguageCode>("ko");
  const [meetingDate, setMeetingDate] = useState(localYmd(new Date()));
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState<RecentJob[]>([]);
  const audioRef = useRef<{ file: File; blob: Blob } | null>(null); // 업로드만 실패했을 때 변환을 다시 하지 않도록
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => setRecent(loadRecent()), []);

  function pick(f: File | undefined) {
    if (!f) return;
    const problem = validateFile(f);
    setError(problem);
    if (problem) return;
    audioRef.current = null;
    setFile(f);
    setDurationMs(null);
    setMeetingDate(localYmd(new Date(f.lastModified || Date.now()))); // 녹음 파일의 수정일 ≈ 회의일
    void probeDurationMs(f).then(setDurationMs);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  }

  async function start() {
    if (!file) return;
    setError(null);
    abortRef.current = new AbortController();
    try {
      let blob = audioRef.current?.file === file ? audioRef.current.blob : null;
      if (!blob) {
        setWorking({ step: 0, ratio: null, detail: "변환 엔진을 준비하고 있어요…" });
        blob = await extractAudio(file, {
          onEngineProgress: (r) => setWorking({ step: 0, ratio: r, detail: `변환 엔진을 내려받는 중이에요 · 최초 1회 (${Math.round(r * 100)}%)` }),
          onProgress: (r) => setWorking({ step: 0, ratio: r, detail: `내 기기에서 소리만 추출하는 중이에요 (${Math.round(r * 100)}%)` }),
        });
        audioRef.current = { file, blob };
      }

      setWorking({ step: 1, ratio: 0, detail: "업로드를 준비하고 있어요…" });
      const created = await api.createUpload({
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        audioSizeBytes: blob.size,
        language,
        meetingDate,
      });
      rememberJob({ id: created.jobId, title: file.name, fileName: file.name, createdAt: new Date().toISOString() });
      await api.markUploading(created.jobId);

      const send = () =>
        putBlob(
          created.uploadUrl,
          blob,
          (r) => setWorking({ step: 1, ratio: r, detail: `업로드 중이에요 · ${formatBytes(blob.size)} (${Math.round(r * 100)}%)` }),
          abortRef.current?.signal,
        );
      try {
        await send();
      } catch (e) {
        // 일시적인 네트워크 오류는 한 번 더 시도한다 (권한·만료 오류는 다시 해도 같다)
        if (e instanceof ApiClientError && e.status === 0 && !abortRef.current?.signal.aborted) await send();
        else throw e;
      }
      await api.complete(created.jobId, created.fileKey);
      navigate(`/jobs/${created.jobId}`);
    } catch (e) {
      setWorking(null);
      if (e instanceof AudioExtractError && e.kind === "cancelled") return;
      if (abortRef.current?.signal.aborted) return;
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
    }
  }

  function cancel() {
    abortRef.current?.abort();
    cancelExtraction();
    setWorking(null);
  }

  const minutes = durationMs ? durationMs / 60000 : null;
  const eta = minutes ? `대략 ${Math.ceil(minutes / 10) + 1}~${Math.ceil(minutes / 5) + 2}분` : null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8 sm:pt-12">
      <div className="text-center">
        <h1 className="text-[1.65rem] font-extrabold leading-snug tracking-tight text-slate-900 sm:text-4xl">
          녹음 파일 하나로
          <br className="sm:hidden" /> 회의록과 일정까지
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-slate-600">
          회의·강의 녹음(mp4, m4a, mp3, wav)을 올리면 대화록, 요약, 액션 아이템, 그리고 <b className="font-semibold text-slate-800">회의 중 잡힌 일정</b>을 자동으로 정리해 드려요.
        </p>
      </div>

      <Card className="mt-8 p-4 sm:p-6">
        {working ? (
          <div className="py-2">
            <Stepper current={working.step} ratio={working.ratio} detail={working.detail} />
            <p className="mt-4 text-center text-xs text-slate-500">이 화면을 닫지 말아 주세요. 업로드가 끝나면 서버가 알아서 이어서 처리해요.</p>
            <div className="mt-5 flex justify-center">
              <Button variant="ghost" onClick={cancel}>
                <X className="size-4" aria-hidden /> 취소
              </Button>
            </div>
          </div>
        ) : (
          <>
            {!file ? (
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-12 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-indigo-600 ${
                  dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/50"
                }`}
              >
                <CloudUpload className="size-10 text-indigo-600" aria-hidden />
                <span className="text-base font-bold text-slate-900">파일을 끌어다 놓거나 눌러서 선택하세요</span>
                <span className="text-sm text-slate-500">MP4 · M4A · MP3 · WAV, 최대 200MB</span>
                <input
                  type="file"
                  className="sr-only"
                  accept=".mp3,.wav,.m4a,.mp4,audio/*,video/mp4"
                  onChange={(e) => pick(e.target.files?.[0])}
                />
              </label>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-indigo-100 text-indigo-700">
                  {file.name.toLowerCase().endsWith(".mp4") ? <FileVideo className="size-5" aria-hidden /> : <FileAudio className="size-5" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900" title={file.name}>{file.name}</p>
                  <p className="text-xs text-slate-500">
                    {formatBytes(file.size)}
                    {durationMs ? ` · ${formatDuration(durationMs)}` : ""}
                    {eta ? ` · 예상 소요 ${eta}` : ""}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => { setFile(null); audioRef.current = null; }} aria-label="다른 파일 선택">
                  변경
                </Button>
              </div>
            )}

            {error && (
              <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
                {error}
              </p>
            )}

            {file && (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                    <Languages className="size-4 text-slate-400" aria-hidden /> 말하는 언어
                  </span>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as LanguageCode)}
                    className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
                    <CalendarDays className="size-4 text-slate-400" aria-hidden /> 회의 날짜
                  </span>
                  <input
                    type="date"
                    value={meetingDate}
                    max="2100-12-31"
                    onChange={(e) => setMeetingDate(e.target.value)}
                    className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
                  />
                  <span className="mt-1 block text-xs text-slate-500">
                    {meetingDate ? `${longDate(meetingDate)} 기준으로 ` : ""}"다음 주 화요일" 같은 말을 날짜로 바꿔요
                  </span>
                </label>
              </div>
            )}

            <Button variant="primary" block className="mt-5 min-h-12 text-base" disabled={!file || !meetingDate} onClick={() => void start()}>
              회의록 만들기
            </Button>
          </>
        )}
      </Card>

      <p className="mt-4 flex items-start justify-center gap-2 px-2 text-center text-xs leading-relaxed text-slate-500">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>영상은 내 기기에서 소리만 추출해서 올려요. 원본 영상은 서버로 올라가지 않아요. 결과 화면에서 언제든 삭제할 수 있어요.</span>
      </p>

      {recent.length > 0 && !working && (
        <section className="mt-10" aria-labelledby="recent-title">
          <h2 id="recent-title" className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700">
            <History className="size-4" aria-hidden /> 최근 회의록 <span className="text-xs font-normal text-slate-400">이 브라우저에만 저장돼요</span>
          </h2>
          <ul className="grid gap-2">
            {recent.map((r) => (
              <li key={r.id}>
                <a
                  href={`/jobs/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/jobs/${r.id}`);
                  }}
                  className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-indigo-300"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-900">{r.title}</span>
                    <span className="block text-xs text-slate-500">{new Date(r.createdAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}</span>
                  </span>
                  <span className="text-xs font-semibold text-indigo-600">열기</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
