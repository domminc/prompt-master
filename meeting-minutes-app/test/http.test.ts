import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithRetry, UpstreamError } from "../worker/lib/http";

let server: http.Server;
let base = "";
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "";
    hits[path] = (hits[path] ?? 0) + 1;
    const n = hits[path]!;
    if (path === "/ok") return void res.end("ok");
    if (path === "/flaky") {
      if (n < 3) { res.statusCode = 503; return void res.end("busy"); }
      return void res.end("recovered");
    }
    if (path === "/limited") {
      if (n === 1) { res.statusCode = 429; res.setHeader("retry-after", "0"); return void res.end("slow down"); }
      return void res.end("ok after 429");
    }
    if (path === "/unauth") { res.statusCode = 401; return void res.end('{"error":"invalid api key sk-xxxx"}'); }
    if (path === "/down") { res.statusCode = 500; return void res.end("boom"); }
    if (path === "/hang") return; // 응답 없음 → 타임아웃
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const fast = { timeoutMs: 1000, retries: 3, baseDelayMs: 1, label: "테스트 API", sleep: async () => {} };

describe("fetchWithRetry", () => {
  it("성공하면 바로 반환", async () => {
    const res = await fetchWithRetry(`${base}/ok`, {}, fast);
    expect(await res.text()).toBe("ok");
    expect(hits["/ok"]).toBe(1);
  });
  it("5xx 는 재시도해서 복구한다", async () => {
    const res = await fetchWithRetry(`${base}/flaky`, {}, fast);
    expect(await res.text()).toBe("recovered");
    expect(hits["/flaky"]).toBe(3);
  });
  it("429 는 재시도한다", async () => {
    const res = await fetchWithRetry(`${base}/limited`, {}, fast);
    expect(await res.text()).toBe("ok after 429");
  });
  it("401 은 재시도하지 않고 즉시 실패(retryable=false)", async () => {
    const err = (await fetchWithRetry(`${base}/unauth`, {}, fast).catch((e) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("테스트 API 오류 401");
    expect(hits["/unauth"]).toBe(1);
  });
  it("계속 5xx 면 재시도 횟수만큼 시도한 뒤 retryable 오류로 실패", async () => {
    const err = (await fetchWithRetry(`${base}/down`, {}, { ...fast, retries: 2 }).catch((e) => e)) as UpstreamError;
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
    expect(hits["/down"]).toBe(3);
  });
  it("응답이 없으면 타임아웃 후 재시도하고 최종 실패", async () => {
    const err = (await fetchWithRetry(`${base}/hang`, {}, { ...fast, timeoutMs: 50, retries: 1 }).catch((e) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(0);
    expect(err.message).toContain("시간 초과");
    expect(hits["/hang"]).toBe(2);
  });
});
