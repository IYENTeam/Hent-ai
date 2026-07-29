import { describe, expect, it } from "vitest";
import { parseConversationParticipationPrimary, parseConversationParticipationValidator } from "./adaptive-ambient-proposal-parser.js";
import { materializeConversationParticipantContext, type ConversationParticipantRawEvent } from "./conversation-participant-context.js";

const scopeId = "discord:playground-ko:mock";

type Scenario = {
  readonly name: string;
  readonly rows: readonly ConversationParticipantRawEvent[];
  readonly anchorMessageId: string;
  readonly expectedDecision: "speak" | "observe";
  readonly expectedChunk?: string;
};

const scenarios: readonly Scenario[] = [
  {
    name: "친구들이 저녁 메뉴를 고민할 때 자연스럽게 구체적인 선택지를 보탠다",
    rows: [
      row(1, "dinner-1", "민서", "오늘 다들 뭐 먹고 싶어? 매운 건 좀 힘들어", "2026-07-29T19:00:00.000Z"),
      row(2, "dinner-2", "준호", "나도 너무 매운 건 별로. 근처에서 먹자", "2026-07-29T19:00:22.000Z", "dinner-1", "민서"),
      row(3, "dinner-3", "수빈", "국물 있는 거면 좋겠는데 딱히 생각이 안 나네", "2026-07-29T19:00:48.000Z", "dinner-2", "준호"),
    ],
    anchorMessageId: "dinner-3",
    expectedDecision: "speak",
    expectedChunk: "그럼 맵지 않은 샤브샤브 어때? 국물 있고 각자 먹고 싶은 재료 고를 수 있잖아.",
  },
  {
    name: "두 사람이 이미 약속 세부사항을 확정하는 중이면 끼어들지 않는다",
    rows: [
      row(10, "meet-1", "지우", "내일 2시에 성수역 3번 출구 맞지?", "2026-07-29T20:10:00.000Z"),
      row(11, "meet-2", "현우", "응 맞아. 내가 5분 전에 도착해서 연락할게", "2026-07-29T20:10:14.000Z", "meet-1", "지우"),
      row(12, "meet-3", "지우", "오케이 그때 봐!", "2026-07-29T20:10:26.000Z", "meet-2", "현우"),
    ],
    anchorMessageId: "meet-3",
    expectedDecision: "observe",
  },
  {
    name: "대화가 막혔고 모두가 아이디어를 찾을 때 관련 경험을 짧게 보탠다",
    rows: [
      row(20, "trip-1", "유나", "비 오는 날 부산에서 뭐 하지? 해변은 애매하겠다", "2026-07-29T21:30:00.000Z"),
      row(21, "trip-2", "도윤", "카페만 돌기엔 하루가 너무 긴데", "2026-07-29T21:30:31.000Z", "trip-1", "유나"),
      row(22, "trip-3", "유나", "실내에서 할 만한 거 아는 사람?", "2026-07-29T21:31:02.000Z", "trip-2", "도윤"),
    ],
    anchorMessageId: "trip-3",
    expectedDecision: "speak",
    expectedChunk: "영도 국립해양박물관 괜찮았어. 실내고 생각보다 볼 게 많아서 비 오는 날 반나절 보내기 좋아.",
  },
];

describe("realistic playground-ko conversation participation mocks", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const context = materializeConversationParticipantContext(scopeId, scenario.rows, scenario.anchorMessageId);
      expect(context).toMatchObject({ kind: "valid" });
      if (context.kind !== "valid") throw new Error(context.diagnostic);

      const primary = mockPrimary(scenario);
      const parsedPrimary = parseConversationParticipationPrimary(JSON.stringify(primary));
      expect(parsedPrimary).toMatchObject({ kind: "valid", proposal: { decision: scenario.expectedDecision } });
      if (parsedPrimary.kind !== "valid") throw new Error(parsedPrimary.diagnostic);
      expect(parsedPrimary.proposal.chunks).toEqual(scenario.expectedChunk ? [scenario.expectedChunk] : []);

      const validator = mockValidator(scenario.expectedDecision);
      expect(parseConversationParticipationValidator(JSON.stringify(validator))).toMatchObject({
        kind: "valid",
        proposal: scenario.expectedDecision === "speak"
          ? { missedOpportunity: 0.05, interruption: 0.1 }
          : { missedOpportunity: 0.05, interruption: 0 },
      });
      expect(context.snapshot.turns.at(-1)?.messageId).toBe(scenario.anchorMessageId);
    });
  }
});

function mockPrimary(scenario: Scenario): Record<string, unknown> {
  const speak = scenario.expectedDecision === "speak";
  return {
    schema: "hent_ai.conversation_participation.primary.v2",
    decision: scenario.expectedDecision,
    baselineDecision: scenario.expectedDecision,
    judgmentClass: "definitive",
    semanticMargin: speak ? 0.72 : -0.81,
    priorApplied: false,
    confidence: speak ? 0.91 : 0.96,
    chunks: scenario.expectedChunk ? [scenario.expectedChunk] : [],
  };
}

function mockValidator(decision: "speak" | "observe"): Record<string, unknown> {
  return {
    schema: "hent_ai.conversation_participation.validator.v1",
    missedOpportunity: 0.05,
    interruption: decision === "speak" ? 0.1 : 0,
    confidence: 0.94,
    priorDelta: 0.01,
    rationale: decision === "speak"
      ? "대화의 열린 질문에 짧고 구체적인 정보를 보태며 흐름을 방해하지 않았다."
      : "참여자들이 이미 약속을 확정해 추가 발화가 필요하지 않았다.",
  };
}

function row(id: number, messageId: string, authorId: string, text: string, eventTs: string, replyMessageId?: string, replyAuthorId?: string): ConversationParticipantRawEvent {
  return {
    id,
    scopeId,
    messageId,
    authorSource: "discord-participant",
    authorRole: "user",
    text,
    eventTs,
    metadataJson: JSON.stringify({
      discordAuthorId: authorId,
      discordAuthorBot: false,
      mentions: [],
      ...(replyMessageId && replyAuthorId ? { replyTo: { messageId: replyMessageId, authorId: replyAuthorId } } : {}),
    }),
  };
}
