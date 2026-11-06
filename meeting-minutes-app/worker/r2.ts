import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export const audioKey = (jobId: string) => `uploads/${jobId}/audio.mp3`;
/** variant: 같은 형식의 다른 버전(예: 대화록 포함 Word)을 따로 캐시하기 위한 접미사 */
export const exportKey = (jobId: string, ext: string, variant?: string) =>
  `exports/${jobId}/meeting${variant ? `-${variant}` : ""}.${ext}`;

/**
 * 브라우저가 R2 에 직접 올리려면 S3 호환 presigned URL 이 필요하다.
 * R2 바인딩만으로는 서명 URL 을 만들 수 없어서 R2 API 토큰(액세스 키)을 따로 쓴다.
 * 이 값이 없으면(로컬 개발) Worker 가 업로드를 대신 받는다.
 */
export function isPresignConfigured(env: Env): boolean {
  return !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

export async function presignPut(env: Env, key: string, expiresSec: number, now: Date = new Date()): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  // Content-Type 은 서명에 넣지 않는다: 브라우저가 보내는 값을 그대로 허용한다.
  const signed = await aws.sign(new Request(url, { method: "PUT" }), { aws: { signQuery: true, datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, "") } });
  return signed.url;
}

/** 접두사로 시작하는 객체를 모두 지운다 (내보내기 캐시·작업 삭제용) */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
