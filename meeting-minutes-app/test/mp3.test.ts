import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Mp3Error, parseFrameHeader, planMp3Chunks, readMp3Info, sliceMp3Chunk } from "../worker/lib/mp3";

const dir = mkdtempSync(path.join(tmpdir(), "mp3test-"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });

// 앱이 브라우저에서 만드는 것과 같은 프로파일: 모노 16kHz 32kbps CBR, 태그·Xing 헤더 없음
const APP_PROFILE = ["-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-write_xing", "0", "-id3v2_version", "0", "-map_metadata", "-1"];
const sine = (sec: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`];

let appMp3 = "";
beforeAll(() => {
  appMp3 = path.join(dir, "app.mp3");
  ff([...sine(125), ...APP_PROFILE, appMp3]);
});

/** 서버(Workflow)가 하는 일을 그대로 재현: R2 Range 읽기 → 프레임 경계로 자르기 */
function splitLikeWorker(file: Buffer, chunkSeconds: number) {
  const info = readMp3Info(new Uint8Array(file.subarray(0, 65536)), file.length);
  const plans = planMp3Chunks(info, chunkSeconds);
  const chunks = plans.map((p) => sliceMp3Chunk(new Uint8Array(file.subarray(p.start, p.start + p.readLength)), p, info));
  return { info, plans, chunks };
}

function probeDuration(buf: Uint8Array): number {
  const f = path.join(dir, `probe-${Math.random().toString(36).slice(2)}.mp3`);
  writeFileSync(f, buf);
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString();
  return Number(out.trim());
}

describe("MP3 헤더 파싱", () => {
  it("앱 프로파일의 프레임 정보를 읽는다 (MPEG-2 L3, 16kHz, 32kbps → 144바이트 / 36ms)", () => {
    const file = readFileSync(appMp3);
    const h = parseFrameHeader(file, readMp3Info(file.subarray(0, 65536), file.length).firstFrameOffset)!;
    expect(h).toMatchObject({ sampleRate: 16000, bitrate: 32000, samplesPerFrame: 576, frameLength: 144, padding: 0 });
  });
  it("길이를 실제와 근접하게 계산한다", () => {
    const file = readFileSync(appMp3);
    const info = readMp3Info(file.subarray(0, 65536), file.length);
    expect(Math.abs(info.durationMs - 125_000)).toBeLessThan(200);
    expect(Math.abs(info.durationMs / 1000 - probeDuration(file))).toBeLessThan(0.3);
  });
  it("MP3 가 아닌 데이터는 Mp3Error", () => {
    expect(() => readMp3Info(new Uint8Array(5000).fill(7), 5000)).toThrow(Mp3Error);
    expect(() => readMp3Info(new Uint8Array(100), 100)).toThrow(Mp3Error);
  });
  it("VBR MP3 는 거부한다", () => {
    // 소음 5초 + 무음 5초를 VBR 로 인코딩하면 프레임 비트레이트가 달라진다
    const g = path.join(dir, "vbr2.mp3");
    ff(["-f", "lavfi", "-i", "anoisesrc=d=5:c=pink", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-filter_complex", "[0][1]concat=n=2:v=0:a=1,atrim=0:10", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "6", "-write_xing", "0", "-id3v2_version", "0", g]);
    const file = readFileSync(g);
    expect(() => readMp3Info(file.subarray(0, 65536), file.length)).toThrow(/VBR|가변/);
  });
  it("ID3v2 태그가 앞에 붙어 있어도 첫 프레임을 찾는다", () => {
    const f = path.join(dir, "id3.mp3");
    ff([...sine(30), ...APP_PROFILE.filter((_, i, a) => a[i - 1] !== "-id3v2_version" && a[i] !== "-id3v2_version"), "-id3v2_version", "3", "-metadata", "title=테스트", f]);
    const file = readFileSync(f);
    expect(file.subarray(0, 3).toString()).toBe("ID3");
    const info = readMp3Info(file.subarray(0, 65536), file.length);
    expect(info.firstFrameOffset).toBeGreaterThan(10);
    expect(Math.abs(info.durationMs - 30_000)).toBeLessThan(300);
  });
});

describe("조각 나누기", () => {
  it("30초 단위: 125초 → 4개 + 5초 꼬리 = 5조각, 시작 시각이 30초 간격", () => {
    const { plans } = splitLikeWorker(readFileSync(appMp3), 30);
    expect(plans).toHaveLength(5);
    expect(plans.map((p) => Math.round(p.offsetMs / 100) / 10)).toEqual([0, 30, 60, 90, 120]);
    expect(plans.filter((p) => p.isLast)).toHaveLength(1);
  });
  it("조각을 이어 붙이면 원본과 바이트 단위로 같다 (빠지거나 겹치는 구간 없음)", () => {
    const file = readFileSync(appMp3);
    const { info, chunks } = splitLikeWorker(file, 30);
    const joined = Buffer.concat(chunks);
    expect(joined.equals(file.subarray(info.firstFrameOffset))).toBe(true);
  });
  it("각 조각은 독립적으로 디코딩되고 길이 합이 전체와 같다", () => {
    const { chunks } = splitLikeWorker(readFileSync(appMp3), 30);
    const durations = chunks.map(probeDuration);
    expect(Math.abs(durations[0]! - 30)).toBeLessThan(0.2);
    expect(Math.abs(durations.reduce((a, b) => a + b, 0) - 125)).toBeLessThan(0.5);
  });
  it("마지막 꼬리가 2초 미만이면 앞 조각에 합친다", () => {
    const f = path.join(dir, "tail.mp3");
    ff([...sine(61), ...APP_PROFILE, f]); // 30 + 30 + 1초
    const file = readFileSync(f);
    const { plans, chunks } = splitLikeWorker(file, 30);
    expect(plans).toHaveLength(2);
    expect(probeDuration(chunks[1]!)).toBeGreaterThan(30.5);
  });
  it("조각 하나보다 짧은 파일은 1조각", () => {
    const f = path.join(dir, "short.mp3");
    ff([...sine(8), ...APP_PROFILE, f]);
    const file = readFileSync(f);
    const { plans, chunks } = splitLikeWorker(file, 600);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ isLast: true, offsetMs: 0 });
    expect(chunks[0]!.length).toBe(file.length);
  });
  it("패딩 때문에 프레임 길이가 일정하지 않은 44.1kHz/128kbps 도 경계가 정확하다", () => {
    const f = path.join(dir, "cd.mp3");
    ff([...sine(95), "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", "-id3v2_version", "0", f]);
    const file = readFileSync(f);
    const { info, chunks } = splitLikeWorker(file, 30);
    expect(info.header.frameLength).not.toBe(info.avgFrameLength); // 패딩이 섞인 스트림
    expect(Buffer.concat(chunks).equals(file.subarray(info.firstFrameOffset))).toBe(true);
    for (const c of chunks) expect(probeDuration(c)).toBeGreaterThan(1);
  });
  it("10분 기본 설정에서 시간당 약 14MB 오디오도 6조각으로 나뉜다 (계산만)", () => {
    const info = { firstFrameOffset: 0, header: { versionBits: 2, bitrate: 32000, sampleRate: 16000, padding: 0, frameLength: 144, samplesPerFrame: 576 }, avgFrameLength: 144, frameCount: Math.floor((3600 * 16000) / 576), durationMs: 3_600_000, totalSize: Math.floor((3600 * 16000) / 576) * 144 };
    const plans = planMp3Chunks(info, 600);
    expect(plans).toHaveLength(6);
    expect(plans[0]!.wantedLength).toBeLessThan(3_000_000); // Whisper 25MB 제한의 1/8 수준
  });
});
