# Codex Image Generation and Pixel Tagging

This is the operational contract for creating a new `VisualAffectV2` character pool with Codex. Use it for new installations and complete pool replacements. For retagging unchanged pixels, use the existing resumable retagger instead of generating new images.

## One-command setup

From the repository root, one invocation can own generation, tagging, external-store migration, service import, restart, and verification:

```bash
npm run setup:affect -- \
  --character "adult gothic assistant with burgundy hair and magenta eyes" \
  --set-id gothic-affect-v4 \
  --reference /absolute/path/reference-1.png \
  --reference /absolute/path/reference-2.png \
  --channel 123456789012345678 \
  --apply
```

`--reference` and `--channel` are repeatable. At most three references are accepted. Without a reference, Codex first creates a stable identity reference and then uses it for the pool. Without a channel, the setup preserves mappings and may infer a target only when exactly one enabled mapping exists.

Running the command without `--apply` performs a free local preflight and prints resolved external paths. Supplying `--apply` is explicit approval for the paid Codex image-generation and vision-tagging calls. The command uses a workspace-write sandbox rooted at the external setup directory; the repository is instructions and code, not an asset destination.

Prerequisites:

- `codex login` has completed and the configured Codex CLI is executable.
- The character description and references are approved for use.
- Existing service environment variables remain available if import, channel mapping, restart, and live delivery should run automatically.

## Generation and immediate tagging contract

1. Create durable state under `<asset-root-parent>/setup/<set-id>-codex`. Never use the repository `assets/` tree.
2. Generate exactly 100 accepted character images with Codex image generation. Preserve identity while varying gesture, facial expression, gaze, posture, background, clothing, framing, and lighting. Reject duplicates, broken images, identity drift, text, watermarks, collages, extra limbs, or unintended characters.
3. After each image is accepted, immediately tag its actual pixels with Codex vision before generating more untracked work. Present an anonymous temporary filename and the image bytes only. Do not reveal its output filename, prompt, planned emotion, directory, batch position, or intended affect.
4. Require the complete `VisualAffectV2` object: all 24 `AffectSpaceV2` dimensions, confidence, and concise visible-pixel evidence. The caller adds the Codex model, UTC timestamp, prompt version `visual-affect-pixels-v3-per-image`, and SHA-256 of the exact accepted bytes.
5. Store immutable candidate, acceptance, and `.affect` receipts after every item. A changed image hash invalidates its old tag. A rerun resumes verified receipts and never pays again for completed items.
6. Compile `affect-vectors.json` only when all 100 accepted files have valid, hash-matching tags. Verify file count, distinct hashes, vector validity, and manifest coverage.

The tag is a measurement of visible affect, not the generation intent. Sparse anger, warmth, teasing, or any other region must be repaired by generating visibly appropriate additional candidates, never by changing tag values to fit a desired distribution.

## Activation and verification contract

After the full set validates:

1. Run `affect-store` without `--apply` and inspect count, bytes, checksum, target, and activation intent.
2. Back up the service SQLite database and service-manager configuration.
3. Re-run migration with `--apply --activate`. The migration may resume identical bytes but must refuse a different file at the same destination.
4. Import the external manifest into the service database. Change only explicitly requested channel mappings, or the single enabled mapping when inference is unambiguous.
5. Restart the managed Hent-ai service and OpenClaw gateway only when their local configuration is discoverable.
6. Verify service health, `AffectSpaceV2` routing diagnostics, selected object hash, static response bytes, OpenClaw media handoff, and a real Discord attachment when credentials and a channel are available.
7. Keep the previous asset set, database backup, and service configuration as rollback material.

The terminal state file is `<asset-root-parent>/setup/<set-id>-codex/setup-status.json`. Success requires at least:

```json
{
  "status": "complete",
  "acceptedImages": 100,
  "taggedImages": 100
}
```

If an external prerequisite blocks later deployment, record the blocker plus generated/tagged counts in that file. Re-run the exact setup command after fixing the prerequisite; immutable receipts make the operation resumable.

## Retagging an existing pool

When pixels already exist and only affect metadata needs migration, do not regenerate them:

```bash
node scripts/codex-visual-affect-retag.mjs \
  --source-root <external-asset-root> \
  --set-id <source-set-id> \
  --output-dir <external-retag-output> \
  --codex-bin "$(command -v codex)" \
  --model gpt-5.6-sol \
  --batch-size 5 \
  --concurrency 3
```

This path anonymizes inputs, validates structured output, binds image hashes, and resumes immutable completed tags. It does not generate or modify image bytes.
