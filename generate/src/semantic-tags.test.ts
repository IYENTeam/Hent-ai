import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemanticGenerationPlan } from "./semantic-plan.js";
import {
  SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
  parseInjectedLlmSemanticTags,
  tagSemanticAssetOffline,
} from "./semantic-tags.js";

const item = createSemanticGenerationPlan().items[0]!;
const validTags = {
  schemaVersion: SEMANTIC_ASSET_TAGS_SCHEMA_VERSION,
  emotion: item.emotion,
  gesture: item.gesture,
  expression: item.expression,
  background: item.background,
  clothing: item.clothing,
  composition: "three-quarter portrait",
  lighting: "soft moonlit rim light",
  mood: "earnest and apologetic",
} as const;

describe("offline semantic tags", () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it("parses direct and fenced injected LLM JSON with the service-compatible schema", () => {
    expect(parseInjectedLlmSemanticTags(validTags)).toEqual(validTags);
    expect(parseInjectedLlmSemanticTags(`\`\`\`json\n${JSON.stringify(validTags)}\n\`\`\``)).toEqual(validTags);
    expect(() => parseInjectedLlmSemanticTags({ ...validTags, schemaVersion: "SemanticAssetTagsV2" })).toThrow("SemanticAssetTagsV1");
    expect(() => parseInjectedLlmSemanticTags("not json")).toThrow("valid JSON");
  });

  it("uses an injected tagger, validates controlled values, and writes immutable per-item tags", async () => {
    const setDir = await mkdtemp(join(tmpdir(), "hent-semantic-tags-"));
    dirs.push(setDir);
    await mkdir(setDir, { recursive: true });
    await writeFile(join(setDir, item.filename), "pixels");
    const invoke = vi.fn(async () => JSON.stringify(validTags));
    await expect(tagSemanticAssetOffline({ setDir, item, tagger: { invoke } })).resolves.toEqual(validTags);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ imagePath: join(setDir, item.filename), item }));

    const drifted = { ...validTags, gesture: "uncontrolled gesture" };
    await expect(tagSemanticAssetOffline({ setDir, item, tagger: { invoke: async () => drifted } })).rejects.toThrow("unknown gesture");
  });
});
