---
name: hent-ai
description: "Hent-ai setup and onboarding skill. Read the relevant docs, infer the user's goal and platform, then help create/install character emotion assets without a fixed questionnaire. Triggers when: the user asks to set up Hent-ai, install emotion images, create character images, or follow this repo's README."
---

# Hent-ai Setup

You are setting up the Hent-ai emotion-image plugin for the user. Read the platform-specific README first, inspect the repository/configuration as needed, then choose the next useful action. Do not run a scripted questionnaire; use the docs as operating instructions and adapt to what the user already provided.

## Step 1: Identify Platform

Detect the platform from context when possible. Ask only if the repository, config, or user's request does not make the platform clear:

| Platform | README | Plugin type |
|----------|--------|-------------|
| OpenClaw | `openclaw/README.md` | OpenClaw plugin |
| Hermes Agent | `hermes/README.md` | Hermes integration |

Read the relevant README for installation instructions. Follow them to install the plugin for the user's platform.

## Step 2: Create Emotion Images (Onboarding)

After the plugin is installed, create or install the character's emotion images. Treat this as an agent-led task, not a fixed form. Gather only missing information that blocks the next action, reuse attachments/descriptions/config already present, and keep the user in the loop at meaningful approval points.

### 2a. Understand the Character Goal

Read the user's request and available context to infer the character concept. If the concept is missing or ambiguous, ask one concise clarifying question. The user may attach a reference image.

If they attach an image, decide from context whether it should be used directly as the base character or as a style/reference image. Ask only when that choice is genuinely ambiguous.

### 2b. Generate Base Character

Generate with `image_generate`:
```
[user's description], clean illustration style, square format, simple background, high quality PNG
```

Show the result when generation is involved and get approval before treating it as the canonical base character.
- Approved → save as `base.png`, proceed
- Feedback → regenerate or edit with feedback incorporated
- Cancel (`취소`/`cancel`/`종료`/`그만`) → abort onboarding

### 2c. Generate 6 Emotion Variants

Create the required emotion set using the base image as reference. Work in small batches only when the user explicitly wants speed; otherwise preserve quality and consistency over rigid sequencing.

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

For generated images, show enough output for the user to judge consistency. Save approved images with the expected filenames. The user can also attach their own image to use directly.

### 2d. Save Location

Save all images to the plugin's asset directory:
- **OpenClaw**: the configured `imageDir`, or `~/.openclaw/workspace/.hent-ai/emotion-image-assets/`, or `assets/` in this repo
- **Other**: `assets/` in this repo

### 2e. Complete

Confirm all 7 images saved (base + 6 emotions). Tell the user the plugin is ready — their agent's responses will now have emotion images attached automatically.

## Rules

- Do not follow a fixed questionnaire when the answer can be inferred from docs, config, files, or prior conversation.
- Ask at most one blocking question at a time.
- Prefer agentic progress: read docs, inspect paths, generate/copy/save assets, and verify files exist.
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
