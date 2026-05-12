# Hent-ai : Let your AI agent express its hent!!
<img width="294.5" height="363.5" alt="image" src="https://github.com/user-attachments/assets/fea635e3-9a20-4676-954f-464a1595c0e1" />

> *Let your AI agent express its hent (intent).*

---

**Emotion Image Attachment Plugin for OpenClaw**

"Hent" is a coined word meaning "intent".

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

## Quick Start

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


## Hermes Agent Support

Hent-ai also includes an experimental Hermes Agent plugin in `hermes/`.
This path is separate from the OpenClaw plugin and uses Hermes' plugin hook
system plus Gateway media delivery.

Quick install from a clone:

```bash
git clone https://github.com/IYENTeam/Hent-ai.git
cd Hent-ai
ln -s "$PWD/hermes" ~/.hermes/plugins/hent-ai
hermes plugins enable hent-ai
hermes gateway restart
```

For copy-based installation, custom assets, and platform filtering, see
[`hermes/README.md`](./hermes/README.md).

## Creating Emotion Images

You need 6 images that visually represent each emotion. Here's how to create a cohesive set.

### Recommended Approach: Character + Reference-Based Generation

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
