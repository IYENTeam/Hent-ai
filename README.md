# Hent-ai 🎭

> *Let your AI agent express its hent (intent).*

**Emotion Image Attachment Plugin for OpenClaw**

Automatically classifies the emotion of every bot response using LLM and attaches a matching emotion image to Discord messages.

### Supported Emotions

| Emotion | When Used |
|---------|-----------|
| `happy` | Success, completion, celebration |
| `neutral` | General responses, informational |
| `loyalty` | Acknowledgment, greeting |
| `sorry` | Apology, mistakes |
| `confused` | Uncertainty, questions |
| `focused` | Working, investigating, debugging |

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- A Discord bot token (automatically resolved from OpenClaw Discord channel config)
- An LLM provider configured in OpenClaw for emotion classification
- **Emotion images** — You need 6 PNG images, one for each emotion. Generate or create your own images and name them:
  - `happy.png`
  - `neutral.png`
  - `loyalty.png`
  - `sorry.png`
  - `confused.png`
  - `focused.png`

  Place them in the `assets/` directory inside the plugin, or set a custom `imageDir` in the config.

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

### Step 2: Add Your Emotion Images

Place your 6 emotion images in the `assets/` directory:

```
assets/
├── happy.png
├── neutral.png
├── loyalty.png
├── sorry.png
├── confused.png
└── focused.png
```

You can generate these with any image generation tool — just make sure each file is named exactly as shown above.

### Step 3: Configure OpenClaw

Add the plugin configuration to your `openclaw.json` (or via `openclaw config`):

```jsonc
{
  "plugins": {
    "entries": {
      "emotion-image": {
        "enabled": true,
        "config": {
          // Required: provider/model ID for LLM-based emotion classification
          "classifierModel": "your-provider/your-model-id",

          // Optional: custom image directory (defaults to assets/ inside the plugin)
          // "imageDir": "/path/to/custom/assets",

          // Optional: override default emotion (defaults to "neutral")
          // "defaultEmotion": "neutral",

          // Optional: override emotion-to-filename mapping
          // "emotionMap": {
          //   "happy": "happy.png",
          //   "neutral": "neutral.png"
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
[plugins] emotion-image: LLM classifier enabled with model="your-provider/your-model-id"
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
| `classifierModel` | `string` | — | OpenClaw `provider/model` ID for LLM classification. **Required for LLM mode.** If not set, uses rule-based keyword matching only. |
| `imageDir` | `string` | `./assets` | Directory containing emotion image files |
| `defaultEmotion` | `string` | `"neutral"` | Fallback emotion when no match found |
| `emotionMap` | `object` | (built-in) | Mapping from emotion name → image filename |
| `emotionRules` | `object` | (built-in) | Custom keyword regex patterns per emotion (merged with defaults) |


## How It Works

Hent-ai operates in two phases:

1. **Phase 1 — Thinking Indicator** (`message_received` hook)
   - When a user sends a message, the plugin immediately sends a "focused" (thinking) image to the channel
   - This gives instant visual feedback before the bot responds

2. **Phase 2 — Emotion Classification** (`message_sent` hook)
   - After the bot sends a response, the plugin calls an LLM to classify the emotion of the response text
   - The classified emotion image is appended to the bot's message
   - If LLM classification fails, falls back to rule-based keyword matching


## Architecture

```
User message
  │
  ├─► [message_received hook]
  │     └─► Send focused.png to channel (instant)
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

The plugin automatically resolves the Discord bot token from your OpenClaw Discord channel configuration. No additional token setup is needed.

If you prefer, you can also set the `EMOTION_IMAGE_DISCORD_TOKEN` environment variable.

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
