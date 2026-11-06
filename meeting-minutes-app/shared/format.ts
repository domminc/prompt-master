const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 밀리초 → "HH:MM:SS" */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** 재생 UI 용: 1시간 미만이면 "MM:SS" */
export function formatClock(ms: number): string {
  const t = formatTimestamp(ms);
  return t.startsWith("00:") ? t.slice(3) : t;
}

/** "HH:MM:SS" 또는 "MM:SS" → 밀리초. 형식이 맞지 않으면 null */
export function parseTimestamp(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  return ((h * 60 + min) * 60 + sec) * 1000;
}

/** 밀리초 → "1시간 23분" / "12분" / "45초" */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h}시간 ${rest}분` : `${h}시간`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
