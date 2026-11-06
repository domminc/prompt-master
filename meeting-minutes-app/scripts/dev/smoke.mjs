// 로컬 백엔드 스모크 테스트: 업로드 → 전사(조각) → 요약(map-reduce) → 내보내기 → 실패/재시도/삭제까지 실제로 돌려 본다.
// 사전 준비(각각 다른 터미널):
//   1) 로컬 Postgres + schema 적용   2) node scripts/dev/mock-ai.mjs   3) npx wrangler dev   (.dev.vars 는 mock 을 가리키게)
//   node scripts/dev/smoke.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const API = process.env.API ?? "http://127.0.0.1:8787";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9100";
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? `  → ${detail}` : ""}`);
}
const j = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const mock = (c) => fetch(MOCK + "/__control", { method: "POST", body: JSON.stringify(c) });

// 앱이 브라우저에서 만드는 것과 같은 프로파일의 오디오 (130초 → 60초 조각 3개: 60 + 60 + 10)
const dir = mkdtempSync(path.join(tmpdir(), "smoke-"));
const audioPath = path.join(dir, "audio.mp3");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=130", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1", audioPath]);
const audio = readFileSync(audioPath);

async function uploadJob(fileName = "주간회의.mp4") {
  const c = await j("POST", "/api/uploads", { fileName, mimeType: "video/mp4", sizeBytes: 50_000_000, audioSizeBytes: audio.length, language: "ko", meetingDate: "2026-11-06" });
  if (c.status !== 201) throw new Error("uploads 실패: " + JSON.stringify(c));
  const { jobId, uploadUrl } = c.data;
  await j("POST", `/api/uploads/${jobId}/start`);
  const put = await fetch(API + uploadUrl, { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: audio });
  return { jobId, uploadUrl, put, created: c };
}
async function waitDone(jobId, timeoutMs = 150_000) {
  const t0 = Date.now(); const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    const { data } = await j("GET", `/api/jobs/${jobId}`);
    if (seen.at(-1) !== data.status) seen.push(data.status);
    if (data.status === "completed" || data.status === "failed") return { job: data, seen, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("시간 초과");
}

console.log("\n[1] 입력 검증");
{
  const bad = (b) => j("POST", "/api/uploads", { mimeType: "video/mp4", sizeBytes: 1000, audioSizeBytes: 500, language: "ko", fileName: "a.mp4", ...b });
  check("허용되지 않은 확장자(.exe) → 400", (await bad({ fileName: "a.exe" })).status === 400);
  check("200MB 초과 → 400", (await bad({ sizeBytes: 200 * 1024 * 1024 + 1 })).status === 400);
  check("잘못된 JSON → 400", (await fetch(API + "/api/uploads", { method: "POST", body: "not json" })).status === 400);
  check("UUID 가 아닌 id → 404", (await j("GET", "/api/jobs/abc")).status === 404);
  check("없는 작업 → 404", (await j("GET", "/api/jobs/00000000-0000-4000-8000-000000000000")).status === 404);
  const c = await j("POST", "/api/uploads", { fileName: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 1000, audioSizeBytes: 500, language: "ko" });
  const early = await j("POST", `/api/uploads/${c.data.jobId}/complete`, {});
  check("업로드 없이 complete → 409", early.status === 409, JSON.stringify(early.data));
  const junk = await fetch(API + c.data.uploadUrl, { method: "PUT", body: new Uint8Array(5000).fill(7) });
  const junkDone = await j("POST", `/api/uploads/${c.data.jobId}/complete`, {});
  check("MP3 가 아닌 파일 complete → 422 + 작업 failed", junkDone.status === 422 && (await j("GET", `/api/jobs/${c.data.jobId}`)).data.status === "failed", `${junk.status} ${JSON.stringify(junkDone.data)}`);
}

console.log("\n[2] 정상 흐름: 업로드 → 전사 3조각 → 요약(map-reduce) → 완료");
await mock({ reset: true });
await mock({ anthropic: { delayMs: 1500 } }); // 요약 단계가 눈에 보이도록 느리게
const main = await uploadJob();
check("presigned 미설정이므로 업로드 URL 은 Worker 경로(개발 모드)", main.uploadUrl.startsWith("/api/uploads/"));
check("PUT 업로드 성공", main.put.status === 200);
const afterStart = await j("GET", `/api/jobs/${main.jobId}`);
check("업로드 중 상태는 uploading", afterStart.data.status === "uploading", afterStart.data.status);
const done1 = await j("POST", `/api/uploads/${main.jobId}/complete`, { fileKey: `uploads/${main.jobId}/audio.mp3` });
check("complete → transcribing, 길이·조각 수 계산", done1.status === 200 && done1.data.status === "transcribing" && Math.abs(done1.data.durationMs - 130_000) < 300 && done1.data.progress.total === 3, JSON.stringify(done1.data));
const done1b = await j("POST", `/api/uploads/${main.jobId}/complete`, {});
check("complete 중복 호출은 멱등 (두 번째 Workflow 를 만들지 않음)", done1b.status === 200 && ["transcribing", "summarizing", "completed"].includes(done1b.data.status));

const { job, seen, ms } = await waitDone(main.jobId);
console.log(`     (상태 전이: ${seen.join(" → ")}, ${(ms / 1000).toFixed(1)}s)`);
check("최종 상태 completed", job.status === "completed", job.errorMessage);
check("진행률 3/3", job.progress.done === 3 && job.progress.total === 3);
check("상태가 transcribing → summarizing → completed 순서", seen.join(">").includes("transcribing>summarizing>completed"), seen.join(">"));

const segs = job.segments;
const starts = segs.map((s) => s.startMs);
check("세그먼트가 시간순", starts.every((v, i) => i === 0 || v >= starts[i - 1]));
check("조각 오프셋이 반영됨 (2번째 조각 ≥ 60s, 3번째 ≥ 120s)", segs.some((s) => s.startMs >= 60_000 && s.startMs < 120_000) && segs.some((s) => s.startMs >= 120_000), JSON.stringify(starts.slice(-3)));
check("세그먼트 90개 (30×3, 환각 1개 제거)", segs.length === 90, String(segs.length));
check("무음 환각 문구('시청해주셔서')가 제거됨", !segs.some((s) => s.text.includes("시청해주셔서")));
check("첫 세그먼트가 0초에서 시작", segs[0].startMs === 0 && segs[0].text.startsWith("안녕하세요"));

const s = job.summary;
check("요약 필드 존재 (title/tldr/decisions/actionItems/events)", s && s.title && s.tldr && Array.isArray(s.decisions) && Array.isArray(s.actionItems) && Array.isArray(s.events));
check("일정: 중복 추출된 '2차 디자인 리뷰'가 1건으로 합쳐짐", s.events.filter((e) => e.title.includes("디자인 리뷰")).length === 1, JSON.stringify(s.events.map((e) => e.title)));
const review = s.events.find((e) => e.title.includes("디자인 리뷰"));
check("일정 날짜가 기준 달력대로 2026-11-10(화) 15:00", review?.date === "2026-11-10" && review?.time === "15:00", JSON.stringify(review));
check("일정 장소·참석자·원문 표현", review?.location === "3층 회의실" && review?.attendees.includes("민수") && review?.dateText.includes("다음 주 화요일"));
check("일정 근거 시각(evidenceMs)이 숫자로 변환됨", typeof review?.evidenceMs === "number" && review.evidenceMs >= 60_000, String(review?.evidenceMs));
const due = s.events.find((e) => e.kind === "deadline");
check("마감 일정: 이번 달 말 = 2026-11-30, 시간 없음(종일)", due?.date === "2026-11-30" && due?.time === null, JSON.stringify(due));
check("일정이 날짜순 정렬", s.events.map((e) => e.date).join() === [...s.events.map((e) => e.date)].sort().join());
check("액션 아이템 기한이 달력대로 계산되고 중복 제거됨 (이번 주 금요일=2026-11-06)", s.actionItems.length === 1 && s.actionItems[0].dueDate === "2026-11-06" && s.actionItems[0].owner === "민수", JSON.stringify(s.actionItems));

console.log("\n[3] 외부 API 호출 검증 (mock 이 받은 요청)");
const log = await (await fetch(MOCK + "/__log")).json();
check("Whisper 호출 3회 (조각 수)", log.whisper.length === 3, String(log.whisper.length));
check("Whisper 에 올바른 키·모델·언어·verbose_json·세그먼트 타임스탬프 요청", log.whisper.every((w) => w.auth === "Bearer test-whisper-key" && w.fields.model === "whisper-1" && w.fields.language === "ko" && w.fields.response_format === "verbose_json" && w.fields["timestamp_granularities[]"] === "segment"), JSON.stringify(log.whisper[0]));
check("Whisper 가 받은 3개 조각이 모두 디코딩 가능한 MP3 (60s, 60s, ≈10s)", log.whisper.map((w) => Math.round(w.duration)).join() === "60,60,10", log.whisper.map((w) => w.duration).join());
check("각 조각은 25MB 제한보다 훨씬 작음", log.whisper.every((w) => w.fileBytes < 1_000_000));
const ex = log.anthropic.filter((a) => a.kind === "extract"); const mg = log.anthropic.filter((a) => a.kind === "merge");
check("요약: 청크(4000자)별 추출 2번 + 통합 1번 (map-reduce)", ex.length === 2 && mg.length === 1, `${ex.length} extract, ${mg.length} merge`);
check("Claude 요청: 모델·키·API 버전·구조화 출력 스키마(events 포함)", log.anthropic.every((a) => a.model === "claude-opus-5-5" && a.key === "test-anthropic-key" && a.version && a.formatType === "json_schema" && a.schemaHasEvents), JSON.stringify(log.anthropic[0]));
check("추출 프롬프트에 기준 달력이 포함됨", ex.every((a) => a.hasCalendar));

console.log("\n[4] 내보내기 / 미디어");
const exp = async (f) => { const r = await fetch(`${API}/api/jobs/${main.jobId}/export?format=${f}`); return { r, text: await r.text() }; };
const srt = await exp("srt");
check("SRT: 번호·시간 형식, 3번째 조각은 프레임 경계(59.976s×2)에서 시작", srt.r.status === 200 && /^1\n00:00:00,000 --> 00:00:01,800\n안녕하세요/.test(srt.text) && srt.text.includes("00:01:59,952"), srt.text.slice(0, 80));
check("SRT: attachment + 한글 파일명(RFC 5987)", /attachment; filename=".*"; filename\*=UTF-8''/.test(srt.r.headers.get("content-disposition") ?? ""));
const txt = await exp("txt"); check("TXT: [HH:MM:SS] 형식", /\[00:00:00\] 안녕하세요/.test(txt.text));
const md = await exp("md"); check("MD: 요약·일정·액션 아이템·대화록 섹션", ["## 한눈에 보기", "## 일정", "2026-11-10 (화)", "## 액션 아이템", "## 대화록"].every((k) => md.text.includes(k)));
const jsn = await exp("json"); check("JSON: 파싱 가능, summary.events 포함", jsn.r.status === 200 && JSON.parse(jsn.text).summary.events.length >= 2);
const ics = await exp("ics");
check("ICS: 시간 일정 + 종일 마감 일정, CRLF", ics.text.includes("DTSTART;TZID=Asia/Seoul:20261110T150000") && ics.text.includes("DTSTART;VALUE=DATE:20261130") && ics.text.includes("\r\n") && ics.r.headers.get("content-type")?.startsWith("text/calendar"));
await new Promise((r) => setTimeout(r, 500));
const srt2 = await exp("srt"); check("두 번째 요청(R2 캐시)도 같은 내용", srt2.text === srt.text);
// Word(.docx): workerd 런타임에서 실제로 만들어지고, 열 수 있는 ZIP 이며, 두 가지 버전(요약본 / 대화록 포함)이 따로 캐시된다
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docxGet = async (q = "") => { const r = await fetch(`${API}/api/jobs/${main.jobId}/export?format=docx${q}`); return { r, buf: Buffer.from(await r.arrayBuffer()) }; };
const docxXml = (buf, name) => { const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.docx`); writeFileSync(f, buf); return execFileSync("unzip", ["-p", f, name]).toString(); };
const dx = await docxGet();
check("DOCX: 200 + Content-Type(wordprocessingml) + ZIP 시그니처(PK)", dx.r.status === 200 && dx.r.headers.get("content-type") === DOCX_TYPE && dx.buf.subarray(0, 2).toString() === "PK", `${dx.r.status} ${dx.r.headers.get("content-type")}`);
check("DOCX: 한글 파일명 .docx 로 다운로드", /filename\*=UTF-8''.*\.docx$/.test(dx.r.headers.get("content-disposition") ?? ""), dx.r.headers.get("content-disposition"));
const dxXml = docxXml(dx.buf, "word/document.xml");
check("DOCX 본문: 제목·일정(날짜·시간·장소)·액션 아이템·결정사항", ["주간 회의 통합 회의록", "2026년 11월 6일 (금)", "2차 디자인 리뷰", "2026-11-10 (화)", "15:00", "3층 회의실", "QA 체크리스트 작성", "민수", "연말 정산 서류 제출", "종일"].every((t) => dxXml.includes(t)));
check("DOCX 기본본은 대화록 부록 없음", !dxXml.includes("부록. 대화록"));
const dxFull = await docxGet("&transcript=1");
const fullXml = docxXml(dxFull.buf, "word/document.xml");
check("DOCX 대화록 포함본: 부록 + 90개 발언 타임스탬프, 파일명에 (대화록 포함)", dxFull.buf.length > dx.buf.length && fullXml.includes("부록. 대화록") && (fullXml.match(/\[\d\d:\d\d:\d\d\]/g) ?? []).length === 90 && decodeURIComponent(dxFull.r.headers.get("content-disposition") ?? "").includes("(대화록 포함).docx"), `${dxFull.buf.length} vs ${dx.buf.length}`);
await new Promise((r) => setTimeout(r, 600));
const dx2 = await docxGet(); const dxFull2 = await docxGet("&transcript=1");
check("DOCX 두 번째 요청(R2 바이너리 캐시)도 바이트까지 동일, 두 버전이 섞이지 않음", dx2.buf.equals(dx.buf) && dxFull2.buf.equals(dxFull.buf) && !dx2.buf.equals(dxFull2.buf));
check("잘못된 format → 400", (await j("GET", `/api/jobs/${main.jobId}/export?format=exe`)).status === 400);
const full = await fetch(`${API}/api/jobs/${main.jobId}/media`);
check("미디어 전체: 200, audio/mpeg, Accept-Ranges", full.status === 200 && full.headers.get("content-type") === "audio/mpeg" && full.headers.get("accept-ranges") === "bytes" && Number(full.headers.get("content-length")) === audio.length);
const part = await fetch(`${API}/api/jobs/${main.jobId}/media`, { headers: { range: "bytes=1000-1999" } });
const partBuf = Buffer.from(await part.arrayBuffer());
check("미디어 Range: 206 + Content-Range + 정확한 바이트", part.status === 206 && part.headers.get("content-range") === `bytes 1000-1999/${audio.length}` && partBuf.length === 1000 && partBuf.equals(audio.subarray(1000, 2000)), `${part.status} ${part.headers.get("content-range")}`);
const tail = await fetch(`${API}/api/jobs/${main.jobId}/media`, { headers: { range: "bytes=-500" } });
check("미디어 Range: 끝에서 500바이트(suffix)", tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(audio.subarray(audio.length - 500)));
check("진행 중 작업의 export → 409", (await j("POST", "/api/uploads", { fileName: "b.mp3", mimeType: "audio/mpeg", sizeBytes: 10, audioSizeBytes: 10, language: "ko" }).then((c) => j("GET", `/api/jobs/${c.data.jobId}/export?format=srt`))).status === 409);

console.log("\n[5] 일시 오류 복구: Whisper 가 처음 2번 503 → 재시도로 성공");
await mock({ reset: true }); await mock({ whisper: { failFirst: 2 } });
const flaky = await uploadJob(); await j("POST", `/api/uploads/${flaky.jobId}/complete`, {});
const flakyDone = await waitDone(flaky.jobId);
check("503 두 번 뒤 정상 완료", flakyDone.job.status === "completed", flakyDone.job.errorMessage);
check("세그먼트 중복 없음 (90개)", flakyDone.job.segments.length === 90, String(flakyDone.job.segments.length));

console.log("\n[6] 영구 오류(키 오류) → failed + 원인 메시지 → 복구 후 재시도");
await mock({ reset: true }); await mock({ whisper: { status: 401 } });
const bad = await uploadJob(); await j("POST", `/api/uploads/${bad.jobId}/complete`, {});
const badDone = await waitDone(bad.jobId);
check("전사 401 → failed", badDone.job.status === "failed");
check("error_message 가 한국어로 원인 안내 (API 키)", /API 키/.test(badDone.job.errorMessage ?? ""), badDone.job.errorMessage);
check("error_message 에 내부 클래스명(NonRetryableError)이 새지 않음", !/Error:/.test((badDone.job.errorMessage ?? "").split("[")[0]), badDone.job.errorMessage);
check("실패 시에도 키 값은 노출되지 않음", !JSON.stringify(badDone.job).includes("test-whisper-key"));
check("401 은 재시도하지 않음 (Whisper 호출 1회)", (await (await fetch(MOCK + "/__log")).json()).whisper.length === 1);
await mock({ reset: true });
check("완료되지 않은 작업은 retry 불가가 아니라 failed 만 가능: completed 작업 retry → 409", (await j("POST", `/api/jobs/${main.jobId}/retry`)).status === 409);
const retry = await j("POST", `/api/jobs/${bad.jobId}/retry`);
check("failed 작업 retry → transcribing", retry.status === 200 && retry.data.status === "transcribing", JSON.stringify(retry.data));
const retried = await waitDone(bad.jobId);
check("재시도 후 completed", retried.job.status === "completed", retried.job.errorMessage);
check("재시도해도 세그먼트 중복 없음 (90개)", retried.job.segments.length === 90, String(retried.job.segments.length));

console.log("\n[7] 요약 단계 실패 → 이미 끝난 전사는 재사용");
await mock({ reset: true }); await mock({ anthropic: { status: 401 } });
const bad2 = await uploadJob(); await j("POST", `/api/uploads/${bad2.jobId}/complete`, {});
const bad2Done = await waitDone(bad2.jobId);
check("요약 401 → failed, 메시지에 Anthropic API 키 안내", bad2Done.job.status === "failed" && /Anthropic API 키/.test(bad2Done.job.errorMessage ?? ""), bad2Done.job.errorMessage);
await mock({ reset: true });
await j("POST", `/api/jobs/${bad2.jobId}/retry`);
const bad2Retried = await waitDone(bad2.jobId);
check("재시도 후 completed + 요약 생성", bad2Retried.job.status === "completed" && !!bad2Retried.job.summary);
const l2 = await (await fetch(MOCK + "/__log")).json();
check("재시도에서 Whisper 를 다시 호출하지 않음 (전사 재사용)", l2.whisper.length === 0, String(l2.whisper.length));

console.log("\n[8] 삭제");
const del = await j("DELETE", `/api/jobs/${main.jobId}`);
check("DELETE → 200", del.status === 200);
check("삭제 후 조회·미디어·내보내기 모두 404", (await j("GET", `/api/jobs/${main.jobId}`)).status === 404 && (await fetch(`${API}/api/jobs/${main.jobId}/media`)).status === 404 && (await j("GET", `/api/jobs/${main.jobId}/export?format=srt`)).status === 404);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패: ${failed.map((f) => f.name).join(" | ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
