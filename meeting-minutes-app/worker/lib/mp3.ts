// MP3(Layer III) 프레임을 직접 읽어 "프레임 경계"에서 바이트 단위로 자른다.
//
// 왜 필요한가: Workers 에서는 ffmpeg 를 쓸 수 없고 Whisper API 는 파일당 25MB 제한이 있다.
// 브라우저가 올리는 오디오는 CBR(일정 비트레이트) MP3 이므로 프레임 길이가 일정하다.
// 따라서 R2 의 Range 읽기로 10분 단위 조각을 가져와 프레임 경계에 맞춰 잘라 보내면
// 디코딩 없이도 각 조각이 독립된 유효 MP3 가 된다.

export class Mp3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp3Error";
  }
}

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// 버전 비트: 3=MPEG1, 2=MPEG2, 0=MPEG2.5
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export interface FrameHeader {
  versionBits: number;
  /** bit/s */
  bitrate: number;
  sampleRate: number;
  padding: number;
  /** 이 프레임의 바이트 길이(패딩 포함) */
  frameLength: number;
  samplesPerFrame: number;
}

export function parseFrameHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i < 0 || i + 4 > b.length) return null;
  const b0 = b[i]!;
  const b1 = b[i + 1]!;
  const b2 = b[i + 2]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits !== 1) return null; // 예약됨 / Layer III 만 지원
  const brIdx = (b2 >> 4) & 15;
  const srIdx = (b2 >> 2) & 3;
  const padding = (b2 >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const isV1 = versionBits === 3;
  const bitrate = (isV1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[brIdx]! * 1000;
  const sampleRate = SAMPLE_RATES[versionBits]![srIdx]!;
  const samplesPerFrame = isV1 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8 * bitrate) / sampleRate) + padding;
  return { versionBits, bitrate, sampleRate, padding, frameLength, samplesPerFrame };
}

const sameStream = (a: FrameHeader, b: FrameHeader) =>
  a.versionBits === b.versionBits && a.sampleRate === b.sampleRate && a.bitrate === b.bitrate;

/** 앞쪽 ID3v2 태그를 건너뛴 오프셋 */
export function skipId3v2(b: Uint8Array): number {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const footer = (b[5]! & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footer;
  }
  return 0;
}

/**
 * from 이후 처음 나오는 "진짜" 프레임 시작 위치를 찾는다.
 * 헤더가 유효하고, 바로 다음 프레임 위치에도 같은 스트림의 유효한 헤더가 있어야 인정한다
 * (압축 데이터 안의 우연한 0xFFEx 바이트열을 거르기 위함).
 */
export function findFrame(
  buf: Uint8Array,
  from: number,
  ref?: FrameHeader,
  maxScan = 8192,
): { index: number; header: FrameHeader } | null {
  const end = Math.min(buf.length - 4, from + maxScan);
  for (let i = Math.max(0, from); i <= end; i++) {
    const h = parseFrameHeader(buf, i);
    if (!h || (ref && !sameStream(h, ref))) continue;
    const next = i + h.frameLength;
    if (next === buf.length) return { index: i, header: h }; // 파일 끝에 딱 맞는 마지막 프레임
    const n = parseFrameHeader(buf, next);
    if (n && sameStream(n, h)) return { index: i, header: h };
  }
  return null;
}

export interface Mp3Info {
  /** 첫 프레임의 파일 내 바이트 위치 */
  firstFrameOffset: number;
  header: FrameHeader;
  /** 프레임당 평균 바이트 (패딩 때문에 정수가 아닐 수 있음) */
  avgFrameLength: number;
  frameCount: number;
  durationMs: number;
  totalSize: number;
}

/** 파일 앞부분(권장 64KB)과 전체 크기로 CBR MP3 정보를 읽는다. */
export function readMp3Info(head: Uint8Array, totalSize: number): Mp3Info {
  const start = skipId3v2(head);
  if (start >= head.length) throw new Mp3Error("MP3 태그가 너무 커서 읽을 수 없습니다");
  const first = findFrame(head, start, undefined, 4096);
  if (!first) throw new Mp3Error("MP3 오디오 프레임을 찾을 수 없습니다. 올바른 오디오 파일이 아닙니다");
  const h = first.header;

  // VBR 이면 바이트 위치 ↔ 시간 환산이 틀어지므로 앞쪽 프레임으로 CBR 여부를 확인한다.
  let pos = first.index;
  for (let n = 0; n < 40; n++) {
    const cur = parseFrameHeader(head, pos);
    if (!cur) break; // 버퍼 끝에 도달
    if (!sameStream(cur, h)) throw new Mp3Error("가변 비트레이트(VBR) MP3 는 지원하지 않습니다");
    pos += cur.frameLength;
  }

  const avgFrameLength = ((h.samplesPerFrame / 8) * h.bitrate) / h.sampleRate;
  const frameCount = Math.floor((totalSize - first.index) / avgFrameLength);
  if (frameCount <= 0) throw new Mp3Error("오디오 길이가 0 입니다");
  const durationMs = Math.round((frameCount * h.samplesPerFrame * 1000) / h.sampleRate);
  return { firstFrameOffset: first.index, header: h, avgFrameLength, frameCount, durationMs, totalSize };
}

export interface Mp3Chunk {
  index: number;
  /** R2 에서 읽기 시작할 바이트 */
  start: number;
  /** 읽을 바이트 수 (끝 경계를 맞추기 위한 여유분 포함) */
  readLength: number;
  /** 이 조각이 차지해야 할 대략적인 바이트 수 (끝 경계 탐색 시작점) */
  wantedLength: number;
  isLast: boolean;
  /** 이 조각의 시작 시각(ms) — 전사 타임스탬프에 더한다 */
  offsetMs: number;
}

const END_SLACK = 4096;
/** 마지막 조각이 이보다 짧으면 앞 조각에 합친다 (Whisper 가 너무 짧은 오디오를 거부함) */
const MIN_TAIL_SECONDS = 2;

export function planMp3Chunks(info: Mp3Info, chunkSeconds: number): Mp3Chunk[] {
  const { header: h, avgFrameLength, frameCount, firstFrameOffset, totalSize } = info;
  const framesPerChunk = Math.max(1, Math.floor((chunkSeconds * h.sampleRate) / h.samplesPerFrame));
  let count = Math.ceil(frameCount / framesPerChunk);
  const tailFrames = frameCount - (count - 1) * framesPerChunk;
  if (count > 1 && (tailFrames * h.samplesPerFrame) / h.sampleRate < MIN_TAIL_SECONDS) count--;

  const startOf = (k: number) => firstFrameOffset + Math.round(k * framesPerChunk * avgFrameLength);
  const plans: Mp3Chunk[] = [];
  for (let k = 0; k < count; k++) {
    const start = startOf(k);
    const isLast = k === count - 1;
    const wantedLength = isLast ? totalSize - start : startOf(k + 1) - start;
    plans.push({
      index: k,
      start,
      wantedLength,
      readLength: isLast ? totalSize - start : wantedLength + END_SLACK,
      isLast,
      offsetMs: Math.round((k * framesPerChunk * h.samplesPerFrame * 1000) / h.sampleRate),
    });
  }
  return plans;
}

/**
 * R2 에서 읽어 온 바이트(plan.start 부터 plan.readLength)를 프레임 경계에 맞춰 잘라
 * 독립적으로 디코딩 가능한 MP3 조각으로 만든다.
 * 인접한 두 조각은 같은 위치("approxStart 이후 첫 프레임")에서 맞닿으므로 빠지거나 겹치는 구간이 없다.
 */
export function sliceMp3Chunk(buf: Uint8Array, plan: Mp3Chunk, info: Mp3Info): Uint8Array {
  const ref = info.header;
  const s = findFrame(buf, 0, ref);
  if (!s) throw new Mp3Error(`조각 ${plan.index}: 프레임 경계를 찾지 못했습니다`);
  if (plan.isLast) return buf.subarray(s.index);
  const e = findFrame(buf, plan.wantedLength, ref);
  return buf.subarray(s.index, e ? e.index : buf.length);
}
