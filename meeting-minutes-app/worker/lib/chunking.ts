import { formatTimestamp } from "../../shared/format";
import type { Segment } from "../../shared/types";

export interface ChunkOptions {
  /** 한 청크의 최대 글자 수. 핸드오프 문서 기준 8,000~15,000자 */
  maxChars?: number;
  /** 청크 사이에 겹쳐 넣을 줄(문장) 수 */
  overlapLines?: number;
}

export const transcriptLine = (s: Pick<Segment, "startMs" | "text">) =>
  `[${formatTimestamp(s.startMs)}] ${s.text}`;

/**
 * 세그먼트를 "[HH:MM:SS] 발화" 줄로 만들어 글자 수 기준으로 청크로 묶는다.
 * 문맥이 끊기지 않도록 이전 청크의 마지막 몇 줄을 다음 청크 앞에 겹쳐 넣는다.
 * 입력이 같으면 항상 같은 결과를 내므로 Workflow 단계가 재실행돼도 안전하다.
 */
export function buildTranscriptChunks(segments: Segment[], opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 12_000;
  const overlap = opts.overlapLines ?? 2;
  const lines = segments.map(transcriptLine);
  if (lines.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end]!.length + 1 <= maxChars)) {
      size += lines[end]!.length + 1;
      end++;
    }
    const from = chunks.length === 0 ? start : Math.max(0, start - overlap);
    chunks.push(lines.slice(from, end).join("\n"));
    start = end;
  }
  return chunks;
}
