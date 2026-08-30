---
name: hent-ai
description: "Generate, pixel-tag, migrate, and operate Hent-ai character image pools with VisualAffectV2 nearest-neighbor routing. Use when creating character images, changing emotion routing, moving assets to local storage, importing a set, or validating OpenClaw media delivery."
---

# Hent-ai Affect Assets

Operate character images as deployment data, not repository content. Keep runtime assets under the configured external `HENT_AI_ASSET_ROOT`; use `~/.hent-ai/assets` when establishing a new local deployment. Do not add generated images, per-image tags, or a live manifest to Git.

Read [references/affect-space-v2.md](references/affect-space-v2.md) before changing tag generation or routing. Read [references/local-asset-store.md](references/local-asset-store.md) before moving, importing, activating, or deleting a set.

## Workflow

1. Inspect the live `HENT_AI_ASSET_ROOT`, manifest, channel mappings, database path, and service manager configuration. Never assume the repo's `assets/` directory is the active store.
2. For new images, obtain user approval before invoking paid image generation. Use the approved character references with the built-in image generation tool, preserve identity, and vary gesture, expression, background, clothing, framing, and lighting. Do not add text or speech bubbles.
3. Immediately after each image is generated, run a vision-capable LLM against the actual pixels and request the complete `VisualAffectV2` object. Do not expose the filename, planned emotion, or generation prompt to the tagger.
4. Bind the tag to the image SHA-256, model, timestamp, and prompt version. Treat tags as immutable; regenerate a tag when pixels change.
5. Compile and validate the set, then run `affect-store` without `--apply`. Review file count, bytes, checksum, and target before applying.
6. Back up the live SQLite database and service configuration. Copy to the external store, import the manifest, change only intended channel mappings, then switch `HENT_AI_ASSET_ROOT` and restart the service.
7. Verify unit/type tests, API routing diagnostics, exact media bytes, and a real local OpenClaw/Discord response. Keep the source until all checks pass; remove it from the repo only after the external copy is hash-verified.

If tagging reveals weak coverage of an affect region, report it and generate additional images with approval. Never repair sparse coverage by assigning emotions that are not visible.

## Commands

Use Node.js 22 for this repository.

```bash
node scripts/codex-visual-affect-retag.mjs \
  --source-root <external-asset-root> \
  --set-id <source-set-id> \
  --output-dir <external-retag-output> \
  --codex-bin <codex-executable> \
  --model gpt-5.6-sol \
  --batch-size 5 \
  --concurrency 3

cd generate
/opt/homebrew/opt/node@22/bin/node ../service/node_modules/tsx/dist/cli.mjs src/main.ts affect-store \
  --source-root <staging-asset-root> \
  --source-set <source-set-id> \
  --target-root <external-asset-root> \
  --target-set <target-set-id> \
  --tags <affect-vectors.json>
```

The Codex retagger copies each batch to anonymous temporary filenames, enforces `visual-affect-output.schema.json`, binds each result to the original image hash, resumes immutable completed tags, and compiles `affect-vectors.json` only after the full set passes. Add `--apply --activate` to `affect-store` only after the dry-run report is correct. Paths and identifiers shown here are placeholders; resolve the live values before acting.

## Safety Rules

- Never overwrite an external image with different bytes.
- Never tag from a filename, prompt, coarse class, or intended emotion.
- Never commit generated image pools or their runtime manifest.
- Never delete the source or old DB before live byte-level verification passes.
- Never expose service, Discord, or model-provider tokens in output or documentation.
- Preserve a rollback path for the previous asset root, manifest, database, and channel mappings.
