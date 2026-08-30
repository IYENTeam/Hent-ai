# Hent-ai : Let your AI agent express its hent!!
<img width="2172" height="724" alt="Banner" src="https://github.com/user-attachments/assets/756f890d-7e66-427f-ba97-dfa348a392c6" />

> *Let your AI agent express its hent (intent).*

---

"Hent" is a coined word meaning "intent".

Hent-ai automatically classifies the emotion of every bot response and attaches a matching emotion image. The canonical runtime is the **Hent-ai service** with a thin **OpenClaw** adapter; **Hermes** is supported through a lightweight compatibility adapter.

### Supported Emotions

| Emotion | When Used |
|---------|-----------|
| `happy` | Success, completion, celebration |
| `neutral` | General responses, informational |
| `loyalty` | Acknowledgment, greeting |
| `sorry` | Apology, mistakes |
| `confused` | Uncertainty, questions |
| `focused` | Working, investigating, debugging |

## Runtime architecture

There is one canonical OpenClaw path:

```text
OpenClaw final reply + embedded ResponseAffectV2 marker
  -> thin openclaw/ adapter strips and validates the transport marker
  -> Hent-ai HTTP service
  -> authenticated ResponseAffectV2 validation (remote verifier only as compatibility fallback)
  -> service-owned nearest-neighbor affect router
  -> service-owned /static media
  -> OpenClaw outbound channel adapter
```

The service owns policy, channel/profile mappings, verifier fallback state, affect routing, asset
records, and static bytes. OpenClaw owns host lifecycle hooks, same-generation affect transport, and delivery. It does not independently classify,
scan manifests, read profile databases, or call Discord REST directly. The former
`server-with-poller` composition is not a supported API or OpenClaw deployment path.

A fully tagged V2 set is ranked across all its images by weighted distance between the final
response's `ResponseAffectV2` and pixel-derived `VisualAffectV2` vectors. Equal-distance candidates
are selected randomly. A missing, malformed, hash-stale, or partially tagged set stays on the
legacy path; incomplete metadata never silently activates mixed affect behavior.

## Getting Started

### One-command Codex setup

Generate a 100-image pool, tag every accepted image from its pixels in `VisualAffectV2`, install it into external local storage, import it, and run service/OpenClaw verification with one command:

```bash
codex login
npm run setup:affect -- \
  --character "adult gothic assistant with burgundy hair and magenta eyes" \
  --set-id gothic-affect-v4 \
  --reference /absolute/path/to/reference.png \
  --channel 123456789012345678 \
  --apply
```

The generated pool, tags, manifests, setup state, and backups stay outside Git under the configured `HENT_AI_ASSET_ROOT` and its sibling setup directory. `--apply` explicitly approves paid Codex generation and vision tagging; omit it for a free preflight. Interrupted runs resume from immutable per-image receipts when the same command is run again. See [`SKILL.md`](./SKILL.md) and the [Codex generation/tagging contract](./references/codex-image-generation-and-tagging.md).

> **Agent setup:** You can also tell Codex to read [`SKILL.md`](./SKILL.md) and set up a character pool. The skill uses the same one-shot entrypoint and only pauses for a real missing prerequisite.

Choose your platform:

- **OpenClaw** → see [`openclaw/README.md`](./openclaw/README.md) (canonical service-backed adapter)
- **Hermes** → see [`hermes/README.md`](./hermes/README.md) (compatibility adapter)

## Creating Emotion Images

New installations should use the 100-image `VisualAffectV2` setup above. The six-image commands below remain available for legacy coarse-emotion sets.

- **Agent-driven V2 setup (recommended)** — Tell Codex to read [`SKILL.md`](./SKILL.md), or run `npm run setup:affect -- ... --apply` directly.
- **CLI** — Run `hent-ai generate` from the command line (Option A below).
- **Manual** — Create images yourself with any tool (Option B below).

### Option A: Auto-Generate with Codex (Recommended)

Generate all 6 emotion images with a single command using Codex image generation:

```bash
# Prerequisites: log in with Codex CLI
codex login

# Install and run
cd generate && npm install && npm run build
node dist/cli.js --character "cute orange cat"

# Or with an existing base image (skips base generation)
node dist/cli.js --character "cute orange cat" --base ./my-base.png
```

The tool first generates a base character image, then uses it as a reference to generate 6 emotion variants — ensuring style consistency across all images. Output: `base.png`, `happy.png`, `neutral.png`, `loyalty.png`, `sorry.png`, `confused.png`, and `focused.png` in the `assets/` directory.

**CLI Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-c, --character` | Character description | (required) |
| `-b, --base` | Existing base image (skips base generation) | — |
| `-o, --output` | Output directory | `./assets` |
| `-m, --model` | Codex model | `gpt-5.4` |
| `-s, --size` | Image size (e.g. `1024x1024`) | `1024x1024` |
| `-j, --concurrency` | `auto` adaptive mode, or fixed parallel emotion generations 1-8 | `auto` |
| `--no-keep-base` | Don't save base.png to output | — |
| `--only` | Regenerate only specific emotions (comma-separated, e.g. `--only sorry,confused`) | all |

**Reference Image Limits:**

- Maximum **3 reference images** per generation request
- Images larger than 768px are automatically resized (preserving aspect ratio) to reduce payload size and prevent timeouts
- `--concurrency auto` starts emotion generation at 8 parallel requests, adds small start-time jitter, and backs off with jitter on 429/timeout/5xx responses
- If a prompt triggers a content-policy rejection and a `classifierModel` is configured, the prompt is automatically rephrased and retried (up to 3 attempts)
- **CLI limitation**: `hent-ai generate` does not support automatic safety rephrase — it uses Codex auth only, with no separate LLM provider for prompt rewriting. Use the agent-driven setup skill when you need an agent to rewrite rejected prompts interactively.

### Option B: Manual Creation

The best results come from designing a single character first, then generating emotion variants using that image as a reference.

**Step 1: Generate your base character**

Use any image generation tool (DALL-E, Midjourney, Stable Diffusion, gpt-image, etc.) to create a character you like. This is your agent's visual identity. Spend time here — iterate until you're happy with the design.

**Step 2: Use the base image as a reference for each emotion**

Feed the base character image back into the generator as a reference and prompt for each emotion variant:

```
Same character as the reference image, expressing [emotion].
Simple background, consistent art style.
```

Generate one image per emotion:
- `happy` — smiling, thumbs up, celebrating
- `neutral` — calm, relaxed, default expression
- `loyalty` — saluting, nodding, attentive
- `sorry` — apologetic, bowing, sheepish
- `confused` — head tilt, question mark, puzzled
- `focused` — concentrating, working, determined

**Step 3: Rename and place**

```bash
mv your-happy-image.png assets/happy.png
mv your-neutral-image.png assets/neutral.png
mv your-sorry-image.png assets/sorry.png
mv your-confused-image.png assets/confused.png
mv your-focused-image.png assets/focused.png
mv your-loyalty-image.png assets/loyalty.png
```

You can configure large character image pools. New pools use pixel-derived `VisualAffectV2`
metadata and are ranked against the final response's `ResponseAffectV2` vector across the entire
mapped set. Exact-distance ties are random. Legacy coarse-emotion sets remain supported; malformed
or partially tagged V2 sets fail closed to the legacy fallback.

Generated pools and their runtime manifest belong in the external `HENT_AI_ASSET_ROOT` (normally
`~/.hent-ai/assets`), not in this repository. See [`SKILL.md`](./SKILL.md) for the generation,
pixel-tagging, migration, import, and live verification workflow.

### Tips for Better Images

- **Keep a consistent art style** across all 6 images — same character, same proportions, same background style. Using one base image as a reference for all variants is the easiest way to achieve this.
- **Use simple backgrounds** — the images appear as small thumbnails in Discord; busy backgrounds make the emotion harder to read
- **Make emotions visually distinct** — if `happy` and `neutral` look too similar, the image swap won't feel meaningful
- **Square aspect ratio works best** — Discord renders attachments well at 1:1 or close to it
- **File size matters** — keep images under 500KB each for fast Discord uploads
- **PNG format** — use PNG for transparency support and clean edges

### Quick Start Prompt Template

```
"A cute [animal/character type] character, [emotion description],
 simple clean background, consistent [anime/pixel/cartoon] style,
 square format, high quality PNG"
```

Generate all 6 in one session to maintain style consistency. If your tool supports image-to-image reference, always feed in the base character to keep the look unified.

## Writing Your SOUL.md for Hent-ai

Hent-ai derives a multidimensional affect vector from your agent's **response text**, so how your agent writes directly affects which image gets attached. Your `SOUL.md` (or equivalent persona file) shapes this.

### Key Principle

**Don't tell the agent which emotion to pick.** Let the agent write naturally, and Hent-ai will read the emotion from the text. The more distinct your agent's writing style is per situation, the more accurate the classification.

### Tips for SOUL.md

1. **Remove any `MEDIA:` tag instructions** — Hent-ai handles images automatically. If your SOUL.md tells the agent to output `MEDIA:/path/to/image.png`, remove that. The plugin owns image attachment now.

2. **Define clear emotional behaviors** — Instead of "attach happy.png when done", write something like:
   ```markdown
   ## Tone
   - When a task is completed successfully, celebrate briefly and move on.
   - When you make a mistake, own it immediately — no deflection.
   - When investigating a problem, describe what you're checking.
   ```
   This gives the LLM verifier clear signals across warmth, joy, embarrassment, determination, irritation, and the other AffectSpaceV2 dimensions.

3. **Don't flatten your agent's personality** — A monotone agent will cluster around the same images. Let your agent have range: excitement, frustration, curiosity, affection, and teasing occupy different parts of the affect space.

4. **Add a simple note about the plugin** — Something like:
   ```markdown
   ## Emotion Images
   - The emotion-image plugin automatically attaches emotion images to responses.
   - Do not include MEDIA: tags in responses.
   ```

### Example SOUL.md Snippet

```markdown
# SOUL.md — MyAgent

You are a helpful assistant. Polite but not robotic.

## Emotion Images
- The emotion-image plugin handles image attachment automatically.
- Do not include MEDIA: tags in your responses.

## Tone
- Completed work → brief, confident, celebratory
- Errors/mistakes → honest, direct apology, then fix
- Investigating → describe what you're checking, stay focused
- Confused → say so clearly, ask for clarification
- Greeting/acknowledgment → warm and brief
```

## Multi-Profile

Hent-ai supports multiple character profiles. Each profile has its own emotion images and an optional personality snippet that gets dynamically appended to the agent's system prompt.

### Creating a Profile

```bash
cd generate && npm run build

# Create a profile
node dist/main.js profile create --id gothic --name "Gothic Character" --image-dir /path/to/assets

# Set a personality snippet
node dist/main.js profile set-soul --id gothic --text "Cold and aloof tone. Uses formal language." --image-dir /path/to/assets

# List profiles
node dist/main.js profile list --image-dir /path/to/assets
```

Then place emotion images at `assets/profiles/gothic/` (happy.png, neutral.png, etc.).

### Switching Profiles Per Channel

For the **OpenClaw** runtime, channel → profile/asset mapping is owned by the Hent-ai service. Set it through the service API rather than a local file:

```bash
curl -X PUT "$HENT_AI_SERVICE_URL/v1/channels/$DISCORD_CHANNEL_ID/mapping" \
  -H "Authorization: Bearer $HENT_AI_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "profileId": "gothic", "assetSetId": "gothic", "enabled": true }'
```

See [`docs/channel-profiles.md`](docs/channel-profiles.md) for the full service-owned channel/profile model.

> The legacy `openclaw/scripts/switch_profile.ts` script and plugin `defaultProfile` config write
> local state that the service-backed adapter does not read. They are migration tooling, not a
> supported OpenClaw runtime workflow.

### Configuration (Hermes)

For Hermes, select a profile asset subdirectory with an environment variable:

```bash
export HENT_AI_DEFAULT_PROFILE=gothic
```

### Import/migration

Migration is explicit: back up the existing assets/database, run the service importer first in
dry-run mode, inspect its warnings and manifest/DB diff, then run the mutating import and read the
service state back. OpenClaw startup does not migrate local profiles or manifests implicitly.
See [`docs/agent-runbook.md`](docs/agent-runbook.md) for the operational contract.

## License

The software is MIT-licensed. Generation receipts, hashes, and provider/model metadata are
technical provenance only; they do not establish copyright ownership, license scope, model/person
releases, or downstream usage rights for reference or generated images.

## Special Thanks

Special thanks to [MoerAI](https://github.com/MoerAI) for helping name Hent-ai.

## Docs

- [Identity roadmap](docs/identity-roadmap.md) — canonical architecture/ownership decisions
- [Channel profiles](docs/channel-profiles.md) — service-owned channel/profile/policy model
- [Agent runbook](docs/agent-runbook.md) — build, test, deploy, and operations
- [Service-owned gates](docs/service-owned-gates.md) — PR/release gate policy
- [Semantic corpus workflow](generate/README.md#semantic-100-image-corpus) — immutable generation, actual-pixel tagging, and activation
