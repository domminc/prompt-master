import {
  CalendarDays, Check, CheckCircle2, ChevronDown, CircleHelp, Clock, Copy, Download, FileAudio,
  FileText, ListChecks, Play, Sparkles, Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock, formatDuration, formatTimestamp } from "../../../shared/format";
import { PRIORITY_LABEL } from "../../../shared/labels";
import type { JobDto, Segment } from "../../../shared/types";
import { api } from "../lib/api";
import { forgetJob } from "../lib/recent";
import { longDate, shortDate } from "../lib/dates";
import { EventsPanel } from "./EventsPanel";
import { Badge, Button, Card, SectionTitle } from "./ui";

type Tab = "summary" | "events" | "transcript";

interface ExportItem { label: string; hint: string; href: (id: string) => string }

// Word 문서를 맨 위에: 회의록을 문서로 쓰는 경우가 가장 많다
const WORD_EXPORTS: ExportItem[] = [
  { label: "회의록 (Word)", hint: ".docx · 요약·일정·액션", href: (id) => api.exportUrl(id, "docx") },
  { label: "회의록 + 대화록 (Word)", hint: ".docx · 대화록 부록", href: (id) => api.exportUrl(id, "docx", { transcript: true }) },
];
const OTHER_EXPORTS: ExportItem[] = [
  { label: "회의록", hint: "Markdown (.md)", href: (id) => api.exportUrl(id, "md") },
  { label: "자막", hint: "SRT (.srt)", href: (id) => api.exportUrl(id, "srt") },
  { label: "대화록", hint: "텍스트 (.txt)", href: (id) => api.exportUrl(id, "txt") },
  { label: "일정", hint: "캘린더 (.ics)", href: (id) => api.exportUrl(id, "ics") },
  { label: "전체 데이터", hint: "JSON (.json)", href: (id) => api.exportUrl(id, "json") },
];

/** 현재 재생 위치(ms)에 해당하는 세그먼트 인덱스 (이분 탐색) */
function activeIndexAt(segs: Segment[], ms: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function ResultView({ job, navigate }: { job: JobDto; navigate: (to: string) => void }) {
  const summary = job.summary!;
  const [tab, setTab] = useState<Tab>("summary");
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);

  // 재생을 시작하기 전에는 아무 문장도 강조하지 않는다
  const active = useMemo(() => (playing || currentMs > 0 ? activeIndexAt(job.segments, currentMs) : -1), [job.segments, currentMs, playing]);

  const seek = useCallback((ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => undefined); // 자동 재생이 막혀도 위치는 이동한다
  }, []);

  // 재생을 따라 대화록을 자동으로 스크롤한다 (필요할 때만 최소한으로)
  useEffect(() => {
    if (!follow || !playing || tab !== "transcript" && window.innerWidth < 1024) return;
    rowRefs.current[active]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active, follow, playing, tab]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const show = (t: Tab) => (tab === t ? "block" : "hidden") + " lg:block";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-32 pt-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.4rem] font-extrabold leading-snug tracking-tight text-slate-900 sm:text-3xl">{summary.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{longDate(job.meetingDate)}</span>
            {job.durationMs ? <span className="inline-flex items-center gap-1.5"><Clock className="size-4" aria-hidden />{formatDuration(job.durationMs)}</span> : null}
            {job.fileName && <span className="inline-flex min-w-0 items-center gap-1.5"><FileAudio className="size-4 shrink-0" aria-hidden /><span className="truncate">{job.fileName}</span></span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <a
            href={api.exportUrl(job.id, "docx")}
            download
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
          >
            <FileText className="size-4" aria-hidden /> Word로 저장
          </a>
          <ExportMenu jobId={job.id} />
          <Button
            variant="ghost"
            className="text-slate-500 hover:text-rose-700"
            aria-label="이 회의록 삭제"
            onClick={async () => {
              if (!window.confirm("녹음, 대화록, 요약을 모두 삭제할까요? 되돌릴 수 없어요.")) return;
              await api.remove(job.id).catch(() => undefined);
              forgetJob(job.id);
              navigate("/");
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">삭제</span>
          </Button>
        </div>
      </header>

      {/* 모바일: 탭으로 나눠 보기 / 데스크톱: 두 칼럼으로 한눈에 */}
      <div role="tablist" aria-label="결과 보기" className="sticky top-0 z-20 -mx-4 mt-5 flex gap-1 border-b border-slate-200 bg-slate-50/95 px-4 backdrop-blur lg:hidden">
        {([
          ["summary", "요약"],
          ["events", `일정 ${summary.events.length}`],
          ["transcript", "대화록"],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-12 flex-1 border-b-2 text-sm font-bold ${tab === key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start lg:gap-6">
        {/* 왼쪽: 플레이어 + 대화록 */}
        <div className={`${show("transcript")} lg:sticky lg:top-4`}>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4">
              <h2 className="text-base font-bold text-slate-900">대화록 <span className="text-sm font-semibold text-slate-400">{job.segments.length}문장</span></h2>
              <label className="flex min-h-9 cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="size-4 accent-indigo-600" />
                재생 따라가기
              </label>
            </div>
            <ol className="max-h-[70vh] overflow-y-auto px-2 pb-3 lg:max-h-[calc(100vh-14rem)]">
              {job.segments.map((s, i) => (
                <li key={`${s.startMs}-${i}`} ref={(el) => { rowRefs.current[i] = el; }}>
                  <button
                    type="button"
                    onClick={() => seek(s.startMs)}
                    aria-current={i === active ? "true" : undefined}
                    className={`flex min-h-11 w-full gap-3 rounded-lg px-2 py-2 text-left text-[15px] leading-relaxed hover:bg-slate-50 ${i === active ? "bg-indigo-50" : ""}`}
                  >
                    <span className={`mt-0.5 shrink-0 font-mono text-xs tabular-nums ${i === active ? "font-bold text-indigo-700" : "text-slate-400"}`}>
                      {formatTimestamp(s.startMs)}
                    </span>
                    <span className={i === active ? "font-medium text-slate-900" : "text-slate-700"}>{s.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        {/* 오른쪽: 요약 · 일정 · 결정 · 액션 · 질문 */}
        <div className="grid gap-5">
          <div className={show("summary")}>
            <Card className="border-indigo-100 bg-indigo-50/60 p-4 sm:p-5">
              <SectionTitle icon={<Sparkles className="size-5" aria-hidden />}>한눈에 보기</SectionTitle>
              <p className="text-[15px] leading-relaxed text-slate-800">{summary.tldr}</p>
            </Card>
          </div>

          <div className={show("events")}>
            <EventsPanel events={summary.events} jobId={job.id} meetingTitle={summary.title} onSeek={seek} />
          </div>

          <div className={show("summary")}>
            <Card className="p-4 sm:p-5">
              <SectionTitle icon={<CheckCircle2 className="size-5" aria-hidden />}>핵심 결정사항</SectionTitle>
              {summary.decisions.length ? (
                <ul className="grid gap-2">
                  {summary.decisions.map((d, i) => (
                    <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-slate-800">
                      <Check className="mt-1 size-4 shrink-0 text-emerald-600" aria-hidden /> {d}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">확정된 결정사항이 없어요.</p>
              )}
            </Card>
          </div>

          <div className={show("summary")}>
            <Card className="p-4 sm:p-5">
              <SectionTitle icon={<ListChecks className="size-5" aria-hidden />}>액션 아이템 <span className="text-sm font-semibold text-slate-400">{summary.actionItems.length}건</span></SectionTitle>
              {summary.actionItems.length ? (
                <ul className="grid gap-2.5">
                  {summary.actionItems.map((a, i) => (
                    <li key={i} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={a.priority === "high" ? "rose" : a.priority === "medium" ? "amber" : "slate"}>{PRIORITY_LABEL[a.priority]}</Badge>
                        <span className="text-[15px] font-semibold text-slate-900">{a.task}</span>
                      </div>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
                        <span>담당 <b className="font-semibold text-slate-800">{a.owner}</b></span>
                        <span>기한 <b className="font-semibold text-slate-800">{/^\d{4}-/.test(a.dueDate) ? shortDate(a.dueDate) : a.dueDate}</b></span>
                        {a.evidenceMs !== null && (
                          <button type="button" onClick={() => seek(a.evidenceMs!)} className="inline-flex min-h-7 items-center gap-1 rounded-md bg-slate-100 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-200">
                            <Play className="size-3 fill-current" aria-hidden /> {formatClock(a.evidenceMs)}
                          </button>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">확인된 액션 아이템이 없어요.</p>
              )}
            </Card>
          </div>

          {summary.openQuestions.length > 0 && (
            <div className={show("summary")}>
              <Card className="p-4 sm:p-5">
                <SectionTitle icon={<CircleHelp className="size-5" aria-hidden />}>미해결 질문</SectionTitle>
                <ul className="grid gap-2">
                  {summary.openQuestions.map((q, i) => (
                    <li key={i} className="text-[15px] leading-relaxed text-slate-800">• {q}</li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </div>
      </div>

      {/* 하단 고정 플레이어: <audio> 는 이 한 곳에만 있다. 어떤 탭에서도, 어떤 화면 크기에서도 계속 들을 수 있다. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-6xl px-3 sm:px-4">
          <PlayerControls audioRef={audioRef} src={api.mediaUrl(job.id)} rate={rate} setRate={setRate} onTime={setCurrentMs} onPlaying={setPlaying} />
        </div>
      </div>
    </div>
  );
}

// ── 플레이어 ─────────────────────────────────────────────────────
function PlayerControls(props: {
  audioRef: React.RefObject<HTMLAudioElement>;
  src: string;
  rate: number;
  setRate: (r: number) => void;
  onTime: (ms: number) => void;
  onPlaying: (p: boolean) => void;
}) {
  const { audioRef, src, rate, setRate, onTime, onPlaying } = props;
  return (
    <div className="flex items-center gap-3">
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src}
        className="h-11 min-w-0 flex-1"
        onTimeUpdate={(e) => onTime(e.currentTarget.currentTime * 1000)}
        onSeeked={(e) => onTime(e.currentTarget.currentTime * 1000)}
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
        onEnded={() => onPlaying(false)}
      />
      <button
        type="button"
        onClick={() => setRate(rate >= 2 ? 1 : rate >= 1.5 ? 2 : 1.5)}
        className="min-h-11 min-w-14 shrink-0 rounded-xl border border-slate-300 bg-white px-2 text-sm font-bold tabular-nums text-slate-700 hover:bg-slate-50"
        aria-label={`재생 속도 ${rate}배, 눌러서 바꾸기`}
      >
        {rate}x
      </button>
    </div>
  );
}

function MenuLink({ item, jobId, onPick, accent }: { item: ExportItem; jobId: string; onPick: () => void; accent?: boolean }) {
  return (
    <a
      role="menuitem"
      href={item.href(jobId)}
      download
      onClick={onPick}
      className={`flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-sm hover:bg-slate-50 ${accent ? "bg-indigo-50/60" : ""}`}
    >
      <span className="font-semibold text-slate-900">{item.label}</span>
      <span className="text-xs text-slate-500">{item.hint}</span>
    </a>
  );
}

// ── 내려받기 메뉴 ──────────────────────────────────────────────────
function ExportMenu({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Download className="size-4" aria-hidden /> 내려받기 <ChevronDown className="size-4" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {WORD_EXPORTS.map((x) => (
            <MenuLink key={x.label} item={x} jobId={jobId} onPick={() => setOpen(false)} accent />
          ))}
          <div className="my-1 border-t border-slate-100" role="separator" />
          {OTHER_EXPORTS.map((x) => (
            <MenuLink key={x.label} item={x} jobId={jobId} onPick={() => setOpen(false)} />
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(await api.exportText(jobId, "md"));
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {
                window.alert("복사하지 못했어요. 내려받기로 저장해 주세요.");
              }
            }}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border-t border-slate-100 px-3 text-left text-sm hover:bg-slate-50"
          >
            <span className="font-semibold text-slate-900">회의록 복사</span>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              {copied ? <><Check className="size-3.5 text-emerald-600" aria-hidden /> 복사됨</> : <><Copy className="size-3.5" aria-hidden /> 슬랙·노션용</>}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
