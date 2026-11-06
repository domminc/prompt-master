import { formatKoreanDate, weekdayKo } from "../../../shared/calendar";

/** "2026-11-10" → "11월 10일 (화)" */
export function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}월 ${d}일 (${weekdayKo(ymd)})`;
}

/** "2026-11-10" → "2026년 11월 10일 (화)" */
export const longDate = formatKoreanDate;

/** 파일 수정 시각(녹음이 끝난 시각에 가깝다)을 로컬 날짜 YYYY-MM-DD 로 */
export function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
