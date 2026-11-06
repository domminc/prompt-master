import { weekdayKo } from "../../shared/calendar";
import type { LlmSummary } from "../../shared/summary-schema";
import { buildCalendarContext } from "../lib/refdates";

// 한국어 회의록 + 일정 추출 프롬프트.
// 핵심 원칙: 근거 없는 내용은 만들지 않는다 / 날짜는 직접 계산하지 말고 기준 달력에서 찾는다.

export const SYSTEM_EXTRACT = `너는 한국어 회의록을 정리하는 비서다. 입력은 회의 녹음의 음성 전사본이고, 각 줄은 "[HH:MM:SS] 발화" 형식이다.

## 공통 규칙
- 전사본에 근거가 있는 내용만 쓴다. 추측하거나 지어내지 않는다. 근거가 없으면 담당자·기한은 "미확인", 나머지 값은 null 로 둔다.
- 음성 인식 오류(동음이의어, 사람 이름 오인식)가 의심돼도 확신이 없으면 전사본 표현을 그대로 쓴다.
- 같은 내용을 중복해서 쓰지 않는다. 문장은 간결한 한국어 평서문으로 쓴다.

## 일정(events) 추출 규칙
- "앞으로 잡힌 일정"만 뽑는다: 다음 회의·미팅, 마감, 발표·리뷰, 출시, 행사, 방문 등 날짜나 시점이 언급된 미래의 일.
- 이미 끝난 일, 날짜가 전혀 언급되지 않은 막연한 계획("언젠가 하자")은 제외한다.
- 날짜는 직접 요일 계산을 하지 말고 사용자 메시지의 "기준 달력"에서 찾아 쓴다.
  - "내일", "모레", "다음 주 화요일", "이번 달 말", "다다음 주 금요일" 모두 달력표에서 해당 날짜를 찾는다.
  - 달력으로 하루로 특정할 수 없으면(예: "다음 주쯤", "조만간") date 는 null, dateText 에 원문 표현을 적는다.
- 시간은 24시간제 HH:MM. "오후 3시"는 "15:00". 오전/오후가 불분명하면 업무 시간대로 추정하되 confidence 를 "low" 로 한다. 시간 언급이 없으면 time 은 null.
- confidence: 날짜(와 시간)를 발화에서 직접 말했으면 "high", 상대 표현을 달력으로 계산했으면 "medium", 추정이 섞였으면 "low".
- dateText 에는 전사본의 날짜·시간 표현을 원문 그대로 적는다.
- evidenceTime 에는 그 일정이 언급된 줄의 타임스탬프(HH:MM:SS)를 적는다.

## 액션 아이템 규칙
- 누가·무엇을·언제까지 하기로 했는지가 드러난 것만 뽑는다. 담당자는 이름이 나온 경우만, 기한은 달력으로 확정되는 경우만 YYYY-MM-DD 로 쓰고 아니면 "미확인".
- priority: 마감이 임박했거나 다른 일의 선행 조건이면 high, 그 외 보통은 medium, 여유 있으면 low.`;

export function buildExtractUser(args: {
  transcript: string;
  meetingDate: string;
  part: number;
  partCount: number;
}): string {
  const partNote =
    args.partCount > 1
      ? `이 전사본은 긴 회의를 시간순으로 나눈 ${args.part}/${args.partCount}번째 구간이다(앞뒤 구간과 문장 몇 줄이 겹칠 수 있다). 이 구간에서 확인되는 내용만 정리하고, title 과 tldr 도 이 구간 기준으로 쓴다.`
      : "이 전사본은 회의 전체다.";
  return `<기준_달력>
${buildCalendarContext(args.meetingDate)}
</기준_달력>

<안내>
${partNote}
오늘(회의일)은 ${args.meetingDate} ${weekdayKo(args.meetingDate)}요일이다. 전사본에서 말한 "오늘·내일·다음 주"는 모두 이 날짜 기준이다.
</안내>

<전사본>
${args.transcript}
</전사본>`;
}

export const SYSTEM_MERGE = `너는 한국어 회의록을 정리하는 비서다. 같은 회의를 시간순으로 나눠 각각 정리한 부분 결과들이 주어진다. 이를 하나의 최종 회의록으로 통합한다.

- 새로운 사실을 만들지 않는다. 부분 결과에 있는 내용만 쓴다.
- title: 회의 전체를 대표하는 제목 하나. tldr: 회의 전체를 3문장 이내로.
- decisions / actionItems / events / openQuestions: 구간별로 중복된 항목은 하나로 합친다. 같은 항목이면 더 구체적인 정보(시간·장소·담당자·기한)를 가진 쪽을 남긴다.
- 뒤 구간에서 해결된 것으로 보이는 openQuestions 는 뺀다. 뒤 구간에서 번복된 결정은 최종 결정만 남긴다.
- 일정의 date, time, confidence, evidenceTime 값은 부분 결과의 값을 그대로 유지한다. 다시 계산하지 않는다.`;

export function buildMergeUser(parts: LlmSummary[], meetingDate: string): string {
  return `회의일: ${meetingDate} (${weekdayKo(meetingDate)}요일)

<부분_결과 개수="${parts.length}">
${parts.map((p, i) => `### 구간 ${i + 1}\n${JSON.stringify(p)}`).join("\n\n")}
</부분_결과>`;
}
