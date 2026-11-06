-- Neon Postgres 스키마. 여러 번 실행해도 안전하다(idempotent).
-- 실행: npm run db:migrate  (DATABASE_URL 환경변수에 Neon 직접 연결 문자열 지정)
--       또는 Neon 콘솔 SQL Editor 에 붙여 넣기.

create extension if not exists "pgcrypto";

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued'
    check (status in ('queued','uploading','transcribing','summarizing','completed','failed')),
  file_key text not null,                -- R2 키: uploads/{id}/audio.mp3 (브라우저가 추출한 오디오)
  file_name text,                        -- 사용자가 올린 원본 파일 이름 (표시용)
  mime_type text,
  size_bytes bigint,                     -- 원본 파일 크기
  language text not null default 'ko',
  meeting_date date not null default ((now() at time zone 'Asia/Seoul')::date),  -- 일정 날짜 해석 기준일
  duration_ms integer,
  progress_done integer not null default 0,    -- 전사 완료한 조각 수
  progress_total integer not null default 0,   -- 전체 조각 수
  error_message text,
  transcript text,
  summary jsonb,                         -- { title, tldr, decisions, actionItems, events, openQuestions }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transcript_segments (
  id bigserial primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  chunk_index integer not null default 0,   -- 전사 조각 번호 (재시도 시 조각 단위로 교체하기 위함)
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists transcript_segments_job_start_idx
  on transcript_segments (job_id, start_ms);

create index if not exists transcript_segments_job_chunk_idx
  on transcript_segments (job_id, chunk_index);

create index if not exists jobs_status_idx
  on jobs (status, created_at desc);
