import type { Segment } from "../../shared/types";

/** Whisper verbose_json 의 segment (필요한 필드만) */
export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

// 무음/잡음 구간에서 Whisper 가 학습 데이터의 자막 문구를 지어내는 대표 사례.
// 근거 신뢰도가 낮을 때(no_speech_prob 가 어느 정도 높을 때)만 버린다.
const HALLUCINATION_PHRASES =
  /(시청해\s?주셔서\s?감사|구독과?\s?좋아요|자막\s?제공|다음\s?영상에서\s?만나|thanks for watching|subtitles by)/i;

/**
 * 전사 결과를 정리한다: 환각 의심 구간 제거, 공백 정리, 조각 오프셋을 더해 ms 로 변환.
 * 판정 기준은 Whisper 자체의 실패 판정 휴리스틱(no_speech_prob, avg_logprob, compression_ratio)을 따른다.
 */
export function whisperToSegments(raw: WhisperSegment[], offsetMs: number): Segment[] {
  const out: Segment[] = [];
  for (const r of raw) {
    const text = (r.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const silent = (r.no_speech_prob ?? 0) > 0.85 && (r.avg_logprob ?? 0) < -1;
    const repetitive = (r.compression_ratio ?? 0) > 2.4 && (r.avg_logprob ?? 0) < -0.8;
    const boilerplate = HALLUCINATION_PHRASES.test(text) && (r.no_speech_prob ?? 0) > 0.3;
    if (silent || repetitive || boilerplate) continue;

    const startMs = Math.max(0, Math.round(offsetMs + r.start * 1000));
    const endMs = Math.max(startMs + 1, Math.round(offsetMs + r.end * 1000));
    out.push({ startMs, endMs, text });
  }
  return out;
}
