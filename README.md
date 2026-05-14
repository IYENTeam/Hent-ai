# Hent-ai : Let your AI agent express its hent!!
<img width="294.5" height="363.5" alt="image" src="https://github.com/user-attachments/assets/fea635e3-9a20-4676-954f-464a1595c0e1" />

> *Let your AI agent express its hent (intent).*

---

"Hent" is a coined word meaning "intent".

Hent-ai automatically classifies the emotion of every bot response using LLM and attaches a matching emotion image to Discord messages. It supports both **OpenClaw** and **Hermes Agent** platforms.

### Supported Emotions

| Emotion | When Used |
|---------|-----------|
| `happy` | Success, completion, celebration |
| `neutral` | General responses, informational |
| `loyalty` | Acknowledgment, greeting |
| `sorry` | Apology, mistakes |
| `confused` | Uncertainty, questions |
| `focused` | Working, investigating, debugging |

## Getting Started

Choose your platform:

- **OpenClaw** → see [`openclaw/README.md`](./openclaw/README.md)
- **Hermes Agent** → see [`hermes/README.md`](./hermes/README.md)

## Creating Emotion Images

You need 6 images that visually represent each emotion. You can generate them automatically with the CLI tool, or create them manually.

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

## License

MIT
