import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Env } from "../worker/env";
import { isPresignConfigured, presignPut } from "../worker/r2";

const env = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  R2_BUCKET_NAME: "meeting-minutes",
} as Env;
const KEY = "uploads/6f1c2d3e-aaaa-bbbb-cccc-0123456789ab/audio.mp3";
const NOW = new Date("2026-11-06T09:00:00Z");

describe("R2 presigned URL", () => {
  it("R2 키가 하나라도 없으면 presign 을 쓰지 않는다 (로컬 개발 모드)", () => {
    expect(isPresignConfigured(env)).toBe(true);
    expect(isPresignConfigured({ ...env, R2_SECRET_ACCESS_KEY: undefined } as Env)).toBe(false);
    expect(isPresignConfigured({} as Env)).toBe(false);
  });

  it("S3 호환 SigV4 쿼리 서명 형식이다", async () => {
    const url = new URL(await presignPut(env, KEY, 1200, NOW));
    expect(url.origin).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/meeting-minutes/${KEY}`);
    const q = url.searchParams;
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20261106/auto/s3/aws4_request");
    expect(q.get("X-Amz-Date")).toBe("20261106T090000Z");
    expect(q.get("X-Amz-Expires")).toBe("1200");
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain(env.R2_SECRET_ACCESS_KEY);
  });

  // 공식 AWS SDK(botocore)가 같은 입력으로 만든 서명과 비교한다. 선택 실행:
  //   PRESIGN_CROSSCHECK_PYTHON=/path/to/python(boto3, freezegun 설치) npm test
  const py = process.env.PRESIGN_CROSSCHECK_PYTHON;
  it.skipIf(!py)("botocore 가 만든 presigned URL 과 서명이 완전히 같다", async () => {
    const code = `
import boto3, sys
from botocore.config import Config
from freezegun import freeze_time
s3 = boto3.client("s3", endpoint_url="https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
  aws_access_key_id="${env.R2_ACCESS_KEY_ID}", aws_secret_access_key="${env.R2_SECRET_ACCESS_KEY}", region_name="auto",
  config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))
with freeze_time("2026-11-06 09:00:00"):
    print(s3.generate_presigned_url("put_object", Params={"Bucket": "${env.R2_BUCKET_NAME}", "Key": "${KEY}"}, ExpiresIn=1200, HttpMethod="PUT"))
`;
    const ref = new URL(execFileSync(py!, ["-c", code]).toString().trim());
    const ours = new URL(await presignPut(env, KEY, 1200, NOW));
    expect(ours.pathname).toBe(ref.pathname);
    const pick = (u: URL) => Object.fromEntries([...u.searchParams.entries()].sort());
    expect(pick(ours)).toEqual(pick(ref));
  });
});
