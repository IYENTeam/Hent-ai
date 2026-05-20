#!/usr/bin/env npx tsx
import { resolve } from "node:path";
import { ProfileDatabase } from "@hent-ai/shared/db";
import { readFileSync } from "node:fs";

const imageDir = resolve(import.meta.dirname ?? ".", "../../assets");
const db = new ProfileDatabase(imageDir);
const soulPath = resolve(process.env.HOME!, ".openclaw/workspace/templates/nibutani-soul.md");

try {
  const soulSnippet = readFileSync(soulPath, "utf-8");
  
  const existing = db.getProfile("nibutani");
  if (existing) {
    console.log("Profile 'nibutani' already exists, updating...");
    db.updateProfile("nibutani", {
      name: "니부타니 신카",
      character: "anime girl with light brown hair, pink hair clip, red ribbon around neck, school uniform style, tsundere personality from Chuunibyou demo Koi ga Shitai",
      soulSnippet,
    });
    console.log("Updated:", JSON.stringify(db.getProfile("nibutani"), null, 2));
  } else {
    const profile = db.createProfile({
      id: "nibutani",
      name: "니부타니 신카",
      character: "anime girl with light brown hair, pink hair clip, red ribbon around neck, school uniform style, tsundere personality from Chuunibyou demo Koi ga Shitai",
      soulSnippet,
    });
    console.log("Created:", JSON.stringify(profile, null, 2));
  }

  const profiles = db.listProfiles();
  console.log("\nAll profiles:");
  for (const p of profiles) {
    console.log(`  ${p.id} (${p.name}) - created: ${p.createdAt}`);
  }
} finally {
  db.close();
}
