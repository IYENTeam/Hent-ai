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

### Step 2: Generate Emotion Images (Onboarding)

The easiest way to set up emotion images is through the built-in onboarding flow. Just send `onboarding` in Discord:

```
You:  onboarding
Bot:  🎨 Starting Hent-ai onboarding!
      Describe your character.

You:  cute orange cat
Bot:  ⏳ Generating base character...
Bot:  [base.png] Do you like this character?

You:  good
Bot:  ⏳ Generating happy... [1/6]
Bot:  [happy.png] Do you like it?

You:  make it brighter
Bot:  ⏳ Regenerating happy...
Bot:  [happy.png] How about this?

You:  ok
Bot:  ⏳ Generating neutral... [2/6]
...

Bot:  ✅ Onboarding complete!
```

The onboarding will:
1. Generate (or accept) a base character image
2. Use the base as reference to generate each emotion variant one by one
3. Let you provide feedback or regenerate any image you don't like
4. Save all images to the `assets/` directory automatically

You can also attach an image instead of describing a character — the bot will ask whether to use it directly as the base or as a style reference for generation.

**Alternatively**, place your own 6 emotion images in the `assets/` directory manually:

```
assets/
├── happy.png
├── neutral.png
├── loyalty.png
├── sorry.png
├── confused.png
└── focused.png
```

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
| `onboarding.enabled` | `boolean` | `true` | Enable/disable the onboarding flow |
| `onboarding.model` | `string` | — | Provider/model for image generation (e.g. `"provider/gpt-5.4"`) |
| `onboarding.size` | `string` | `"1024x1024"` | Generated image dimensions |
| `onboarding.sessionTimeoutMs` | `number` | `1800000` | Session timeout in ms (default: 30 min) |
| `onboarding.allowedUsers` | `string[]` | `[]` | User IDs allowed to run onboarding (empty = everyone) |
| `cheer.enabled` | `boolean` | `true` | Enable one-off cheer image generation |
| `cheer.intentModel` | `string` | `classifierModel` | Optional provider/model ID for detecting cheer/support request intent |
| `cheer.character` | `string` | — | Optional character description for cheer images; otherwise `base.png` is used as reference when available |
| `cheer.model` | `string` | `onboarding.model` | Optional provider/model ID for cheer image generation |
| `cheer.size` | `string` | `onboarding.size` or `"1024x1024"` | Generated cheer image dimensions |

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
  │     ├─► If LLM detects cheer/support intent: generate + send cheer.png-style support image
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

## Image Generation Limits

All image generation calls (onboarding, cheer, miracle mode) enforce the following:

- **Maximum 3 reference images** per request. Exceeding this throws an error.
- **Auto-resize**: Reference images larger than 768px (either dimension) are automatically resized before sending, preserving aspect ratio. This prevents request timeouts.
- **90-second timeout**: If the backend doesn't respond within 90s, the request fails with a timeout error.
- **Safety rephrase**: When `classifierModel` is configured, prompts rejected by the content-policy filter are automatically rephrased by the session's LLM provider and retried (up to 3 total attempts). If all attempts fail, the original error is reported.

## Private Mode (Per-Channel Set Switching)

Hent-ai supports per-channel asset set switching via an agent-driven skill. The agent reads `skills/private-mode.SKILL.md` and executes a script to toggle the active image set for a channel.

### How it works

1. User says "private 모드 켜줘"
2. Agent reads the skill file and executes:
   ```bash
   npx tsx openclaw/scripts/set_channel_mode.ts --channel <CHANNEL_ID> --mode private
   ```
3. The script writes to `imageDir/channel-overrides.json`
4. On the next emotion image request, the plugin reads the override and uses `imageDir/sets/private/` assets

### Setup

1. Create a `private` set in your image directory:
   ```
   imageDir/sets/private/
   ├── happy.png
   ├── neutral.png
   ├── loyalty.png
   ├── sorry.png
   ├── confused.png
   └── focused.png
   ```

2. Register it in `manifest.json` (or use the CLI/onboarding to generate)

3. Ensure the agent has access to `skills/private-mode.SKILL.md`

### Persistence

Channel overrides are saved to `imageDir/channel-overrides.json` and persist across bot restarts.

### Commands

| Command | Effect |
|---------|--------|
| `--mode private` | Switch channel to `private` set |
| `--mode default` | Revert channel to global default set |
| `--mode <any-set-id>` | Switch to any registered set |

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

## Onboarding

The onboarding flow lets users generate emotion images interactively through Discord without touching the CLI or filesystem. Internally, onboarding is skill-based: each capability (character intake, uploaded-image intent, base confirmation, emotion confirmation, and generation busy handling) is registered as an onboarding skill and dispatched by the current session state instead of a single fixed procedure. This keeps the default flow unchanged while making new onboarding capabilities pluggable in code.

While onboarding is active in a channel, Hent-ai pauses its normal thinking/cheer image hook for that user's onboarding messages and tells the user that onboarding mode is active. Every onboarding prompt also reminds the user that they can exit with `취소`, `cancel`, `종료`, or `그만`. Other users and other channels continue using OpenClaw normally.

When `imageDir` is omitted, Hent-ai stores assets under the active OpenClaw profile/workspace at `.hent-ai/emotion-image-assets`. This keeps gateway profiles from sharing or overwriting each other's emotion assets. Set `imageDir` explicitly only when you intentionally want a shared asset directory.

Each onboarding session stages generated files in an isolated workspace under `imageDir/.onboarding-workspaces/<channel>-<session>`. Files are copied into the shared emotion asset directory only when onboarding completes, and cancelled sessions clean up their temporary workspace.

### Trigger

Send any of these messages in a channel where the bot is active:
- `onboarding`
- `setup`

### Flow

1. **Character input** — Describe your character in text, attach a reference image, or both.
2. **Image intent** — If you attached an image, the bot asks: use it as-is for the base, or use it as a style reference to generate a new one?
3. **Base confirmation** — Review the base character image. Approve, regenerate, or provide feedback (e.g. "make the eyes bigger").
4. **Emotion loop** — The bot generates each of the 6 emotions one at a time. For each one, you can approve, skip, give feedback to regenerate, or attach your own image to replace that emotion before approving.
5. **Done** — All 7 images (base + 6 emotions) are saved to the configured `imageDir`.

### Built-in onboarding skills

| Skill | Handles |
|-------|---------|
| `character-intake` | First character prompt, text input, and initial image attachment detection |
| `image-intent` | Choosing whether an uploaded image is the base or a generation reference |
| `base-confirmation` | Approving, regenerating, or giving feedback on the base image |
| `emotion-confirmation` | Approving, replacing, regenerating, or giving feedback on each emotion image |
| `base-generation` / `emotion-generation` | Busy responses while image generation is running |

### Commands during onboarding

| Input | Action |
|-------|--------|
| `ok` / `good` / `yes` | Approve current image, move to next |
| `skip` | Save current result as-is, move to next |
| `retry` / `again` | Regenerate with same settings |
| Image attachment during an emotion step | Use the uploaded file as the current emotion image |
| Any other text | Treated as feedback — regenerates with your note applied |
| `취소` / `cancel` / `종료` / `그만` | Abort onboarding |

### Labeled image pools

`emotionMap` can contain multiple custom images per emotion. Each image may have a `label`, and Hent-ai now prefers variants whose label appears in the bot response context before falling back to weighted random selection:

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

### Config example

```jsonc
{
  "onboarding": {
    "enabled": true,
    "model": "your-provider/gpt-5.4",
    "size": "1024x1024",
    "allowedUsers": ["123456789"]  // empty array = everyone can onboard
  }
}
```

### Requirements

- Codex authentication on the server (`codex login`)
- The `@hent-ai/generate` module installed alongside the plugin
- Bot must have `SEND_MESSAGES` and `ATTACH_FILES` permissions in the channel

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
