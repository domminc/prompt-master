import { Hono } from "hono";
import { connect } from "./db";
import { ApiError } from "./lib/errors";
import { jobs } from "./routes/jobs";
import { uploads } from "./routes/uploads";
import type { AppEnv } from "./routes/helpers";

// Workflow 클래스는 Worker 의 named export 여야 wrangler 가 찾는다.
export { MeetingPipeline } from "./pipeline";

const app = new Hono<AppEnv>();

// 요청마다 DB 연결을 만들고(Hyperdrive), 응답을 보낸 뒤 닫는다.
app.use("/api/*", async (c, next) => {
  const needsDb = !c.req.path.endsWith("/health");
  if (needsDb) c.set("sql", connect(c.env));
  try {
    await next();
  } finally {
    const sql = c.var.sql;
    if (sql) c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
  }
  // 회의 내용은 민감하다: 미디어 외의 API 응답은 어디에도 캐시하지 않는다.
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/uploads", uploads);
app.route("/api/jobs", jobs);

app.notFound((c) => c.json({ error: "찾을 수 없는 API 입니다" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  console.error("unhandled error", err);
  return c.json({ error: "서버에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, 500);
});

export default app;
