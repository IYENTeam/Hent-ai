import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ServiceDatabase } from "../src/db.js";
import { applyProfileSoul, runApplyProfileSoulCli } from "./apply-profile-soul.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): { readonly root: string; readonly dbPath: string; readonly soulPath: string; readonly backupDir: string } {
  const root = mkdtempSync(join(tmpdir(), "apply-profile-soul-"));
  roots.push(root);
  const dbPath = join(root, "service.sqlite");
  const database = new ServiceDatabase(dbPath);
  database.createProfile({ id: "iyen", name: "Iyen", soulSnippet: "previous soul" });
  database.close();
  return { root, dbPath, soulPath: join(root, "soul.txt"), backupDir: join(root, "backups") };
}

describe("apply-profile-soul", () => {
  it("updates only the requested soul, writes a backup, and prints a sanitized receipt", () => {
    const item = fixture();
    writeFileSync(item.soulPath, "  이연의 새 Soul  \n", "utf8");
    const output: string[] = [];

    const receipt = runApplyProfileSoulCli([
      "--db", item.dbPath,
      "--profile", "iyen",
      "--file", item.soulPath,
      "--backup-dir", item.backupDir,
    ], (line) => output.push(line));

    expect(readFileSync(receipt.backupPath, "utf8")).toBe("previous soul");
    expect(receipt).toMatchObject({
      profile: "iyen",
      oldBytes: Buffer.byteLength("previous soul"),
      newBytes: Buffer.byteLength("이연의 새 Soul"),
      sha256: createHash("sha256").update("이연의 새 Soul", "utf8").digest("hex"),
    });
    expect(JSON.parse(output[0]!)).toEqual(receipt);
    expect(output[0]).not.toContain("이연의 새 Soul");

    const database = new ServiceDatabase(item.dbPath);
    expect(database.getProfile("iyen")).toMatchObject({ soulSnippet: "이연의 새 Soul", updatedAt: receipt.updatedAt });
    database.close();
  });

  it("rejects a missing profile without creating a backup", () => {
    const item = fixture();
    writeFileSync(item.soulPath, "new soul", "utf8");

    expect(() => applyProfileSoul({ ...item, filePath: item.soulPath, profile: "missing" })).toThrow("Profile not found: missing");
    expect(() => readFileSync(item.backupDir)).toThrow();
  });

  it("rejects content above 8192 UTF-8 bytes without mutation", () => {
    const item = fixture();
    writeFileSync(item.soulPath, "가".repeat(2731), "utf8");

    expect(() => applyProfileSoul({ dbPath: item.dbPath, profile: "iyen", filePath: item.soulPath, backupDir: item.backupDir }))
      .toThrow("Soul content must be between 1 and 8192 UTF-8 bytes");

    const database = new ServiceDatabase(item.dbPath);
    expect(database.getProfile("iyen")?.soulSnippet).toBe("previous soul");
    database.close();
  });
});
