// schema.sql 을 DB 에 적용한다.  사용법: DATABASE_URL=postgres://... npm run db:migrate
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL 환경변수가 필요합니다. (Neon 의 '직접 연결' 문자열)");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_name in ('jobs','transcript_segments')`;
  console.log(`스키마 적용 완료 (테이블 ${n}/2 확인)`);
} finally {
  await sql.end();
}
