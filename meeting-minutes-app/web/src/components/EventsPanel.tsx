import { CalendarPlus, CalendarX2, Clock, Download, MapPin, Play, Users } from "lucide-react";
import { eventTimeLabel, eventTiming, googleCalendarUrl, weekdayKo } from "../../../shared/calendar";
import { formatClock } from "../../../shared/format";
import { buildIcs } from "../../../shared/ics";
import { CONFIDENCE_LABEL, EVENT_KIND_LABEL } from "../../../shared/labels";
import type { MeetingEvent } from "../../../shared/summary-schema";
import { Badge, Button, Card, SectionTitle } from "./ui";

interface Props {
  events: MeetingEvent[];
  jobId: string;
  meetingTitle: string;
  onSeek: (ms: number) => void;
}

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EventsPanel({ events, jobId, meetingTitle, onSeek }: Props) {
  const dated = events.filter((e) => eventTiming(e));

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle
        icon={<CalendarPlus className="size-5" aria-hidden />}
        aside={
          dated.length > 0 ? (
            <a
              href={`/api/jobs/${jobId}/export?format=ics`}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Download className="size-3.5" aria-hidden /> 전체 .ics
            </a>
          ) : undefined
        }
      >
        일정 <span className="text-sm font-semibold text-slate-400">{events.length}건</span>
      </SectionTitle>

      {events.length === 0 ? (
        <div className="rounded-xl bg-slate-50 px-4 py-8 text-center">
          <CalendarX2 className="mx-auto size-8 text-slate-300" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-slate-700">대화에서 확인된 일정이 없어요</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
            "다음 주 화요일 오후 3시에 다시 만나요" 같은 약속이 녹음에 나오면 여기에 날짜와 함께 정리돼요.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {events.map((ev, i) => {
            const gcal = googleCalendarUrl(ev, { details: `출처 회의: ${meetingTitle}` });
            const time = eventTimeLabel(ev);
            return (
              <li key={`${ev.title}-${ev.date}-${i}`} className="rounded-xl border border-slate-200 p-3 sm:p-4">
                <div className="flex gap-3">
                  {ev.date ? (
                    <div className="w-14 shrink-0 self-start rounded-lg bg-indigo-50 py-2 text-center text-indigo-700" aria-label={`${ev.date} ${weekdayKo(ev.date)}요일`}>
                      <div className="text-[11px] font-semibold leading-none">{Number(ev.date.slice(5, 7))}월</div>
                      <div className="mt-0.5 text-xl font-extrabold leading-none">{Number(ev.date.slice(8, 10))}</div>
                      <div className="mt-0.5 text-[11px] font-semibold leading-none">{weekdayKo(ev.date)}</div>
                    </div>
                  ) : (
                    <div className="grid w-14 shrink-0 self-start place-items-center rounded-lg border border-dashed border-slate-300 px-1 py-2 text-center text-[11px] font-semibold leading-tight text-slate-400">
                      날짜<br />미정
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-[15px] font-bold leading-snug text-slate-900">{ev.title}</h3>
                      <Badge tone="slate">{EVENT_KIND_LABEL[ev.kind]}</Badge>
                      {ev.confidence === "low" && (
                        <Badge tone="amber" title="날짜나 시간이 불확실해요. 캘린더에 넣기 전에 확인해 주세요.">{CONFIDENCE_LABEL.low}</Badge>
                      )}
                      {ev.confidence === "medium" && (
                        <Badge tone="indigo" title="'다음 주 화요일' 같은 표현을 회의일 기준으로 계산했어요.">{CONFIDENCE_LABEL.medium}</Badge>
                      )}
                    </div>
                    <dl className="mt-1.5 grid gap-1 text-sm text-slate-600">
                      {time && (
                        <div className="flex items-center gap-1.5">
                          <Clock className="size-3.5 shrink-0 text-slate-400" aria-hidden />
                          <dt className="sr-only">시간</dt>
                          <dd>{time}</dd>
                        </div>
                      )}
                      {ev.location && (
                        <div className="flex items-start gap-1.5">
                          <MapPin className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden />
                          <dt className="sr-only">장소</dt>
                          <dd>{ev.location}</dd>
                        </div>
                      )}
                      {ev.attendees.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <Users className="mt-0.5 size-3.5 shrink-0 text-slate-400" aria-hidden />
                          <dt className="sr-only">참석자</dt>
                          <dd>{ev.attendees.join(", ")}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="mt-2 text-xs text-slate-500">
                      회의에서는 <q className="not-italic text-slate-700">{ev.dateText || "(표현 없음)"}</q> 라고 말했어요
                      {ev.evidenceMs !== null && (
                        <button
                          type="button"
                          onClick={() => onSeek(ev.evidenceMs!)}
                          className="ml-1.5 inline-flex min-h-7 items-center gap-1 rounded-md bg-slate-100 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-200"
                          aria-label={`${formatClock(ev.evidenceMs)} 지점부터 듣기`}
                        >
                          <Play className="size-3 fill-current" aria-hidden /> {formatClock(ev.evidenceMs)}
                        </button>
                      )}
                    </p>
                    {gcal ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <a
                          href={gcal}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-700"
                        >
                          <CalendarPlus className="size-4" aria-hidden /> Google 캘린더에 추가
                        </a>
                        <Button
                          className="min-h-10 px-3 text-xs"
                          onClick={() =>
                            downloadText(
                              `${ev.title.replace(/[\\/:*?"<>|]/g, " ").trim() || "일정"}.ics`,
                              buildIcs([ev], { calendarName: ev.title, uidPrefix: `${jobId}-${i}`, meetingTitle }),
                              "text/calendar;charset=utf-8",
                            )
                          }
                        >
                          <Download className="size-4" aria-hidden /> .ics (애플·아웃룩)
                        </Button>
                      </div>
                    ) : (
                      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        날짜를 특정하지 못해 캘린더에 바로 넣을 수 없어요. 날짜가 정해지면 직접 추가해 주세요.
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
