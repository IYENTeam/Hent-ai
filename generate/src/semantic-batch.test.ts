import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSemanticItemState,
  reviewSemanticCandidate,
  runSemanticBatch,
  stageSemanticCandidate,
} from "./semantic-batch.js";
import { createSemanticGenerationPlan } from "./semantic-plan.js";

const plan = createSemanticGenerationPlan();
const fixedNow = () => "2026-08-30T00:00:00.000Z";

describe("semantic batch staging", () => {
  const dirs: string[] = [];
  async function tempSet(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "hent-semantic-batch-"));
    dirs.push(path);
    return path;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keeps successful immutable receipts after failure and resumes without regenerating them", async () => {
    const setDir = await tempSet();
    const firstGenerate = vi.fn(async (item: { id: string }) => {
      if (item.id === "002") throw new Error("provider stopped");
      return Buffer.from(`image-${item.id}`);
    });
    await expect(runSemanticBatch({
      setDir, plan, batch: 0, generate: firstGenerate,
      review: async () => ({ decision: "accepted", reason: "visual review passed" }), now: fixedNow,
    })).rejects.toThrow("provider stopped");
    expect((await inspectSemanticItemState(setDir, plan.items[0]!)).status).toBe("accepted");
    expect((await inspectSemanticItemState(setDir, plan.items[1]!)).status).toBe("accepted");

    const resumedGenerate = vi.fn(async (item: { id: string }) => Buffer.from(`image-${item.id}`));
    const result = await runSemanticBatch({
      setDir, plan, batch: 0, generate: resumedGenerate,
      review: async () => ({ decision: "accepted", reason: "visual review passed" }), now: fixedNow,
    });
    expect(resumedGenerate).toHaveBeenCalledTimes(8);
    expect(result).toEqual({ generated: 8, resumed: 2, accepted: 10, rejected: 0 });
  });

  it("resumes a staged candidate at review without making another generation call", async () => {
    const setDir = await tempSet();
    const item = plan.items[0]!;
    await stageSemanticCandidate({ setDir, item, version: 1, image: Buffer.from("pending"), createdAt: fixedNow() });
    const generate = vi.fn(async (next: { id: string }) => Buffer.from(`image-${next.id}`));
    await runSemanticBatch({
      setDir, plan, batch: 0, generate,
      review: async () => ({ decision: "accepted", reason: "passed" }), now: fixedNow,
    });
    expect(generate).toHaveBeenCalledTimes(9);
    expect((await inspectSemanticItemState(setDir, item)).status).toBe("accepted");
  });

  it("keeps rejected evidence and regenerates into a new version", async () => {
    const setDir = await tempSet();
    const item = plan.items[0]!;
    const v1 = await stageSemanticCandidate({ setDir, item, version: 1, image: Buffer.from("rejected-v1"), createdAt: fixedNow() });
    await reviewSemanticCandidate({
      setDir, item, candidate: v1,
      decision: { decision: "rejected", reason: "identity drift" }, reviewedAt: fixedNow(),
    });
    const before = await readFile(join(setDir, v1.candidatePath));
    const generate = vi.fn(async (next: { id: string }) => Buffer.from(`accepted-${next.id}`));
    await runSemanticBatch({
      setDir, plan, batch: 0, generate,
      review: async () => ({ decision: "accepted", reason: "passed" }), now: fixedNow,
    });
    expect(await readFile(join(setDir, v1.candidatePath))).toEqual(before);
    expect(await readFile(join(setDir, ".candidates", "000", "v002.png"))).toEqual(Buffer.from("accepted-000"));
  });

  it("reconciles rejected-v1 plus orphan-v2 bytes before any paid regeneration", async () => {
    const setDir = await tempSet();
    const item = plan.items[0]!;
    const v1 = await stageSemanticCandidate({ setDir, item, version: 1, image: Buffer.from("rejected-v1"), createdAt: fixedNow() });
    await reviewSemanticCandidate({
      setDir, item, candidate: v1,
      decision: { decision: "rejected", reason: "identity drift" }, reviewedAt: fixedNow(),
    });
    await expect(stageSemanticCandidate({
      setDir,
      item,
      version: 2,
      image: Buffer.from("orphan-v2"),
      createdAt: fixedNow(),
      faults: { afterCandidateBytesWritten: () => { throw new Error("crash after candidate bytes"); } },
    })).rejects.toThrow("crash after candidate bytes");

    const generate = vi.fn(async (next: { id: string }) => Buffer.from(`image-${next.id}`));
    const result = await runSemanticBatch({
      setDir, plan, batch: 0, generate,
      review: async () => ({ decision: "accepted", reason: "passed" }), now: fixedNow,
    });
    expect(generate).toHaveBeenCalledTimes(9);
    expect(generate.mock.calls.some(([generatedItem]) => generatedItem.id === item.id)).toBe(false);
    expect(result).toEqual({ generated: 9, resumed: 1, accepted: 10, rejected: 0 });
    expect(JSON.parse(await readFile(join(setDir, ".receipts", "000", "v002-candidate.json"), "utf8"))).toMatchObject({
      itemId: "000",
      version: 2,
      byteLength: Buffer.byteLength("orphan-v2"),
      recoveredFromOrphan: true,
    });
    expect(await readFile(join(setDir, item.filename))).toEqual(Buffer.from("orphan-v2"));
  });

  it.each(["afterAcceptanceIntentWritten", "afterFinalCopied"] as const)(
    "reserves hashes across a %s crash and deterministically recovers the same item",
    async (faultPoint) => {
      const setDir = await tempSet();
      const first = plan.items[0]!;
      const second = plan.items[1]!;
      const one = await stageSemanticCandidate({ setDir, item: first, version: 1, image: Buffer.from("reserved-same"), createdAt: fixedNow() });
      await expect(reviewSemanticCandidate({
        setDir,
        item: first,
        candidate: one,
        decision: { decision: "accepted", reason: "passed before crash" },
        reviewedAt: fixedNow(),
        faults: { [faultPoint]: () => { throw new Error(`crash at ${faultPoint}`); } },
      })).rejects.toThrow(`crash at ${faultPoint}`);

      const two = await stageSemanticCandidate({ setDir, item: second, version: 1, image: Buffer.from("reserved-same"), createdAt: fixedNow() });
      await expect(reviewSemanticCandidate({
        setDir, item: second, candidate: two,
        decision: { decision: "accepted", reason: "duplicate" }, reviewedAt: fixedNow(),
      })).rejects.toThrow("duplicates an accepted or reserved image hash");

      const recovered = await inspectSemanticItemState(setDir, first);
      expect(recovered.status).toBe("accepted");
      expect(recovered.review).toMatchObject({ decision: "accepted", reason: "passed before crash" });
      expect(await readFile(join(setDir, first.filename))).toEqual(Buffer.from("reserved-same"));
    },
  );

  it("rejects duplicate accepted hashes and never overwrites a conflicting final file", async () => {
    const setDir = await tempSet();
    const first = plan.items[0]!;
    const second = plan.items[1]!;
    const one = await stageSemanticCandidate({ setDir, item: first, version: 1, image: Buffer.from("same"), createdAt: fixedNow() });
    await reviewSemanticCandidate({ setDir, item: first, candidate: one, decision: { decision: "accepted", reason: "passed" }, reviewedAt: fixedNow() });
    const two = await stageSemanticCandidate({ setDir, item: second, version: 1, image: Buffer.from("same"), createdAt: fixedNow() });
    await expect(reviewSemanticCandidate({ setDir, item: second, candidate: two, decision: { decision: "accepted", reason: "passed" }, reviewedAt: fixedNow() })).rejects.toThrow("duplicates");

    const third = plan.items[2]!;
    const candidate = await stageSemanticCandidate({ setDir, item: third, version: 1, image: Buffer.from("candidate"), createdAt: fixedNow() });
    await writeFile(join(setDir, third.filename), "existing");
    await expect(reviewSemanticCandidate({ setDir, item: third, candidate, decision: { decision: "accepted", reason: "passed" }, reviewedAt: fixedNow() })).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(setDir, third.filename), "utf8")).toBe("existing");
  });
});
