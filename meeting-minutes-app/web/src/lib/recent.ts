// 로그인이 없으므로 "내가 만든 회의록" 목록은 이 브라우저(localStorage)에만 기억한다.
// 시크릿 모드·저장소 차단 등으로 쓸 수 없어도 앱은 정상 동작해야 한다.

export interface RecentJob {
  id: string;
  title: string;
  fileName: string | null;
  createdAt: string;
}

const KEY = "meeting-minutes:recent";
const MAX = 12;

export function loadRecent(): RecentJob[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentJob[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

function save(list: RecentJob[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 저장 불가 — 무시 */
  }
}

export function rememberJob(job: RecentJob): void {
  const rest = loadRecent().filter((r) => r.id !== job.id);
  const prev = loadRecent().find((r) => r.id === job.id);
  save([{ ...job, createdAt: prev?.createdAt ?? job.createdAt }, ...rest]);
}

export function forgetJob(id: string): void {
  save(loadRecent().filter((r) => r.id !== id));
}
