# @hent-ai/generate

Generate, pixel-tag, and migrate Hent-ai character image sets.

## Install

```bash
cd generate
npm ci
npm run build
npm test
```

Node.js 22 is the reproducible runtime. `hent-ai --help` lists the built CLI commands.

## Small legacy sets

```bash
hent-ai generate \
  --character "polite gothic assistant" \
  --output ~/.hent-ai/assets/staging \
  --concurrency auto
```

Legacy sets retain the six compatibility labels `happy`, `neutral`, `loyalty`, `sorry`, `confused`, and `focused`. New large pools should use the affect workflow below; runtime routing does not treat those labels as the emotional ground truth.

## 100-image AffectSpaceV2 pool

`semantic-plan.ts` deterministically produces 100 identity-preserving prompts in ten review batches. It varies gesture, expression, background, and clothing while keeping stable filenames and reference identity. Generation is a paid operation: validate the plan and obtain user approval first.

Stage generated data outside the repository. A typical local path is `~/.hent-ai/assets/staging/<set-id>`. `semantic-batch.ts` provides immutable candidates, receipts, SHA-256 reservations, restart recovery, and exclusive final acceptance. Inspect actual pixels before accepting; never rewrite a receipt or tag to make a failed image fit its intended prompt.

After each accepted final, `affect-tags.ts` sends only the image pixels and the `VisualAffectV2` schema to a vision-capable LLM. The tagger must not receive the filename, planned coarse emotion, generation prompt, or directory. It returns all 24 dimensions, confidence, and pixel-grounded evidence. The caller binds model, timestamp, prompt version, and image SHA-256 and stores immutable `.affect/<id>.json` records. `compileVisualAffectCollection` refuses missing, malformed, or hash-stale records and writes `affect-vectors.json`.

Tests use injected fake generation/tagging providers and never make paid calls.

For a pixel-by-pixel Codex vision retag of an existing external set, use the resumable repository script. It presents anonymous temporary filenames to the model, processes each image exactly once, validates structured output, and binds immutable provenance before compiling the collection:

```bash
node scripts/codex-visual-affect-retag.mjs \
  --source-root ~/.hent-ai/assets \
  --set-id <source-set-id> \
  --output-dir ~/.hent-ai/retag/<target-set-id> \
  --codex-bin <codex-executable> \
  --model gpt-5.6-sol --batch-size 5 --concurrency 3
```

## External local store migration

Dry-run first:

```bash
/opt/homebrew/opt/node@22/bin/node ../service/node_modules/tsx/dist/cli.mjs src/main.ts affect-store \
  --source-root <staging-root> \
  --source-set <source-set-id> \
  --target-root ~/.hent-ai/assets \
  --target-set <target-set-id> \
  --tags <staging-set>/affect-vectors.json \
  --activate
```

Review count, bytes, checksum, and destination. Then repeat with `--apply --activate`. The migration verifies every provenance hash, never overwrites different bytes, copies all images before atomically writing the external manifest, and safely resumes identical files.

Verify the deployed pool from the repository root:

```bash
node scripts/verify-affect-assets.mjs ~/.hent-ai/assets <target-set-id>
```

Back up the service DB and service-manager configuration before import or channel remapping. Change `HENT_AI_ASSET_ROOT` only after import succeeds, then verify live API routing, exact static bytes, and OpenClaw delivery. Runtime images, affect records, and the live manifest are deployment data and must not be committed to this repository.

## Compatibility and provenance

- Image generation uses `god-tibo-imagen` and configured provider credentials.
- Records retain provider/model identifiers, reference hashes, final content hashes, timestamps, and review state without raw secrets.
- Provenance is technical audit evidence, not proof of copyright ownership, license scope, model releases, or downstream usage rights.

## Package verification

```bash
npm run build
npm test
npm pack --dry-run --json
```

The tarball must include `dist/main.js` and `dist/index.js`.
