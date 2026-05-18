# @hent-ai/generate

Generate emotion images for Hent-ai using Codex image generation.

## Overview

This package provides both CLI and programmatic APIs to generate consistent emotion image sets for the Hent-ai chatbot. It generates a base character image and then creates 6 emotion variants (happy, neutral, loyalty, sorry, confused, focused) using that base as a reference, ensuring visual consistency across all emotions.

## Installation

```bash
npm install @hent-ai/generate
```

## Requirements

- **Node.js**: v18 or later
- **Codex Authentication**: You must be logged in via the Codex CLI before using this package.

```bash
# Install Codex CLI globally
npm install -g codex

# Authenticate
codex login
```

The package reads Codex credentials from `~/.codex/auth.json`.

## CLI Usage

The `hent-ai` CLI command generates all 6 emotion images with a single invocation.

### Basic Usage

```bash
# Generate all emotions from a character description
hent-ai --character "cute orange cat"
```

This will:
1. Generate a base character image from your description
2. Use the base as a reference to generate 6 emotion variants
3. Save all images to `./assets/` directory

Output files: `base.png`, `happy.png`, `neutral.png`, `loyalty.png`, `sorry.png`, `confused.png`, `focused.png`

### Using an Existing Base Image

If you already have a base character image:

```bash
hent-ai --character "cute orange cat" --base ./my-base.png
```

This skips base generation and uses your provided image as the reference.

### CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `-c, --character` | Character description (required) | — |
| `-b, --base` | Existing base image path (skips base generation) | — |
| `-o, --output` | Output directory | `./assets` |
| `-m, --model` | Codex model | `gpt-5.4` |
| `-s, --size` | Image size (e.g. `1024x1024`) | `1024x1024` |
| `--no-keep-base` | Don't save base.png to output | — |

### Examples

```bash
# Custom output directory
hent-ai --character "robot assistant" --output ./my-images

# Use a different model
hent-ai --character "dragon mascot" --model gpt-4.5

# Generate smaller images
hent-ai --character "pixel art hero" --size 512x512

# Use existing base and don't save it again
hent-ai --character "wizard" --base ./wizard.png --no-keep-base
```

## Programmatic API

### generateAllEmotions

Generate all 6 emotion images programmatically.

```typescript
import { generateAllEmotions } from "@hent-ai/generate";

const results = await generateAllEmotions({
  character: "cute orange cat",
  outputDir: "./assets",
  model: "gpt-5.4",
  size: "1024x1024",
  keepBase: true,
});

// results is a Map<Emotion | "base", string>
console.log(results.get("happy")); // ./assets/happy.png
```

#### Options

```typescript
interface GenerateAllOptions {
  /** Character description for image generation */
  character: string;
  
  /** Output directory for generated images */
  outputDir: string;
  
  /** Optional existing base image path (skips base generation) */
  baseImagePath?: string;
  
  /** Codex model to use */
  model?: string;
  
  /** Image size (e.g. "1024x1024") */
  size?: string;
  
  /** Whether to save base.png to output directory */
  keepBase?: boolean;
}
```

#### Return Value

Returns `Promise<Map<Emotion | "base", string>>` where each key maps to the absolute file path of the generated image.

### generateImage

Low-level API for single image generation.

```typescript
import { generateImage } from "@hent-ai/generate";

const pngBuffer = await generateImage({
  prompt: "a happy cat giving a thumbs up",
  model: "gpt-5.4",
  size: "1024x1024",
  referenceImages: ["data:image/png;base64,..."], // optional
});

// pngBuffer is a Buffer containing PNG data
await fs.writeFile("output.png", pngBuffer);
```

#### Options

```typescript
interface GenerateOptions {
  /** Text prompt for image generation */
  prompt: string;
  
  /** Codex model to use */
  model?: string;
  
  /** Image size (e.g. "1024x1024") */
  size?: string;
  
  /** Optional reference images as data URLs (max 3) */
  referenceImages?: string[];
  
  /** Optional provider for rephrasing prompts on safety rejections */
  rephraseProvider?: RephraseProvider;
}
```

#### Return Value

Returns `Promise<Buffer>` containing PNG image data.

### EMOTIONS

Constant array of all supported emotion names.

```typescript
import { EMOTIONS, type Emotion } from "@hent-ai/generate";

console.log(EMOTIONS);
// ["happy", "neutral", "loyalty", "sorry", "confused", "focused"]

// Use as type
const emotion: Emotion = "happy";
```

## Technical Details

### Reference Image Handling

- **Maximum 3 reference images** per generation request
- Images larger than 768px are automatically resized (preserving aspect ratio) to reduce payload size and prevent timeouts
- Reference images are converted to data URLs for API submission

### Safety Rephrase

If a prompt triggers a content-policy rejection and a `rephraseProvider` is configured, the prompt is automatically rephrased and retried (up to 3 attempts).

**Note**: The CLI does not support automatic safety rephrase. For production use with automatic rephrase on content-policy rejections, use the OpenClaw Discord onboarding flow instead.

### Emotion Prompts

Each emotion uses a carefully crafted prompt template:

- **happy**: smiling brightly, giving a thumbs up, celebrating with joy
- **neutral**: calm and relaxed, default resting expression, at ease
- **loyalty**: saluting attentively, nodding with respect, ready to help
- **sorry**: looking apologetic, bowing slightly, sheepish expression
- **confused**: tilting head with a puzzled look, question mark above head
- **focused**: concentrating intensely, determined expression, working hard

## License

MIT
