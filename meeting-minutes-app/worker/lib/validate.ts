import { z } from "zod";
import { isValidYmd } from "../../shared/calendar";
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  LANGUAGES,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BYTES,
} from "../../shared/limits";
import type { CreateUploadRequest } from "../../shared/types";
import { ApiError } from "./errors";

const langCodes = LANGUAGES.map((l) => l.code) as [string, ...string[]];
const mimeSet = new Set<string>(ALLOWED_MIME_TYPES);

const schema = z.object({
  fileName: z.string().min(1, "파일 이름이 없습니다").max(255, "파일 이름이 너무 깁니다"),
  mimeType: z.string().max(100).default(""),
  sizeBytes: z.number().int().positive("파일이 비어 있습니다"),
  audioSizeBytes: z.number().int().positive("변환된 오디오가 비어 있습니다"),
  language: z.enum(langCodes).default("ko"),
  meetingDate: z.string().optional(),
});

/** POST /api/uploads 요청 검증. 실패하면 한국어 메시지의 400 을 던진다. */
export function parseCreateUpload(body: unknown): CreateUploadRequest {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다");
  }
  const v = parsed.data;

  const ext = /\.[^./\\]+$/.exec(v.fileName.toLowerCase())?.[0] ?? "";
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ApiError(400, `지원하지 않는 파일 형식입니다. ${ALLOWED_EXTENSIONS.join(", ")} 파일만 올릴 수 있어요`);
  }
  // 브라우저가 MIME 을 모르면 빈 문자열을 보낸다 — 그땐 확장자만 믿는다.
  if (v.mimeType && !mimeSet.has(v.mimeType.toLowerCase())) {
    throw new ApiError(400, `지원하지 않는 파일 형식입니다 (${v.mimeType})`);
  }
  if (v.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new ApiError(400, `파일이 너무 큽니다. 최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 까지 올릴 수 있어요`);
  }
  if (v.audioSizeBytes > MAX_AUDIO_BYTES) {
    throw new ApiError(400, "녹음이 너무 깁니다. 약 8시간 이하로 나눠서 올려 주세요");
  }
  if (v.meetingDate !== undefined && !isValidYmd(v.meetingDate)) {
    throw new ApiError(400, "회의 날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)");
  }
  return v as CreateUploadRequest;
}
