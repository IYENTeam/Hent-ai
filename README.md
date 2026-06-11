# Hent-ai : Let your AI agent express its hent!!
<img width="2172" height="724" alt="Banner" src="https://github.com/user-attachments/assets/756f890d-7e66-427f-ba97-dfa348a392c6" />

> *Let your AI agent express its hent (intent).*

---

"Hent" is a coined word meaning "intent".

Hent-ai automatically classifies the emotion of every bot response and attaches a matching emotion image. It supports the **OpenClaw** platform.

### Supported Emotions

| Emotion | When Used |
|---------|-----------|
| `happy` | Success, completion, celebration |
| `neutral` | General responses, informational |
| `loyalty` | Acknowledgment, greeting |
| `sorry` | Apology, mistakes |
| `confused` | Uncertainty, questions |
| `focused` | Working, investigating, debugging |

## Runtime Architecture

Current OpenClaw runtime is service-owned:

```text
Discord user message
  └─ OpenClaw generates/sends text
      └─ OpenClaw Hent-ai service adapter calls Hent-ai HTTP service
          └─ Hent-ai service calls the configured remote verifier
              └─ Hent-ai service maps emotion → channel asset set image
                  └─ OpenClaw appends the media
```

The OpenClaw adapter is intentionally thin. It does not classify emotions, scan manifests, read profile databases, or call Discord directly. The service owns channel mappings, profile/asset selection, verifier config/cache, and generation job state.

The production verifier is deployment-configured. Public docs should describe the verifier contract and required config shape, not environment-specific provider names, endpoints, model IDs, or secrets.

## Getting Started

> **🤖 Agent setup:** If you're using an AI agent (OpenClaw, Claude Code, Codex, etc.), tell it to read [`SKILL.md`](./SKILL.md) in this repo. The agent will walk you through the entire setup interactively.

OpenClaw setup instructions are in [`openclaw/README.md`](./openclaw/README.md).

## Creating Emotion Images

You need 6 images that visually represent each emotion. There are three ways to set them up:

- **Agent-driven setup (easiest)** — Tell your AI agent to read [`SKILL.md`](./SKILL.md) in this repo. It should inspect the docs/config, infer your goal from context, and create/install the needed character emotion assets without forcing a fixed questionnaire.
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
| `--no-keep-base` | Don't save base.png to output | — |

**Reference Image Limits:**

- Maximum **3 reference images** per generation request
- Images larger than 768px are automatically resized (preserving aspect ratio) to reduce payload size and prevent timeouts
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

You can also configure multiple images per emotion with labels. Hent-ai automatically infers labels from filenames such as `happy-date-night.png` (`date night`) and prefers a matching labeled image when that context appears in the bot response.

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

Hent-ai classifies emotions from your agent's **response text**, so how your agent writes directly affects which emotion image gets attached. Your `SOUL.md` (or equivalent persona file) shapes this.

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
   This gives the LLM classifier clear signals: celebration → `happy`, owning mistakes → `sorry`, investigating → `focused`.

3. **Don't flatten your agent's personality** — A monotone agent that always writes the same way will always get `neutral`. Let your agent have range. Excitement, frustration, curiosity — these all map to distinct emotions.

4. **Add a simple note about the plugin** — Something like:
   ```markdown
   ## Emotion Images
   - Hent-ai attaches emotion images automatically through the `hent-ai-service-adapter` OpenClaw plugin.
   - Do not include MEDIA: tags in responses.
   ```

### Example SOUL.md Snippet

```markdown
# SOUL.md — MyAgent

You are a helpful assistant. Polite but not robotic.

## Emotion Images
- Hent-ai handles image attachment automatically through the OpenClaw service adapter.
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

Use the agent skill (say "프로필 바꿔줘" in Discord) or run directly:

```bash
npx tsx openclaw/scripts/switch_profile.ts --channel <DISCORD_CHANNEL_ID> --profile gothic
```

### OpenClaw Configuration

Current OpenClaw installs use the service adapter, not the old local `emotion-image` plugin entry.
Load the adapter from this repository and configure only the Hent-ai service connection:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["/path/to/Hent-ai/openclaw"]
    },
    "entries": {
      "hent-ai-service-adapter": {
        "enabled": true,
        "config": {
          "hentAiService": {
            "url": "https://hent-ai.example.com",
            "token": "${HENT_AI_SERVICE_TOKEN}",
            "timeoutMs": 15000
          }
        }
      }
    }
  }
}
```

Channel/profile selection is service-owned. Configure mappings through the service API:

```bash
curl -X PUT "$HENT_AI_SERVICE_URL/v1/channels/$DISCORD_CHANNEL_ID/mapping" \
  -H "Authorization: Bearer $HENT_AI_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "gothic-v1",
    "assetSetId": "gothic-v1",
    "mode": "normal",
    "enabled": true,
    "cronEnabled": false
  }'
```

If a Discord conversation runs inside a thread, map the thread id as well as the parent channel id. OpenClaw sends the active conversation/channel id to Hent-ai, so a parent-only mapping will not cover thread replies.

For Hermes, set the environment variable:

```bash
export HENT_AI_DEFAULT_PROFILE=gothic
```

### Migration

Older OpenClaw installs used a local `emotion-image` plugin entry, `defaultProfile`, local manifests, and channel override files. The current runtime source of truth is the Hent-ai service:

1. Remove the `plugins.entries.emotion-image` OpenClaw config entry.
2. Add `plugins.load.paths[]` for `openclaw/` and enable `plugins.entries.hent-ai-service-adapter`.
3. Move profile, asset-set, and channel mapping state into the Hent-ai service.
4. Restart/reload OpenClaw after changing plugin code or load paths.
5. Validate with a real assistant reply, not a direct/proactive send. A valid check shows a `/v1/final-response/verdict` service call and a Discord readback with non-empty `attachments`.

## License

MIT

## Special Thanks

Special thanks to [MoerAI](https://github.com/MoerAI) for helping name Hent-ai.
