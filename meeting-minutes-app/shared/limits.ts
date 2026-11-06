// 프론트엔드와 Worker 가 함께 쓰는 제한값. 한 곳에서만 고친다.

/** 업로드 원본(영상/음성) 최대 크기: 200MB */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 브라우저가 추출해서 올리는 오디오(모노 16kHz 32kbps MP3)의 최대 크기.
 * 이 프로파일은 1시간 ≈ 14.4MB 이므로 120MB 는 약 8시간 분량이다.
 */
export const MAX_AUDIO_BYTES = 120 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4"] as const;

/**
 * MIME 은 브라우저·OS 마다 제각각이라(예: 안드로이드의 m4a 는 audio/mp4a-latm, audio/mp4, audio/x-m4a,
 * 못 알아내면 빈 문자열 또는 application/octet-stream) 허용 목록으로 막으면 정상 녹음이 거부된다.
 * 판단 기준은 확장자이고, 실제로 오디오인지는 브라우저 변환과 서버의 MP3 검증이 확인한다.
 * MIME 은 audio/*, video/*, 또는 "모름" 표시일 때만 통과시킨다.
 */
export function isPlausibleMediaMime(mime: string): boolean {
  const m = mime.trim().toLowerCase();
  return m === "" || m.startsWith("audio/") || m.startsWith("video/") || m === "application/octet-stream" || m === "application/mp4";
}

export const LANGUAGES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** 일정 날짜 해석 기준 시간대. MVP 는 한국 표준시(DST 없음)만 지원한다. */
export const TIMEZONE = "Asia/Seoul";

/** 이 시간 동안 갱신이 없는 진행 중 작업은 중단된 것으로 본다. */
export const STALE_AFTER_MS = 20 * 60 * 1000;

/** 브라우저 오디오 추출 프로파일 (Whisper 는 내부적으로 16kHz 로 리샘플링한다) */
export const AUDIO_PROFILE = { sampleRate: 16000, channels: 1, bitrate: "32k" } as const;
