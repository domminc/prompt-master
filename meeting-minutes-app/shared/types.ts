import type { LanguageCode } from "./limits";
import type { MeetingSummary } from "./summary-schema";

export type JobStatus =
  | "queued"
  | "uploading"
  | "transcribing"
  | "summarizing"
  | "completed"
  | "failed";

export interface Segment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface JobDto {
  id: string;
  status: JobStatus;
  fileName: string | null;
  language: string;
  /** 일정 날짜 해석의 기준일 (YYYY-MM-DD) */
  meetingDate: string;
  durationMs: number | null;
  progress: { done: number; total: number };
  errorMessage: string | null;
  /** completed 일 때만 채워진다 (폴링 응답을 가볍게 하기 위해) */
  segments: Segment[];
  summary: MeetingSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUploadRequest {
  fileName: string;
  mimeType: string;
  /** 원본 파일 크기 */
  sizeBytes: number;
  /** 브라우저가 추출한 오디오의 크기 */
  audioSizeBytes: number;
  language: LanguageCode;
  /** YYYY-MM-DD, 생략하면 오늘(KST) */
  meetingDate?: string;
}

export interface CreateUploadResponse {
  jobId: string;
  uploadUrl: string;
  fileKey: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  error: string;
}

export const EXPORT_FORMATS = ["docx", "srt", "txt", "md", "json", "ics"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
