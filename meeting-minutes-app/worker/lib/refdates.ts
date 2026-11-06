import { addDaysYmd, weekdayIndex, weekdayKo } from "../../shared/calendar";

/**
 * "다음 주 화요일" 같은 상대 표현을 LLM 이 요일 계산으로 풀면 자주 틀린다.
 * 그래서 기준일 기준의 달력표를 만들어 프롬프트에 넣고, 모델은 표에서 "찾기"만 하게 한다.
 */
export function buildCalendarContext(meetingDate: string, days = 28): string {
  const mondayOffset = (weekdayIndex(meetingDate) + 6) % 7; // 월요일=0
  const thisMonday = addDaysYmd(meetingDate, -mondayOffset);
  const lines: string[] = [`회의일(기준일): ${meetingDate} (${weekdayKo(meetingDate)}요일)`, "※ 한 주는 월요일~일요일 기준"];

  const weeks: Array<[string, number]> = [
    ["이번 주", 0],
    ["다음 주", 7],
    ["다다음 주", 14],
  ];
  for (const [label, offset] of weeks) {
    const mon = addDaysYmd(thisMonday, offset);
    lines.push(`${label}: ${mon}(월) ~ ${addDaysYmd(mon, 6)}(일)`);
  }

  const [y, m] = meetingDate.split("-").map(Number) as [number, number];
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  lines.push(`이번 달 말일: ${y}-${pad(m)}-${pad(lastDay(y, m))}`);
  lines.push(`다음 달: ${ny}-${pad(nm)}-01 ~ ${ny}-${pad(nm)}-${pad(lastDay(ny, nm))}`);

  lines.push("", `날짜표 (기준일부터 ${days}일):`);
  const rel = ["오늘", "내일", "모레"];
  for (let i = 0; i < days; i++) {
    const d = addDaysYmd(meetingDate, i);
    lines.push(`${d} (${weekdayKo(d)})${rel[i] ? ` ← ${rel[i]}` : ""}`);
  }
  return lines.join("\n");
}

/** 오늘 날짜(한국 시간) YYYY-MM-DD */
export function todayKst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
