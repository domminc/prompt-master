// 로컬 스모크 테스트용 가짜 Whisper + Anthropic 서버. (실제 AI 품질은 검증하지 못한다 — 요청/응답 배관만 검증)
//   node scripts/dev/mock-ai.mjs [port]
// 제어: POST /__control  { reset:true } | { whisper:{ status:401 } } | { whisper:{ failFirst:2 } } | { anthropic:{ status:401 } } | { anthropic:{ delayMs:1500 } }
// 기록: GET  /__log      → 받은 요청 요약
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 9100);
const tmp = mkdtempSync(path.join(tmpdir(), "mock-ai-"));
let control = {};
let whisperCalls = 0;
const log = { whisper: [], anthropic: [] };

const readBody = (req) => new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

// ── multipart 에서 file 파트와 일반 필드를 꺼낸다 ──
function parseMultipart(buf, contentType) {
  const boundary = "--" + /boundary=(.+)$/.exec(contentType)[1];
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const raw = buf.subarray(pos + boundary.length + 2, next - 2); // 앞 \r\n, 뒤 \r\n 제거
    const headEnd = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, headEnd).toString("utf8");
    parts.push({ head, body: raw.subarray(headEnd + 4) });
    pos = next;
  }
  const fields = {};
  let file = null;
  for (const p of parts) {
    const name = /name="([^"]+)"/.exec(p.head)?.[1];
    const filename = /filename="([^"]+)"/.exec(p.head)?.[1];
    if (filename) file = { name, filename, data: p.body };
    else if (name) fields[name] = p.body.toString("utf8");
  }
  return { fields, file };
}

// ── Whisper ──
const filler = (i) => `${i}번째로 이야기할 안건은 제품 로드맵과 팀 운영 방식에 대한 내용이고 관련 자료는 공유 폴더에 올려 두었습니다.`;
function whisperScript(index) {
  const lines = Array.from({ length: 30 }, (_, j) => filler(index * 30 + j));
  if (index === 0) lines[0] = "안녕하세요, 주간 회의를 시작하겠습니다.";
  if (index === 1) {
    lines[3] = "다음 주 화요일 오후 3시에 3층 회의실에서 2차 디자인 리뷰를 하겠습니다. 민수 님이 참석해 주세요.";
    lines[8] = "QA 체크리스트는 민수 님이 이번 주 금요일까지 작성해 주세요.";
  }
  if (index === 2) {
    lines[2] = "다시 말씀드리면 다음 주 화요일 오후 3시 디자인 리뷰 잊지 마세요.";
    lines[5] = "연말 정산 서류는 이번 달 말까지 제출해야 합니다.";
  }
  const segments = lines.map((text, j) => ({ start: j * 2, end: j * 2 + 1.8, text: " " + text, avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.3 }));
  if (index === 2) segments.push({ start: 61, end: 62, text: " 시청해주셔서 감사합니다", avg_logprob: -1.5, no_speech_prob: 0.92, compression_ratio: 1.0 }); // 환각 → 걸러져야 함
  return segments;
}

async function handleWhisper(req, res) {
  whisperCalls++;
  const body = await readBody(req);
  const auth = req.headers.authorization;
  const entry = { auth, bytes: body.length };
  log.whisper.push(entry);
  if (control.whisper?.status) return json(res, control.whisper.status, { error: { message: "mock forced failure" } });
  if (control.whisper?.failFirst && whisperCalls <= control.whisper.failFirst) return json(res, 503, { error: { message: "mock busy" } });
  if (auth !== "Bearer test-whisper-key") return json(res, 401, { error: { message: "bad key" } });

  const { fields, file } = parseMultipart(body, req.headers["content-type"]);
  const index = Number(/chunk-(\d+)\.mp3/.exec(file?.filename ?? "")?.[1] ?? -1);
  // 받은 조각이 정말 디코딩 가능한 MP3 인지 ffprobe 로 확인
  const f = path.join(tmp, `chunk-${index}-${whisperCalls}.mp3`);
  writeFileSync(f, file.data);
  let duration = null;
  try { duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()); } catch { /* 디코딩 불가 */ }
  Object.assign(entry, { index, fields, filename: file.filename, fileBytes: file.data.length, duration });
  if (!duration) return json(res, 400, { error: { message: "invalid audio" } });
  json(res, 200, { task: "transcribe", language: "korean", duration, text: "", segments: whisperScript(index) });
}

// ── Anthropic Messages ──
const pick = (re, s) => re.exec(s)?.[1];
function lookupWeekday(calendar, weekLabel, wd) {
  const range = new RegExp(`${weekLabel}: (\\d{4}-\\d{2}-\\d{2})\\(월\\) ~ (\\d{4}-\\d{2}-\\d{2})\\(일\\)`).exec(calendar);
  if (!range) return null;
  const rows = [...calendar.matchAll(/^(\d{4}-\d{2}-\d{2}) \((.)\)/gm)];
  return rows.find((m) => m[1] >= range[1] && m[1] <= range[2] && m[2] === wd)?.[1] ?? null;
}
const stampOf = (transcript, re) => pick(/\[(\d\d:\d\d:\d\d)\]/, transcript.split("\n").find((l) => re.test(l)) ?? "");

function extract(user) {
  const calendar = pick(/<기준_달력>\n([\s\S]*?)\n<\/기준_달력>/, user) ?? "";
  const t = pick(/<전사본>\n([\s\S]*?)\n<\/전사본>/, user) ?? "";
  const events = [];
  const actionItems = [];
  if (/다음 주 화요일 오후 3시/.test(t)) {
    events.push({ title: "2차 디자인 리뷰", kind: "meeting", date: lookupWeekday(calendar, "다음 주", "화"), time: "15:00", endTime: null, dateText: "다음 주 화요일 오후 3시", location: /3층 회의실/.test(t) ? "3층 회의실" : null, attendees: /민수/.test(t) ? ["민수"] : [], confidence: "medium", evidenceTime: stampOf(t, /다음 주 화요일/) ?? null });
  }
  if (/이번 달 말까지/.test(t)) {
    events.push({ title: "연말 정산 서류 제출", kind: "deadline", date: pick(/이번 달 말일: (\d{4}-\d{2}-\d{2})/, calendar) ?? null, time: null, endTime: null, dateText: "이번 달 말까지", location: null, attendees: [], confidence: "medium", evidenceTime: stampOf(t, /이번 달 말/) ?? null });
  }
  if (/QA 체크리스트/.test(t)) {
    actionItems.push({ task: "QA 체크리스트 작성", owner: "민수", dueDate: lookupWeekday(calendar, "이번 주", "금") ?? "미확인", priority: "high", evidenceTime: stampOf(t, /QA 체크리스트/) ?? null });
  }
  const part = pick(/(\d+\/\d+)번째 구간/, user);
  return { title: part ? `주간 회의 (${part})` : "주간 회의", tldr: "신규 기능 일정과 디자인 리뷰를 논의했다.", decisions: events.length ? ["디자인 리뷰는 다음 주 화요일에 진행한다"] : [], actionItems, events, openQuestions: [] };
}
function merge(user) {
  const parts = [...user.matchAll(/### 구간 \d+\n(\{.*\})/g)].map((m) => JSON.parse(m[1]));
  return {
    title: "주간 회의 통합 회의록", tldr: "여러 구간을 통합했다.",
    decisions: [...new Set(parts.flatMap((p) => p.decisions))],
    actionItems: parts.flatMap((p) => p.actionItems), // 일부러 중복 제거를 하지 않는다 (후처리 검증용)
    events: parts.flatMap((p) => p.events),
    openQuestions: [],
  };
}

// 공식 SDK 버전에 따라 키를 x-api-key 또는 Authorization: Bearer 로 보낸다 — 둘 다 받는다.
const anthropicKey = (req) => req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "");

async function handleAnthropic(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
  const user = body.messages.at(-1).content;
  const isMerge = system.includes("부분 결과들이 주어진다");
  log.anthropic.push({
    kind: isMerge ? "merge" : "extract", model: body.model, key: anthropicKey(req), version: req.headers["anthropic-version"],
    formatType: body.output_config?.format?.type, schemaHasEvents: !!body.output_config?.format?.schema?.properties?.events,
    hasCalendar: typeof user === "string" && user.includes("<기준_달력>"), effort: body.output_config?.effort, maxTokens: body.max_tokens,
  });
  if (control.anthropic?.status) return json(res, control.anthropic.status, { type: "error", error: { type: "authentication_error", message: "mock forced failure" } });
  if (anthropicKey(req) !== "test-anthropic-key") return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  const out = isMerge ? merge(user) : extract(user);
  if (control.anthropic?.delayMs) await new Promise((r) => setTimeout(r, control.anthropic.delayMs)); // 상태 전이를 눈으로 볼 수 있게
  json(res, 200, {
    id: "msg_mock", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(out) }],
    usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") return await handleWhisper(req, res);
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) return await handleAnthropic(req, res);
    if (req.method === "POST" && req.url === "/__control") {
      const c = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (c.reset) { control = {}; whisperCalls = 0; log.whisper.length = 0; log.anthropic.length = 0; } else control = { ...control, ...c };
      return json(res, 200, { ok: true, control });
    }
    if (req.method === "GET" && req.url === "/__log") return json(res, 200, log);
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e) });
  }
}).listen(port, "127.0.0.1", () => console.log(`mock-ai listening on ${port}`));
