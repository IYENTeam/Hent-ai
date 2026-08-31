import { describe, expect, it } from "vitest";
import { CANONICAL_EMOTIONS } from "@hent-ai/shared";
import {
  SEMANTIC_CONTROLLED_VOCABULARIES,
  SEMANTIC_REFERENCE_PATHS,
  assertSemanticGenerationPlan,
  buildSemanticImagePrompt,
  createSemanticGenerationPlan,
} from "./semantic-plan.js";

describe("semantic generation plan", () => {
  it("defines exactly 100 stable filenames, unique tuples, ten values per axis, and balanced emotions", () => {
    const plan = createSemanticGenerationPlan();
    expect(plan.items).toHaveLength(100);
    expect(plan.references).toEqual(SEMANTIC_REFERENCE_PATHS);
    expect(plan.items[0]).toMatchObject({ id: "000", batch: 0, filename: "sorry-000.png" });
    expect(plan.items[99]).toMatchObject({ id: "099", batch: 9, filename: "focused-099.png" });
    for (const vocabulary of Object.values(SEMANTIC_CONTROLLED_VOCABULARIES)) expect(vocabulary).toHaveLength(10);

    expect(new Set(plan.items.map((item) => item.filename))).toHaveLength(100);
    expect(new Set(plan.items.map((item) => [item.gesture, item.expression, item.background, item.clothing].join("|")))).toHaveLength(100);
    expect(CANONICAL_EMOTIONS.map((emotion) => plan.items.filter((item) => item.emotion === emotion).length)).toEqual([17, 17, 17, 17, 16, 16]);
    for (const axis of ["gesture", "expression", "background", "clothing"] as const) {
      expect(SEMANTIC_CONTROLLED_VOCABULARIES[axis].map((value) => plan.items.filter((item) => item[axis] === value).length)).toEqual(Array(10).fill(10));
    }
    expect(() => assertSemanticGenerationPlan(plan)).not.toThrow();
  });

  it("rejects drift from the deterministic contract", () => {
    const plan = structuredClone(createSemanticGenerationPlan());
    plan.items[0]!.filename = "changed.png";
    expect(() => assertSemanticGenerationPlan(plan)).toThrow("invalid filename");
  });

  it("builds an identity-preserving prompt from all planned axes", () => {
    const item = createSemanticGenerationPlan().items[0]!;
    const prompt = buildSemanticImagePrompt(item);
    expect(prompt).toContain(item.gesture);
    expect(prompt).toContain(item.expression);
    expect(prompt).toContain(item.background);
    expect(prompt).toContain(item.clothing);
    expect(prompt).toContain("all three references");
  });
});
