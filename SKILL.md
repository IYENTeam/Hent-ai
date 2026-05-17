---
name: hent-ai
description: "Hent-ai setup and onboarding skill. Guides the user through installing the emotion-image plugin and creating custom character + emotion images interactively. Triggers when: the user asks to set up Hent-ai, install emotion images, create character images, or follow this repo's README."
---

# Hent-ai Setup

You are setting up the Hent-ai emotion-image plugin for the user. Read the platform-specific README for installation, then run onboarding to create emotion images interactively.

## Step 1: Identify Platform

Ask which platform the user is on (or detect from context):

| Platform | README | Plugin type |
|----------|--------|-------------|
| OpenClaw | `openclaw/README.md` | OpenClaw plugin |
| Cursor | `cursor/README.md` | Cursor rule + classifier |
| Hermes Agent | `hermes/README.md` | Hermes integration |

Read the relevant README for installation instructions. Follow them to install the plugin for the user's platform.

## Step 2: Create Emotion Images (Onboarding)

After the plugin is installed, create the character's emotion images. This is an interactive, conversational process — do it one step at a time.

### 2a. Character Description

Ask the user to describe their character (e.g. "cute orange cat", "pixel art robot"). They may also attach a reference image.

If they attach an image, ask:
- Use it **directly** as the base character, or
- Use it as a **style reference** for generation

### 2b. Generate Base Character

Generate with `image_generate`:
```
[user's description], clean illustration style, square format, simple background, high quality PNG
```

Show the result. Wait for approval.
- Approved → save as `base.png`, proceed
- Feedback → regenerate with feedback incorporated
- Cancel (`취소`/`cancel`/`종료`/`그만`) → abort onboarding

### 2c. Generate 6 Emotion Variants

For each emotion **one at a time**, use the base image as reference:

| Emotion | File | Visual cues |
|---------|------|-------------|
| happy | `happy.png` | smiling, celebrating, thumbs up |
| neutral | `neutral.png` | calm, relaxed, default expression |
| loyalty | `loyalty.png` | saluting, nodding, attentive |
| sorry | `sorry.png` | apologetic, bowing, sheepish |
| confused | `confused.png` | head tilt, question mark, puzzled |
| focused | `focused.png` | concentrating, working, determined |

Prompt template:
```
Same character as the reference image, expressing [emotion]. [visual cues]. Simple background, consistent art style.
```

For each image: show result → wait for approval or feedback → save on approval. The user can also attach their own image to use directly.

### 2d. Save Location

Save all images to the plugin's asset directory:
- **OpenClaw**: the configured `imageDir`, or `~/.openclaw/workspace/.hent-ai/emotion-image-assets/`, or `assets/` in this repo
- **Cursor**: `cursor/assets/optimized/`
- **Other**: `assets/` in this repo

### 2e. Complete

Confirm all 7 images saved (base + 6 emotions). Tell the user the plugin is ready — their agent's responses will now have emotion images attached automatically.

## Rules

- One emotion at a time. Never batch-generate.
- Never generate text or speech bubbles in images.
- Keep the same character identity across all variants.
- Respond in the user's language.
- User can abort anytime: `취소`, `cancel`, `종료`, `그만`

## Advanced: Labeled Image Pools

After basic setup, users can add multiple images per emotion with labels for context-aware selection:

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

Labels are auto-inferred from filenames (e.g. `happy-date-night.png` → `date night`). Hent-ai prefers images whose label matches the bot response context.
