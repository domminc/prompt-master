# 회의록 AI — 녹음 파일에서 회의록과 일정까지

회의·강의 **mp4 / m4a / mp3 / wav** 를 올리면 대화록(타임스탬프) · 요약 · 핵심 결정 · 액션 아이템 · **회의 중 잡힌 일정**을 만들어 주는 반응형 웹앱입니다.
일정은 날짜가 확정되면 **Google 캘린더 추가 링크**와 **.ics 파일**로 바로 내보낼 수 있고, 회의록은 **Word(.docx) 문서**로 저장할 수 있습니다.

> 인수인계 문서(`vibe_coding_mvp_handoff.md`) 기반 MVP 구현입니다. 설계가 달라진 부분은 [아래 표](#인수인계-문서와-달라진-점)에 이유와 함께 정리했습니다.

| 스택 | |
|---|---|
| 런타임 | Cloudflare Workers + **Workflows**(긴 작업), Hono |
| DB | Neon Postgres, **Hyperdrive** 경유 (`postgres.js`) |
| 파일 | Cloudflare R2 (S3 호환 presigned URL 로 브라우저 직접 업로드) |
| 전사 | Whisper API (OpenAI 호환 — `WHISPER_BASE_URL` 로 교체 가능) |
| 요약·일정 | **Claude** (공식 SDK, 구조화 출력) — 기본 모델 `claude-opus-5-5` |
| 프론트 | React + Tailwind v4 + Vite, 한국어 UI, **Pretendard Variable** |
| 오디오 추출 | 브라우저 안에서 `ffmpeg.wasm` |

---

## 동작 흐름

```
브라우저                                   Cloudflare                          외부
 ① 파일 선택 (mp4 등, ≤200MB)
 ② ffmpeg.wasm 으로 소리만 추출 ─ 모노 16kHz 32kbps MP3 (1시간 ≈ 14MB). 원본은 서버로 안 감
 ③ POST /api/uploads ───────────────────▶ 검증 → jobs(queued) → R2 presigned PUT URL
 ④ PUT (R2 로 직접 업로드, Worker 미경유) ─▶ R2  uploads/{jobId}/audio.mp3
 ⑤ POST /api/uploads/:id/complete ──────▶ R2 객체 존재·형식 검증 → transcribing → Workflow 시작
                                           ┌ Workflow (단계마다 재시도·영속화) ───────────────┐
                                           │ plan  : MP3 프레임 경계로 10분 단위 조각 계획      │
                                           │ 조각별: R2 Range 읽기 → 프레임 경계 절단 ───────────▶ Whisper
                                           │         → transcript_segments 저장 (조각 단위 교체) │
                                           │ 요약  : 4k~12k자 청크별 추출(map) ──────────────────▶ Claude
                                           │         → 통합(reduce) → 날짜·중복 후처리 → completed │
                                           └─────────────────────────────────────────────────┘
 ⑥ GET /api/jobs/:id 폴링 ◀──────────────  상태·진행률 / 완료되면 대화록+요약+일정
 ⑦ 결과 화면: 플레이어 · 대화록(클릭 시 이동) · 요약 · 일정 · SRT/TXT/MD/JSON/ICS
```

### 휴대폰 녹음 파일
- **m4a 를 그대로 올리면 됩니다.** 아이폰 음성 메모(압축·무손실 모두), 안드로이드 녹음기의 m4a 를 지원합니다. 브라우저가 알려 주는 MIME 은 기기마다 달라서(`audio/x-m4a`, `audio/mp4`, `audio/mp4a-latm`, 빈 값…) **확장자(`.mp3 .wav .m4a .mp4`)만 기준**으로 삼습니다.
- 지원하지 않는 확장자(`.3gp`, `.amr`, `.aac`, `.ogg` 등)는 올리는 즉시 안내 문구가 나옵니다. 녹음 앱 설정에서 m4a/mp3 로 저장하거나 변환해서 올려 주세요.
- 아이폰은 음성 메모 앱에서 *공유 → 파일에 저장* 으로 저장한 뒤, 웹앱의 파일 선택에서 *파일* 앱의 해당 항목을 고르는 방식이 일반적입니다.

### Word(.docx) 회의록
결과 화면 상단의 **`Word로 저장`** 버튼(또는 `내려받기 → 회의록 + 대화록 (Word)`)으로 받습니다. API: `GET /api/jobs/:id/export?format=docx` (대화록 부록 포함은 `&transcript=1`).

| 구성 (A4 세로, 여백 2cm) | 내용 |
|---|---|
| 제목 + 정보 표 | 회의 제목, 회의일, 녹음 길이, 원본 파일명 |
| 1. 한눈에 보기 | 요약 |
| 2. 핵심 결정사항 | 글머리 목록 |
| 3. 일정 | 표: 날짜·시간·일정·장소/참석자·확신도 (원문 표현 포함, 불확실한 일정은 강조) |
| 4. 액션 아이템 | 표: 할 일·담당자·기한·우선순위 |
| 5. 미해결 질문 | 글머리 목록 |
| 부록. 대화록 (선택) | `[HH:MM:SS]` + 발언, 새 쪽에서 시작 |

- 실제 Word **제목 스타일(제목 1)** 을 써서 탐색 창·목차에 잡히고, 표는 쪽이 넘어가도 머리글 행이 반복되며 행이 쪽 사이에서 잘리지 않습니다. 바닥글에 `쪽 / 전체 쪽`이 들어갑니다.
- **글꼴은 Pretendard** 로 지정돼 있습니다. 열어 보는 PC 에 Pretendard 가 설치돼 있지 않으면 Word 가 대체 글꼴로 보여 줍니다(글꼴을 문서에 내장하지는 않았습니다).
- 요약본과 대화록 포함본은 R2 에 따로 캐시됩니다(`exports/{jobId}/meeting.docx`, `meeting-full.docx`).

### 일정 체크는 이렇게 동작합니다
- Claude 가 **앞으로 잡힌 일정**(다음 회의, 마감, 리뷰, 행사…)만 뽑아 `title / date / time / location / attendees / 원문 표현 / 확신도 / 근거 시각`으로 구조화합니다.
- **"다음 주 화요일"을 모델이 요일 계산하지 않습니다.** 회의 날짜 기준 달력표(이번 주·다음 주·월말·28일 날짜표)를 프롬프트에 넣고 *찾게* 합니다. 그 뒤 코드가 한 번 더 검증합니다(존재하지 않는 날짜 제거, 회의일보다 과거면 `확인 필요`, 중복 병합, 날짜순 정렬).
- 날짜를 특정하지 못하면(`조만간`) **날짜 미정**으로 표시하고 캘린더 버튼을 막습니다. 종료 시각 언급이 없으면 화면에는 시작 시각만 보이고, 캘린더에는 1시간 일정으로 들어갑니다.
- **회의 날짜**(업로드 화면)가 기준일입니다. 기본값은 파일 수정일이며 직접 고칠 수 있습니다. 시간대는 한국 표준시(`Asia/Seoul`) 고정입니다.

---

## 인수인계 문서와 달라진 점

| 인수인계 문서 | 이 구현 | 이유 |
|---|---|---|
| 원본을 R2 에 올리고 **서버가 Whisper 로 전사** | **브라우저에서 소리만 추출**(ffmpeg.wasm)해 올림 | Whisper API 는 파일당 **25MB 제한**이고 Workers 에는 ffmpeg 가 없어서, 200MB 영상은 문서의 흐름으로는 전사가 안 됩니다. 오디오만 올리면 모바일 데이터도 아낍니다. |
| 16MB 이하는 Worker 직접 업로드 | 항상 presigned URL (R2 키가 없는 **로컬 개발**에서만 Worker 경유) | 추출 오디오가 작아 경로를 하나로 단순화 |
| 업로드 후 Worker 가 한 번에 처리 | **Cloudflare Workflows** 로 단계 분리 | 문서 §13 의 권고. 조각 단위 재시도, 재시도 시 끝난 전사 재사용 |
| 긴 오디오는 청크 처리 | 전사는 **MP3 프레임 경계로 10분 조각**, 요약은 글자 수 청크 + 통합 | 디코딩 없이 Range 읽기만으로 조각이 독립 MP3 가 됨 (`worker/lib/mp3.ts`) |
| LLM JSON 파싱 실패 시 재요청 | **구조화 출력**(스키마 강제) + 후처리 | 파싱 실패 자체를 없앰 |
| `LLM_API_KEY` | `ANTHROPIC_API_KEY` | 공식 SDK 표준 이름 |
| jobs 스키마 | `meeting_date, duration_ms, progress_done/total` 추가, 세그먼트에 `chunk_index` | 일정 기준일, 진행률, 조각 단위 재시도 |
| 내보내기 SRT/TXT/MD/JSON | **+ DOCX(Word), ICS(일정)**, 첫 요청 때 만들어 `exports/{jobId}/` 에 캐시 | 문서 작성·일정 기능 |
| (없음) | 재시도·삭제·최근 목록·재생 속도 | 실패 복구, 민감한 회의 내용 삭제, 로그인 없는 앱의 재방문 |

---

## 로컬 실행

필요: Node 22+, Postgres(로컬 또는 Neon), (테스트용) `ffmpeg`.

```bash
npm install
cp .dev.vars.example .dev.vars        # WHISPER_API_KEY, ANTHROPIC_API_KEY 입력
createdb meeting                      # 또는 Neon 개발 브랜치 사용
DATABASE_URL=postgres://localhost/meeting npm run db:migrate
npm run build                         # dist/client 생성 (wrangler 가 정적 파일로 서빙)
npm run dev:worker                    # http://127.0.0.1:8787  (Worker + R2/Workflows 로컬 에뮬레이션)
```

- 로컬 Postgres 주소는 `wrangler.jsonc` 의 `hyperdrive[0].localConnectionString`(기본 `postgres://postgres:postgres@127.0.0.1:5432/meeting`). 다른 곳을 쓰려면 환경변수 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 로 덮어씁니다.
- 프론트 코드를 고치며 개발하려면 다른 터미널에서 `npm run dev:web` (http://localhost:5173, `/api` 는 8787 로 프록시).
- R2 키(`R2_*`)를 비워 두면 로컬 개발용으로 Worker 가 업로드를 대신 R2 바인딩에 저장합니다.

## 배포

1. **Neon**: 프로젝트 생성 → *직접(non-pooled)* 연결 문자열 복사 → `DATABASE_URL=... npm run db:migrate`
2. **R2**: 버킷 생성(`meeting-minutes`). 브라우저가 직접 올리므로 **CORS 설정 필수**:
   ```json
   [{ "AllowedOrigins": ["https://<배포-도메인>"], "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```
   R2 → *API 토큰 관리* 에서 해당 버킷의 **Object Read & Write** 토큰을 만들어 Access Key ID / Secret / Account ID 를 확보합니다.
3. **Hyperdrive** — ⚠️ **캐시를 꺼야 합니다.** 기본값은 읽기 쿼리를 수십 초 캐시해서, 폴링하는 작업 상태가 늦게 갱신됩니다.
   ```bash
   npx wrangler hyperdrive create meeting-db --connection-string="postgres://..." --caching-disabled
   ```
   출력된 `id` 를 `wrangler.jsonc` 의 `hyperdrive[0].id` 에 넣습니다.
4. **비밀 값** 등록 (코드·저장소에 넣지 않습니다):
   ```bash
   npx wrangler secret put WHISPER_API_KEY
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put R2_ACCOUNT_ID
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
5. `npm run deploy`

### 환경 변수
| 이름 | 종류 | 설명 |
|---|---|---|
| `WHISPER_API_KEY` | secret | 전사 API 키 |
| `ANTHROPIC_API_KEY` | secret | Claude API 키 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secret | presigned URL 서명용 (R2 *바인딩*과는 별개) |
| `R2_BUCKET_NAME` | var | 버킷 이름 |
| `WHISPER_BASE_URL`, `WHISPER_MODEL` | var | 기본 OpenAI `whisper-1`. Whisper 호환 서비스로 교체 가능(구간 타임스탬프 `verbose_json` 지원 필요) |
| `LLM_MODEL` | var | 기본 `claude-opus-5-5`. 비용을 줄이려면 `claude-sonnet-5-5`, `claude-haiku-5-5` 등으로 변경 |
| `ANTHROPIC_BASE_URL` | var(선택) | Cloudflare AI Gateway 등을 거칠 때 |
| `CHUNK_SECONDS` | var | 전사 조각 길이, 기본 600(60~1200) |
| `LLM_CHUNK_CHARS` | var | 요약 청크 글자 수, 기본 12000(4000~40000) |

---

## 테스트

```bash
npm run typecheck && npm test                      # 단위 테스트 (SRT/ICS/날짜표/청킹/MP3 분할/재시도/후처리/presign)
```
백엔드·브라우저 전체 흐름은 가짜 Whisper/Claude 서버(`scripts/dev/mock-ai.mjs`)로 돌립니다 — **요청·응답 배관**을 검증하는 용도이고 AI 품질을 평가하지는 않습니다.
```bash
# 준비: 로컬 Postgres + 스키마, .dev.vars 를 mock 으로 (WHISPER_BASE_URL=http://127.0.0.1:9100/v1, ANTHROPIC_BASE_URL=http://127.0.0.1:9100, CHUNK_SECONDS=60, LLM_CHUNK_CHARS=4000)
npm run build && npm run mock:ai &   npm run dev:worker &
npm run smoke                          # API 63개 점검: 업로드·조각 전사·요약·내보내기·실패/재시도/삭제
npm i -D playwright && npx playwright install chromium
npm run e2e:browser                    # 실제 Chromium 57개 점검: ffmpeg.wasm 변환·업로드·결과 화면·모바일 레이아웃
PRESIGN_CROSSCHECK_PYTHON=/path/to/python npm test   # (선택) botocore 와 presigned 서명 비교 (boto3, freezegun 필요)
```

---

## ⚠️ 운영 전에 꼭 알아 둘 것

1. **로그인이 없어 누구나 처리를 일으킬 수 있습니다.** Whisper·Claude 는 사용량 과금이므로 공개 URL 로 두면 비용이 새어 나갈 수 있습니다. 코드는 건드리지 않고 **Cloudflare Zero Trust → Access** 로 도메인 전체를 보호하거나, WAF *Rate limiting* 규칙으로 `POST /api/uploads` 를 제한하세요.
2. 작업 주소(UUID)가 곧 열람 권한입니다(추측 불가능한 링크). 회의 내용이 민감하다면 위 Access 보호를 권장하고, 결과 화면의 **삭제**로 녹음·대화록·요약을 즉시 지울 수 있습니다.
3. 회의 음성은 Whisper 서비스와 Claude API 로 전송됩니다. 사내 보안 정책을 확인하세요.

## 검증 범위와 알려진 한계

**검증함**: 단위 89개(선택 실행 2개 포함: botocore 교차검증, docx 샘플 저장), 로컬 `workerd`+Postgres(Hyperdrive)+R2+Workflows 위 백엔드 69개, Chromium(데스크톱·iPhone 13 크기 에뮬레이션) 61개 — 한글 파일명 업로드/다운로드, 소리 없는 영상 거름, 원본 대신 추출 오디오만 업로드, 조각 경계 정확도(조각을 이어 붙이면 원본과 바이트 동일), 실패→재시도 시 중복 없음, presigned 서명(botocore 일치), **Word 문서**(스킬의 OOXML 스키마 검증 통과, pandoc 으로 읽힘, LibreOffice 렌더링 확인, workerd 에서 생성·R2 캐시, 브라우저 다운로드), **폰 녹음 형식**(아이폰 m4a 압축·무손실(ALAC), 안드로이드식 MIME `audio/mp4a-latm`·`octet-stream`·빈 값, 1시간 28MB m4a → 변환·업로드 16초, 3시간 167MB m4a → 63초, 데스크톱 Chromium 전체 메모리 합계 최대 약 1.2GB).

**검증하지 못함 — 배포 후 직접 확인하세요**
- 실제 Cloudflare 배포, 실제 R2 로의 브라우저 직접 업로드(CORS·토큰 권한), 실제 Hyperdrive/Neon 연결
- **Microsoft Word 에서 직접 열어 보지는 못했습니다.** 규격 검증·LibreOffice·pandoc 으로만 확인했습니다. 첫 문서는 Word 에서 열어 서식(표 너비, 쪽 번호, 글꼴)을 한 번 확인하세요. 한글·숫자 사이 자동 간격은 Word 기본값 그대로라 "2026년"처럼 미세한 간격이 보일 수 있습니다(문단 설정 → 아시아 언어 문자 단위에서 끌 수 있음).
- **Workers 요금제**: 무료 플랜은 요청·단계당 CPU 시간 제한이 매우 짧아(문서 기준 10ms) 전사 조각 처리나 Word 생성(대화록 3,000문장 기준 로컬 약 0.3초)이 걸릴 수 있습니다. 로컬에서는 CPU 시간을 측정하지 못했으니 **유료 플랜에서 시작**하는 것을 권장합니다.
- **실제 Whisper·Claude 응답 품질**: 한국어 전사 정확도, 일정·날짜 추출 정확도는 *실제 회의 녹음 몇 건으로 먼저 확인*하세요. (문서 §13: 전사 품질이 낮으면 요약도 나빠집니다.) 일정은 `확신도` 와 `원문 표현`을 같이 보여 주는 것으로 오류를 눈에 띄게 했지만, 틀릴 수 있습니다.
- **실제 iOS Safari / Android Chrome**: 데스크톱 Chromium 만 확인했습니다. 폰에서의 변환 속도·메모리는 측정하지 못했고(위 시간·메모리 수치는 데스크톱 기준), 대용량 파일은 기기 메모리 부족으로 실패할 수 있어 안내 문구를 넣었습니다. 1~2시간 분량 m4a 로 먼저 시험해 보세요.

**한계**
- 화자 분리, 일정 충돌 확인(본인 캘린더 연동), 다국어 번역은 범위 밖입니다. "일정 체크"는 *대화에서 일정을 찾아 캘린더로 내보내는 것*까지 구현했습니다.
- 전사 조각 경계(10분)에서 단어 하나가 잘릴 수 있습니다.
- 변환 엔진(`ffmpeg-core.wasm`, 약 30MB)은 최초 1회 jsdelivr CDN 에서 내려받습니다. 사내망이 CDN 을 막으면 `VITE_FFMPEG_CORE_BASE` 로 자체 호스팅 주소를 지정하세요(Workers 정적 파일은 파일당 25MiB 제한이라 R2 등에 두어야 합니다).
- 모델이 안전 분류기로 응답을 거부하면 `요약 실패` 로 안내합니다(서버측 fallback 은 쓰지 않았습니다).
