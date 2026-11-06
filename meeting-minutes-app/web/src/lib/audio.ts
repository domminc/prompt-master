import { FFFSType, FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { AUDIO_PROFILE } from "../../../shared/limits";

// 브라우저 안에서 영상/음성 → 가벼운 오디오(모노 16kHz 32kbps MP3)로 변환한다.
//  - 200MB 영상도 서버로 올리지 않고, 소리만 시간당 약 14MB 로 줄여 올린다.
//  - Whisper API 의 25MB 제한과 Workers 에 ffmpeg 가 없다는 문제를 한꺼번에 해결한다.
//  - 원본 파일은 WORKERFS 로 "마운트"만 해서 메모리에 통째로 복사하지 않는다.
// ffmpeg-core.wasm(약 30MB)은 최초 1회만 내려받고 브라우저 캐시에 남는다.

const CORE_VERSION = "0.12.10";
const CORE_BASE =
  (import.meta.env.VITE_FFMPEG_CORE_BASE as string | undefined) ??
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

export type AudioErrorKind = "unsupported" | "no-audio" | "failed" | "cancelled";
export class AudioExtractError extends Error {
  constructor(
    message: string,
    public readonly kind: AudioErrorKind,
  ) {
    super(message);
  }
}

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let cancelled = false;

async function getFFmpeg(onEngineProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (instance) return instance;
  if (loading) return loading;
  loading = (async () => {
    if (typeof WebAssembly === "undefined") {
      throw new AudioExtractError("이 브라우저는 오디오 변환을 지원하지 않아요. 최신 Chrome, Safari, Edge 로 열어 주세요.", "unsupported");
    }
    try {
      const ff = new FFmpeg();
      const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript");
      const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm", true, ({ received, total }) => {
        if (total > 0) onEngineProgress?.(Math.min(1, received / total));
      });
      await ff.load({ coreURL, wasmURL });
      instance = ff;
      return ff;
    } catch (e) {
      if (e instanceof AudioExtractError) throw e;
      throw new AudioExtractError("변환 엔진을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.", "failed");
    }
  })().finally(() => {
    loading = null; // 실패해도 다음 시도에서 다시 불러올 수 있게
  });
  return loading;
}

export interface ExtractCallbacks {
  /** 변환 엔진(wasm) 내려받기 진행률 0..1 — 최초 1회만 호출된다 */
  onEngineProgress?: (ratio: number) => void;
  /** 오디오 변환 진행률 0..1 */
  onProgress?: (ratio: number) => void;
}

export async function extractAudio(file: File, cb: ExtractCallbacks = {}): Promise<Blob> {
  cancelled = false;
  const ff = await getFFmpeg(cb.onEngineProgress);
  const ext = (/\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? ".bin").toLowerCase();
  const mountPoint = "/input";
  const inputName = `in${ext}`;
  const outName = "out.mp3";

  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 60) logs.shift();
  };
  const onProgress = ({ progress }: { progress: number }) => cb.onProgress?.(Math.min(1, Math.max(0, progress)));
  ff.on("log", onLog);
  ff.on("progress", onProgress);

  try {
    await ff.createDir(mountPoint);
    await ff.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: file }] }, mountPoint);
    const code = await ff.exec([
      "-i", `${mountPoint}/${inputName}`,
      "-vn", "-map", "0:a:0",
      "-ac", String(AUDIO_PROFILE.channels),
      "-ar", String(AUDIO_PROFILE.sampleRate),
      "-c:a", "libmp3lame", "-b:a", AUDIO_PROFILE.bitrate,
      // 서버가 프레임 경계로 조각을 자를 수 있도록 태그·Xing 헤더 없는 순수 CBR MP3 로 만든다
      "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1",
      "-y", outName,
    ]);
    if (cancelled) throw new AudioExtractError("변환을 취소했어요.", "cancelled");
    if (code !== 0) {
      const noAudio = logs.some((l) => /matches no streams|does not contain any stream|Output file does not contain/i.test(l));
      throw new AudioExtractError(
        noAudio
          ? "이 파일에는 소리(오디오 트랙)가 없어요."
          : "오디오를 추출하지 못했어요. 파일이 손상됐거나 지원하지 않는 형식일 수 있어요.",
        noAudio ? "no-audio" : "failed",
      );
    }
    const data = await ff.readFile(outName);
    if (typeof data === "string" || data.length < 1024) {
      throw new AudioExtractError("변환 결과가 비어 있어요. 녹음에 소리가 없는지 확인해 주세요.", "no-audio");
    }
    return new Blob([data as BlobPart], { type: "audio/mpeg" });
  } catch (e) {
    if (e instanceof AudioExtractError) throw e;
    if (cancelled) throw new AudioExtractError("변환을 취소했어요.", "cancelled");
    throw new AudioExtractError(
      "이 기기에서 변환하지 못했어요. 파일이 크다면 메모리가 부족했을 수 있어요. PC 에서 시도하거나 파일을 나눠서 올려 보세요.",
      "failed",
    );
  } finally {
    if (instance === ff) {
      ff.off("log", onLog);
      ff.off("progress", onProgress);
      try {
        await ff.unmount(mountPoint);
        await ff.deleteDir(mountPoint);
        await ff.deleteFile(outName);
      } catch {
        /* 취소로 이미 종료된 경우 */
      }
    }
  }
}

/** 진행 중인 변환을 중단한다 (엔진은 다음에 다시 불러온다) */
export function cancelExtraction(): void {
  if (!instance) return;
  cancelled = true;
  instance.terminate();
  instance = null;
}

/** 미디어 길이(ms)를 빠르게 읽는다. 읽지 못하면 null (예상 소요 시간 표시용일 뿐이다). */
export function probeDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(file.name.toLowerCase().endsWith(".mp4") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null);
    };
    el.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    el.src = url;
  });
}
