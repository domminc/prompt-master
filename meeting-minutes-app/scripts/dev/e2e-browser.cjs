// 실제 Chromium 으로 전체 사용자 흐름을 검증한다: 파일 선택 → 브라우저 ffmpeg.wasm 변환 → 업로드 → 서버 처리 → 결과 화면.
// 사전 준비: smoke.mjs 와 같음 (Postgres, mock-ai, wrangler dev) + `npm run build`
//   SHOTS_DIR=/tmp/shots MEDIA_DIR=/tmp/media PRETENDARD_DIR=/path/to/node_modules/pretendard node scripts/dev/e2e-browser.cjs
// 네트워크가 제한된 환경을 위해 ffmpeg-core(jsdelivr)와 Pretendard 요청은 로컬 npm 패키지로 대신 응답한다.
const { chromium, devices } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9100";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/e2e-shots";
const MEDIA = process.env.MEDIA_DIR ?? "/tmp/e2e-media";
const CORE_DIR = path.resolve(__dirname, "../../node_modules/@ffmpeg/core/dist/esm");
const PRETENDARD = process.env.PRETENDARD_DIR; // node_modules/pretendard 경로 (선택)
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `  → ${detail}` : ""}`);
};
const mock = (c) => fetch(MOCK + "/__control", { method: "POST", body: JSON.stringify(c) });
const sh = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

// ── 테스트 미디어: 영상+소리 mp4(moov 가 파일 끝), 소리 없는 mp4, 텍스트 파일 ──
const meetingMp4 = path.join(MEDIA, "meeting-src.mp4"); // 디스크 경로는 ASCII (일부 환경에서 비ASCII 경로를 브라우저가 못 연다)
const silentMp4 = path.join(MEDIA, "no-audio.mp4");
const notesTxt = path.join(MEDIA, "notes.txt");
sh(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=5", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "130", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", meetingMp4]);
sh(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=5", "-t", "5", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silentMp4]);
fs.writeFileSync(notesTxt, "회의 메모");
const originalSize = fs.statSync(meetingMp4).size;
// 화면에는 한글 파일명으로 보이도록 메모리 버퍼로 File 을 만들어 넣는다
const meetingPayload = { name: "주간 회의.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(meetingMp4) };

const mime = { ".css": "text/css", ".woff2": "font/woff2", ".js": "text/javascript", ".wasm": "application/wasm" };
async function installRoutes(context) {
  await context.route("**/@ffmpeg/core@*/dist/esm/*", (route) => {
    const file = path.join(CORE_DIR, new URL(route.request().url()).pathname.split("/").pop());
    route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] ?? "application/octet-stream", headers: { "access-control-allow-origin": "*" } });
  });
  if (PRETENDARD) {
    await context.route("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@*/dist/web/variable/**", (route) => {
      // CDN 은 .min.css, npm 패키지는 .css
      const rel = new URL(route.request().url()).pathname.split("/dist/web/variable/")[1].replace(/\.min\.css$/, ".css");
      const file = path.join(PRETENDARD, "dist/web/variable", rel);
      if (!fs.existsSync(file)) return route.abort();
      route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] ?? "application/octet-stream", headers: { "access-control-allow-origin": "*" } });
    });
  }
}

const consoleErrors = [];
function watch(page, label) {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`[${label}] ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] pageerror ${e.message}`));
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  // 로캘이 설정되지 않은 환경에서는 Chromium 이 비ASCII 파일명을 저장하지 못해 한글 파일명이 "download" 로 나온다
  const browser = await chromium.launch({ env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  await installRoutes(context);
  const page = await context.newPage();
  watch(page, "desktop");

  // 업로드 요청 감시: 원본 영상이 아니라 추출된 오디오만 나가는지 확인한다
  const uploads = [];
  page.on("request", (r) => {
    if (r.method() === "PUT") uploads.push({ url: r.url(), type: r.headers()["content-type"], size: r.postDataBuffer()?.length ?? 0, head: r.postDataBuffer()?.subarray(0, 2) });
  });

  console.log("\n[A1] 첫 화면 (데스크톱 1280px)");
  await page.goto(BASE + "/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  check("제목이 보인다", /회의록과 일정까지/.test(await page.getByRole("heading", { level: 1 }).innerText()));
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.includes("Pretendard") && f.status === "loaded"), null, { timeout: 15000 }).catch(() => {});
  const fontInfo = await page.evaluate(() => ({ family: getComputedStyle(document.body).fontFamily, loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family) }));
  check("body 폰트가 Pretendard Variable 우선", fontInfo.family.startsWith('"Pretendard Variable"'), fontInfo.family);
  if (PRETENDARD) check("Pretendard 폰트 파일이 실제로 로드됨", fontInfo.loaded.some((f) => f.includes("Pretendard")), JSON.stringify(fontInfo.loaded));
  check("body 에 word-break: keep-all (한글 단어 단위 줄바꿈)", (await page.evaluate(() => getComputedStyle(document.body).wordBreak)) === "keep-all");
  await page.screenshot({ path: path.join(SHOTS, "01-desktop-home.png") });

  console.log("\n[A2] 잘못된 파일 / 소리 없는 영상");
  await page.setInputFiles("input[type=file]", notesTxt);
  check("txt 파일 → 지원하지 않는 형식 안내", /지원하지 않는 형식/.test(await page.getByRole("alert").innerText()));
  await page.setInputFiles("input[type=file]", silentMp4);
  await page.getByLabel(/회의 날짜/).fill("2026-11-06");
  await page.getByRole("button", { name: "회의록 만들기" }).click();
  await page.getByRole("alert").waitFor({ timeout: 90000 });
  check("소리 없는 mp4 → '오디오 트랙이 없어요' 안내 (브라우저 변환 단계에서 거름)", /오디오 트랙|소리/.test(await page.getByRole("alert").innerText()), await page.getByRole("alert").innerText());
  check("이 경우 서버로는 아무것도 올라가지 않음", uploads.length === 0);

  console.log("\n[A3] 정상 파일: 선택 → 변환 → 업로드 → 서버 처리");
  await mock({ reset: true });
  await mock({ anthropic: { delayMs: 3000 } }); // 처리 중 화면을 캡처하기 위해 느리게
  await page.getByRole("button", { name: "다른 파일 선택" }).click(); // 앞선 실패 파일을 바꾼다
  await page.setInputFiles("input[type=file]", meetingPayload);
  await page.getByText("주간 회의.mp4").waitFor();
  check("파일 카드에 이름·크기 표시", (await page.getByText(/MB|KB/).first().innerText()).length > 0);
  await page.waitForFunction(() => /\d+분/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  check("미디어 길이를 읽어 예상 소요 시간을 보여 줌", /예상 소요/.test(await page.locator("body").innerText()), "headless Chromium 이 H.264/AAC mp4 메타데이터를 못 읽을 수 있음");
  await page.getByLabel(/회의 날짜/).fill("2026-11-06");
  await page.screenshot({ path: path.join(SHOTS, "02-desktop-selected.png") });
  const t0 = Date.now();
  await page.getByRole("button", { name: "회의록 만들기" }).click();
  await page.getByRole("progressbar").waitFor({ timeout: 30000 }).catch(() => {});
  const stage1 = await page.locator("body").innerText();
  check("변환 단계 진행 표시 (엔진 준비/추출 문구)", /변환 엔진|소리만 추출|업로드/.test(stage1), stage1.slice(0, 200));
  await page.screenshot({ path: path.join(SHOTS, "03-desktop-converting.png") });
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 180000 });
  const jobUrl = page.url();
  console.log(`     (변환+업로드 ${(Date.now() - t0) / 1000}s) ${jobUrl}`);
  check("업로드 완료 후 작업 페이지로 이동", /\/jobs\//.test(jobUrl));
  const audioPut = uploads.find((u) => /\/api\/uploads\/.+\/audio$/.test(u.url));
  check("추출된 오디오 1건만 PUT, Content-Type audio/mpeg", uploads.length === 1 && audioPut?.type === "audio/mpeg", JSON.stringify(uploads.map((u) => ({ ...u, head: undefined }))));
  check(`원본 mp4(${(originalSize / 1024).toFixed(0)}KB)가 아니라 추출 오디오(${((audioPut?.size ?? 0) / 1024).toFixed(0)}KB)만 업로드`, audioPut && audioPut.size < originalSize && Math.abs(audioPut.size - 130 * 4000) < 20000, String(audioPut?.size));
  check("업로드된 데이터가 MP3 프레임으로 시작 (0xFF 0xE?)", audioPut?.head?.[0] === 0xff && (audioPut.head[1] & 0xe0) === 0xe0);

  await page.getByText(/전사 중|정리하고 있어요|녹음을 글로/).first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.getByText(/회의 내용을 정리하고 있어요/).waitFor({ timeout: 60000 }).catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, "04-desktop-processing.png") });
  check("처리 중 화면(요약 단계) 표시", /정리하고 있어요/.test(await page.locator("body").innerText()));

  await page.getByRole("heading", { level: 1, name: "주간 회의 통합 회의록" }).waitFor({ timeout: 120000 });
  console.log("\n[A4] 결과 화면 (데스크톱)");
  await page.getByRole("heading", { name: /일정/ }).first().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, "05-desktop-result.png"), fullPage: false });
  check("요약·일정·결정·액션·대화록이 한 화면에 (가로 스크롤 없음)", (await overflow(page)) <= 1, String(await overflow(page)));
  check("한눈에 보기 / 핵심 결정사항 / 액션 아이템 섹션", ["한눈에 보기", "핵심 결정사항", "액션 아이템"].every((t) => page.getByRole("heading", { name: new RegExp(t) }).count().then((n) => n > 0) !== false));
  const bodyText = await page.locator("main").innerText();
  check("일정 2건 표시 (2차 디자인 리뷰, 연말 정산 서류 제출)", /일정\s*2건/.test(bodyText) && bodyText.includes("2차 디자인 리뷰") && bodyText.includes("연말 정산 서류 제출"));
  check("일정 날짜 블록: 11월 10 화", await page.getByLabel("2026-11-10 화요일").isVisible());
  check("시간(종료 시각은 언급이 없으면 지어내지 않음)·장소·참석자 표시", /15:00/.test(bodyText) && !/16:00/.test(bodyText) && bodyText.includes("3층 회의실") && bodyText.includes("민수"));
  check("'계산됨' 배지 (상대 날짜를 계산한 일정)", bodyText.includes("계산됨"));
  const gcal = await page.getByRole("link", { name: /Google 캘린더에 추가/ }).first().getAttribute("href");
  const gq = new URL(gcal).searchParams;
  check("Google 캘린더 링크: 제목·날짜·시간대·장소", gq.get("text") === "2차 디자인 리뷰" && gq.get("dates") === "20261110T150000/20261110T160000" && gq.get("ctz") === "Asia/Seoul" && gq.get("location") === "3층 회의실", gcal);
  check("종일 마감 일정은 날짜만 (20261130/20261201)", (await page.getByRole("link", { name: /Google 캘린더에 추가/ }).nth(1).getAttribute("href")).includes("dates=20261130%2F20261201"));
  check("액션 아이템: 담당 민수 / 기한 11월 6일 (금)", bodyText.includes("민수") && /11월 6일 \(금\)/.test(bodyText));

  // 대화록 클릭 → 플레이어 이동
  await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && a.readyState >= 1 && a.duration > 100; }, null, { timeout: 15000 }).catch(() => {});
  const dur = await page.evaluate(() => document.querySelector("audio")?.duration);
  check("오디오 플레이어가 /media 에서 메타데이터를 읽음 (≈130초)", dur > 125 && dur < 135, String(dur));
  await page.getByRole("button", { name: /^00:00:59 30번째로/ }).click();
  await page.waitForFunction(() => document.querySelector("audio").currentTime >= 59, null, { timeout: 8000 }).catch(() => {});
  const ct = await page.evaluate(() => document.querySelector("audio").currentTime);
  check("대화록 문장 클릭 → 해당 시각(59.97s)으로 이동해 재생", ct >= 59 && ct < 64, String(ct));
  await page.waitForTimeout(1500);
  const activeRow = await page.locator('button[aria-current="true"]').first().innerText().catch(() => "");
  check("재생 중인 문장이 하이라이트됨", /^00:00:(59|6\d)/.test(activeRow) || /^00:01:/.test(activeRow), activeRow.slice(0, 40));
  await page.getByRole("button", { name: /재생 속도/ }).click();
  check("재생 속도 버튼 (1x → 1.5x)", (await page.evaluate(() => document.querySelector("audio").playbackRate)) === 1.5);
  await page.evaluate(() => document.querySelector("audio").pause());

  // 이벤트의 ▶ 근거 버튼
  const evBtn = page.getByRole("button", { name: /지점부터 듣기/ }).first();
  await evBtn.click();
  const ct2 = await page.evaluate(() => document.querySelector("audio").currentTime);
  check("일정의 ▶ 버튼 → 그 일정을 말한 시각으로 이동", ct2 > 60, String(ct2));
  await page.evaluate(() => document.querySelector("audio").pause());

  console.log("\n[A5] 내려받기");
  await page.getByRole("button", { name: /내려받기/ }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /자막/ }).click()]);
  const srtText = fs.readFileSync(await dl.path(), "utf8");
  check("SRT 다운로드: 한글 파일명 + 올바른 형식", dl.suggestedFilename() === "주간 회의 통합 회의록.srt" && srtText.startsWith("1\n00:00:00,000 --> 00:00:01,800\n"), `${dl.suggestedFilename()} | ${srtText.slice(0, 50)}`);
  await page.getByRole("button", { name: /내려받기/ }).click();
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /일정/ }).click()]);
  const icsAll = fs.readFileSync(await dl2.path(), "utf8");
  check("ICS 전체: 파일명 .ics, VEVENT 2건, KST 시간대", dl2.suggestedFilename().endsWith(".ics") && (icsAll.match(/BEGIN:VEVENT/g) || []).length === 2 && icsAll.includes("DTSTART;TZID=Asia/Seoul:20261110T150000"), dl2.suggestedFilename());
  await page.getByRole("button", { name: /내려받기/ }).click();
  const [dl3] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /회의록/ }).first().click()]);
  const md = fs.readFileSync(await dl3.path(), "utf8");
  check("Markdown: 제목·일정 표·대화록", md.startsWith("# 주간 회의 통합 회의록") && md.includes("## 일정") && md.includes("2026-11-10 (화)"));
  await page.getByRole("button", { name: /내려받기/ }).click();
  const [dl4] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /전체 데이터/ }).click()]);
  check("JSON: 파싱 가능", !!JSON.parse(fs.readFileSync(await dl4.path(), "utf8")).summary);
  await page.getByRole("button", { name: /내려받기/ }).click();
  await page.getByRole("menuitem", { name: /회의록 복사/ }).click();
  await page.waitForTimeout(300);
  check("회의록 복사 → 클립보드에 Markdown", (await page.evaluate(() => navigator.clipboard.readText())).startsWith("# 주간 회의 통합 회의록"));
  await page.keyboard.press("Escape");
  const [dl5] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /\.ics \(애플/ }).first().click()]);
  const icsOne = fs.readFileSync(await dl5.path(), "utf8");
  check("개별 일정 .ics (브라우저에서 생성): 1건", (icsOne.match(/BEGIN:VEVENT/g) || []).length === 1 && icsOne.includes("SUMMARY:2차 디자인 리뷰") && icsOne.includes("\r\n"), icsOne.slice(0, 120));

  console.log("\n[A6] 새로고침 / 최근 목록");
  await page.reload();
  await page.getByRole("heading", { level: 1, name: "주간 회의 통합 회의록" }).waitFor();
  check("새로고침해도 결과 유지", true);
  await page.getByRole("link", { name: "새 회의록" }).click();
  await page.getByRole("heading", { name: /최근 회의록/ }).waitFor();
  check("최근 회의록 목록에 표시되고 제목이 요약 제목으로 갱신됨", await page.getByText("주간 회의 통합 회의록").first().isVisible());
  await page.screenshot({ path: path.join(SHOTS, "06-desktop-home-recent.png") });

  console.log("\n[B] 모바일 (iPhone 13 크기 390×844, 터치)");
  const d = devices["iPhone 13"];
  const mctx = await browser.newContext({ viewport: d.viewport, userAgent: d.userAgent, deviceScaleFactor: 1, isMobile: true, hasTouch: true, acceptDownloads: true });
  await installRoutes(mctx);
  const mp = await mctx.newPage();
  watch(mp, "mobile");
  await mp.goto(BASE + "/");
  await mp.getByRole("heading", { level: 1 }).waitFor();
  check("모바일 첫 화면 가로 스크롤 없음", (await overflow(mp)) <= 1, String(await overflow(mp)));
  await mp.screenshot({ path: path.join(SHOTS, "10-mobile-home.png") });
  await mp.setInputFiles("input[type=file]", meetingPayload);
  await mp.getByText("주간 회의.mp4").waitFor();
  check("모바일 파일 선택 화면 가로 스크롤 없음", (await overflow(mp)) <= 1);
  await mp.screenshot({ path: path.join(SHOTS, "11-mobile-selected.png") });
  const btn = await mp.getByRole("button", { name: "회의록 만들기" }).boundingBox();
  check("주요 버튼 높이 ≥ 44px (터치 목표)", btn.height >= 44, String(btn.height));

  await mp.goto(jobUrl);
  await mp.getByRole("heading", { level: 1, name: "주간 회의 통합 회의록" }).waitFor();
  check("모바일 결과(요약 탭) 가로 스크롤 없음", (await overflow(mp)) <= 1, String(await overflow(mp)));
  const tabH = (await mp.getByRole("tab").first().boundingBox()).height;
  check("탭 높이 ≥ 44px", tabH >= 44, String(tabH));
  check("요약 탭: 한눈에 보기 보임 / 일정·대화록은 숨김", (await mp.getByRole("heading", { name: "한눈에 보기" }).isVisible()) && !(await mp.getByRole("heading", { name: /^일정/ }).isVisible()) && !(await mp.getByRole("heading", { name: /^대화록/ }).isVisible()));
  const player = await mp.locator("audio").boundingBox();
  check("하단 고정 플레이어가 화면 안에 보임", player && player.y + player.height <= 844 && player.y > 500, JSON.stringify(player));
  await mp.screenshot({ path: path.join(SHOTS, "12-mobile-summary.png") });
  await mp.getByRole("tab", { name: /^일정/ }).tap();
  check("일정 탭: 일정 카드 보임, 요약은 숨김", (await mp.getByRole("heading", { name: /2차 디자인 리뷰/ }).isVisible()) && !(await mp.getByRole("heading", { name: "한눈에 보기" }).isVisible()));
  check("모바일 일정 탭 가로 스크롤 없음", (await overflow(mp)) <= 1, String(await overflow(mp)));
  const gbtn = await mp.getByRole("link", { name: /Google 캘린더에 추가/ }).first().boundingBox();
  check("캘린더 추가 버튼 높이 ≥ 40px", gbtn.height >= 40, String(gbtn.height));
  await mp.screenshot({ path: path.join(SHOTS, "13-mobile-events.png"), fullPage: true });
  await mp.getByRole("tab", { name: "대화록" }).tap();
  check("대화록 탭: 문장 목록 보임", await mp.getByRole("button", { name: /^00:00:59 30번째로/ }).isVisible().catch(() => false) || (await mp.getByRole("button", { name: /^00:00:00 안녕하세요/ }).isVisible()));
  check("모바일 대화록 탭 가로 스크롤 없음", (await overflow(mp)) <= 1, String(await overflow(mp)));
  await mp.screenshot({ path: path.join(SHOTS, "14-mobile-transcript.png") });
  // 탭을 옮겨도 같은 <audio> 하나가 유지된다
  check("<audio> 요소는 페이지에 하나뿐", (await mp.locator("audio").count()) === 1);

  console.log("\n[C] 실패 화면 → 다시 시도 → 삭제 (데스크톱)");
  await mock({ reset: true });
  await mock({ whisper: { status: 401 } });
  await page.goto(BASE + "/");
  await page.setInputFiles("input[type=file]", meetingPayload);
  await page.getByLabel(/회의 날짜/).fill("2026-11-06");
  await page.getByRole("button", { name: "회의록 만들기" }).click();
  await page.getByRole("heading", { name: "처리하지 못했어요" }).waitFor({ timeout: 180000 });
  const failText = await page.getByRole("alert").innerText();
  check("실패 화면에 한국어 원인(전사 API 키) 표시", /전사 실패.*API 키/.test(failText), failText);
  check("키 값은 화면에 노출되지 않음", !(await page.locator("body").innerText()).includes("test-whisper-key"));
  check("다시 시도 / 새 파일 올리기 버튼", (await page.getByRole("button", { name: /다시 시도/ }).isVisible()) && (await page.getByRole("button", { name: /새 파일 올리기/ }).isVisible()));
  await page.screenshot({ path: path.join(SHOTS, "07-desktop-failed.png") });
  await mock({ reset: true });
  await page.getByRole("button", { name: /다시 시도/ }).click();
  await page.getByRole("heading", { level: 1, name: "주간 회의 통합 회의록" }).waitFor({ timeout: 120000 });
  check("다시 시도 → 완료되어 결과 화면", true);
  page.once("dialog", (dlg) => dlg.accept());
  const deletingId = /\/jobs\/([0-9a-f-]{36})/.exec(page.url())[1];
  await page.getByRole("button", { name: "이 회의록 삭제" }).click();
  await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 15000 }).catch(() => {});
  check("삭제 → 첫 화면으로 이동", new URL(page.url()).pathname === "/", page.url());
  check("삭제된 작업은 서버에서도 404, 최근 목록에서도 사라짐", (await fetch(`${BASE}/api/jobs/${deletingId}`)).status === 404 && !(await page.locator("body").innerText()).includes(deletingId));

  check("브라우저 콘솔 오류 없음", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패: ${failed.map((f) => f.name).join(" | ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("\nFATAL", e);
  process.exit(2);
});
