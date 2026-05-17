# Hent-ai for OpenClaw

Emotion Image Attachment Plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Automatically classifies the emotion of every bot response using LLM and attaches a matching emotion image to Discord messages.

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A Discord bot token (provide via env var or plugin config — see [Discord Bot Token](#discord-bot-token))
- An LLM provider configured in OpenClaw for emotion classification
- **Emotion images** — You need at least 6 PNG images, one for each emotion. Generate or create your own images and name them:
   - `happy.png`
   - `neutral.png`
   - `loyalty.png`
   - `sorry.png`
   - `confused.png`
   - `focused.png`

   Place them in the `assets/` directory inside the plugin, or set a custom `imageDir` in the config.
   You can also add multiple pre-labeled images per emotion and configure `emotionMap` as an image pool; the plugin randomly selects one variant each time that emotion is shown.

### Step 1: Clone the Repository

```bash
cd /path/to/your/openclaw/extensions
git clone https://github.com/IYENTeam/Hent-ai.git emotion-image
```

Or install to the OpenClaw global extensions directory:

```bash
cd ~/.openclaw/extensions
git clone https://github.com/IYENTeam/Hent-ai.git emotion-image
```

### Step 2: Generate Emotion Images

Place 6 emotion images in the `assets/` directory:

```
assets/
├── happy.png
├── neutral.png
├── loyalty.png
├── sorry.png
├── confused.png
└── focused.png
```

See the main [README.md](../README.md#creating-emotion-images) for generation methods (CLI auto-generate or manual creation).

### Step 3: Configure OpenClaw

Add the plugin configuration to your `openclaw.json` (or via `openclaw config`):

```jsonc
{
   "plugins": {
     "entries": {
       "emotion-image": {
         "enabled": true,
         "config": {
           // Required: Discord bot token. Use "${ENV_VAR}" to interpolate from environment.
           "discordToken": "${EMOTION_IMAGE_DISCORD_TOKEN}",

           // Required: provider/model ID for LLM-based emotion classification
           "classifierModel": "your-provider/gpt-5.4-mini",

           // Optional: custom image directory (defaults to ../assets/ relative to the plugin)
           // "imageDir": "/path/to/custom/assets",

           // Optional: override default emotion (defaults to "neutral")
           // "defaultEmotion": "neutral",

            // Optional: override emotion-to-filename mapping or define labeled image pools
            // "emotionMap": {
            //   "happy": "happy.png",
            //   "neutral": "neutral.png",
            //   "focused": [
            //     { "file": "focused-coding.png", "label": "coding" },
            //     { "file": "focused-reading.png", "label": "reading", "weight": 2 }
            //   ]
            // }
         }
       }
     }
   }
 }
 ```

### Step 4: Build and Restart OpenClaw

If running from source:

```bash
cd /path/to/openclaw
pnpm run build
```

Then restart OpenClaw:

```bash
openclaw gateway restart
```

### Step 5: Verify

After restart, check the gateway log for:

```
[plugins] emotion-image: LLM classifier enabled with model="your-provider/gpt-5.4-mini"
[plugins] emotion-image: token found (len=XX), imageDir=/path/to/assets
```

Send a message in Discord. You should see:
1. A "focused" thinking image appears immediately
2. The bot responds with text
3. An emotion image is appended to the response

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the plugin |
| `discordToken` | `string` | — | Discord bot token. Supports literal value or `${ENV_VAR}` placeholder. Required. |
| `classifierModel` | `string` | — | OpenClaw `provider/model` ID for LLM classification. **Required for LLM mode.** If not set, uses rule-based keyword matching only. |
| `imageDir` | `string` | profile workspace `.hent-ai/emotion-image-assets`, then `../assets` fallback | Directory containing emotion image files |
| `defaultEmotion` | `string` | `"neutral"` | Fallback emotion when no match found |
| `emotionMap` | `object` | (built-in) | Mapping from emotion name → image filename or labeled image pool. **Filenames only** — paths that escape `imageDir` are rejected. |
| `emotionRules` | `object` | (built-in) | Custom keyword regex patterns per emotion (merged with defaults) |
| `cheer.enabled` | `boolean` | `true` | Enable one-off cheer image generation |
| `cheer.intentModel` | `string` | `classifierModel` | Optional provider/model ID for detecting cheer/support request intent |
| `cheer.character` | `string` | — | Optional character description for cheer images; otherwise `base.png` is used as reference when available |
| `cheer.model` | `string` | — | Optional provider/model ID for cheer image generation |
| `cheer.size` | `string` | `"1024x1024"` | Generated cheer image dimensions |

## How It Works

Hent-ai operates in two phases:

1. **Phase 1 — Thinking Indicator** (`message_received` hook)
    - When a user sends a message, the plugin immediately sends a "focused" (thinking) image to the channel
    - This gives instant visual feedback before the bot responds
    - If the user's message asks for encouragement/support (for example `나 응원해줘` or `오늘 너무 힘든데 기운 좀 줘`), the plugin generates and sends a tasteful non-explicit cheer image instead
    - Cheer intent detection requires `classifierModel` or `cheer.intentModel`; without a configured GPT/provider model, cheer requests will not trigger image generation

2. **Phase 2 — Emotion Classification** (`message_sent` hook)
   - After the bot sends a response, the plugin calls an LLM to classify the emotion of the response text
   - The classified emotion image is appended to the bot's message
   - If LLM classification fails, falls back to rule-based keyword matching

## Architecture

```
User message
  │
  ├─► [message_received hook]
  │     ├─► If LLM detects cheer/support intent: generate + send cheer image
  │     └─► Otherwise send focused.png to channel (instant)
  │
  ▼
Bot generates response
  │
  ├─► [message_sent hook]
  │     ├─► LLM classifies emotion (background, up to 15s timeout with 1 retry)
  │     ├─► Falls back to rule-based if LLM fails
  │     └─► Appends emotion image to bot message via Discord PATCH
  │
  ▼
User sees: [focused.png] → [text response + emotion.png]
```

## Discord Bot Token

Provide the Discord bot token via one of:

1. **Environment variable** (recommended for production):
   ```bash
   export EMOTION_IMAGE_DISCORD_TOKEN="your-bot-token"
   ```

2. **Plugin config with env interpolation**:
   ```jsonc
   "discordToken": "${EMOTION_IMAGE_DISCORD_TOKEN}"
   ```

3. **Plugin config with literal value** (not recommended — keep tokens out of config files):
   ```jsonc
   "discordToken": "your-bot-token"
   ```

If neither is set, the plugin logs a warning and does nothing.

> **⚠️ v2 BREAKING CHANGE**: Earlier versions of this plugin auto-resolved the
> token by reading `~/.openclaw/openclaw.json` directly. That fallback has been
> removed for security and portability — plugins should not read host-internal
> config paths. If you were relying on the auto-detect behavior, set
> `EMOTION_IMAGE_DISCORD_TOKEN` or `discordToken` explicitly.

## Onboarding (Agent-Driven)

Onboarding is handled conversationally by the OpenClaw agent — no coded state machine or intent detection required. The agent reads these instructions and guides the user through the process naturally.

### How It Works

When `imageDir` is omitted, Hent-ai stores assets under the active OpenClaw profile/workspace at `.hent-ai/emotion-image-assets`. This keeps gateway profiles from sharing or overwriting each other's emotion assets. Set `imageDir` explicitly only when you intentionally want a shared asset directory.

### Trigger

When a user says `onboarding` or `setup` in Discord, the OpenClaw agent should:

1. **Ask for character description** — Ask the user to describe their character (e.g. "cute orange cat", "pixel art robot"). The user may also attach a reference image.

2. **Handle attached images** — If the user attaches an image:
   - Ask whether to use it directly as the base character, or as a style reference for generation.

3. **Generate base character** — Use the `image_generate` tool with the character description (and reference image if provided). Show the result and ask for approval.
   - If the user approves → proceed to emotions
   - If the user gives feedback → regenerate with feedback incorporated
   - If the user says cancel/취소/종료 → abort

4. **Generate each emotion** — For each of the 6 emotions (`happy`, `neutral`, `loyalty`, `sorry`, `confused`, `focused`), one at a time:
   - Generate using the base image as reference with an emotion-specific prompt
   - Show the result, ask for approval
   - Accept feedback for regeneration, or let the user attach their own image
   - On approval, save to the `assets/` directory

5. **Complete** — Confirm all images are saved and the plugin is ready to use.

### Agent Prompting Guidelines

For base character generation:
```
[user's character description], clean illustration style, square format, simple background, high quality PNG
```

For emotion variants (use base image as reference):
```
Same character as the reference image, expressing [emotion].
[emotion-specific cues]. Simple background, consistent art style.
```

Emotion cues:
- `happy` — smiling, celebrating, thumbs up
- `neutral` — calm, relaxed, default expression
- `loyalty` — saluting, nodding, attentive
- `sorry` — apologetic, bowing, sheepish
- `confused` — head tilt, question mark, puzzled
- `focused` — concentrating, working, determined

### File Output

Save all generated images to the configured `imageDir` (default: `../assets/` relative to the plugin):
- `base.png` — the base character
- `happy.png`, `neutral.png`, `loyalty.png`, `sorry.png`, `confused.png`, `focused.png`

### Exit Commands

The user can abort at any time with: `취소`, `cancel`, `종료`, `그만`

### Labeled Image Pools

`emotionMap` can contain multiple custom images per emotion. Each image may have a `label`, and Hent-ai prefers variants whose label appears in the bot response context before falling back to weighted random selection:

```jsonc
{
  "emotionMap": {
    "happy": [
      { "file": "happy-stage.png", "label": "stage", "weight": 2 },
      { "file": "happy-date-night.png" }
    ]
  }
}
```

If `label` is omitted, Hent-ai infers one from the filename by removing the emotion word and common image terms. For example, `happy-date-night.png` becomes `date night`, so a response mentioning `date night` will automatically select that image when the classified emotion is `happy`.

## Troubleshooting

### Images not appearing
- Check `gateway.log` for `emotion-image:` entries
- Verify the bot has `MANAGE_MESSAGES` permission in the Discord channel (needed for message PATCH)
- Ensure image files exist in the configured `imageDir`

### LLM classification always returns null
- Check `gateway.err.log` for timeout or API errors
- Verify the `classifierModel` provider is configured and has valid credentials
- Try increasing `LLM_TIMEOUT_MS` in `index.ts` (default: 15000ms)

### "Cannot edit a message authored by another user" (403)
- The plugin tried to edit a non-bot message. This is handled gracefully and logged as a warning.

## License

MIT
