import { describe, expect, it, vi } from "vitest";
import { createConversationParticipationValidator, CONVERSATION_PARTICIPATION_VALIDATOR_MODEL } from "./conversation-participation-validator.js";
import type { ConversationProviderClient } from "./conversation-provider-client.js";

const turns = [{ id: 1, scopeId: "g:c", messageId: "1", authorSource: "discord-participant" as const, authorId: "u", authorIsBot: false, text: "What do you think?", eventTs: "2026-01-01T00:00:00.000Z", replyTo: null }];
const primary = { decision: "speak" as const, baselineDecision: "speak" as const, judgmentClass: "definitive" as const, semanticMargin: 0.4, priorApplied: false, confidence: 0.8, chunks: ["I agree."] };
const valid = JSON.stringify({ schema: "hent_ai.conversation_participation.validator.v1", missedOpportunity: 0.1, interruption: 0.1, confidence: 0.9, priorDelta: 0.01, rationale: "The contribution was timely and grounded." });

describe("conversation participation validator", () => {
  it("uses the fixed independent validator model and omits persona, IDs, and prior audit data", async () => {
    const client: ConversationProviderClient = { complete: vi.fn(async () => ({ kind: "ok" as const, content: valid })) };
    const result = await createConversationParticipationValidator({ client }).validate({ turns, primary, firstDeliveryDisposition: "delivered" });

    expect(result).toMatchObject({ kind: "valid" });
    expect(client.complete).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ model: CONVERSATION_PARTICIPATION_VALIDATOR_MODEL }));
    const prompt = vi.mocked(client.complete).mock.calls[0]?.[0];
    expect(prompt).toBeDefined();
    expect(prompt!.user).not.toContain("persona");
    expect(prompt!.user).not.toContain("scopeId");
    expect(prompt!.user).not.toContain("priorDelta");
  });

  it("performs at most one bounded repair and fails closed", async () => {
    const client: ConversationProviderClient = { complete: vi.fn().mockResolvedValue({ kind: "ok" as const, content: "not JSON" }) };
    const result = await createConversationParticipationValidator({ client }).validate({ turns, primary, firstDeliveryDisposition: "not_applicable" });

    expect(client.complete).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "invalid" });
  });
});
