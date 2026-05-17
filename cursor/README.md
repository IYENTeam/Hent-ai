# Hent-ai for Cursor

A Cursor plugin that classifies the emotion of AI agent responses and displays a matching character image at the end of each reply.

## Install

### Option 1: npx (recommended)

```bash
npx hent-ai-cursor install global
```

Works across all Cursor projects.

### Option 2: Project-only

```bash
cd your-project
npx hent-ai-cursor install project
```

### Option 3: Global install

```bash
npm install -g hent-ai-cursor
hent-ai install global
```

After installing, reload Cursor: `Cmd+Shift+P` → `Developer: Reload Window`

## Uninstall

```bash
npx hent-ai-cursor uninstall global    # remove global
npx hent-ai-cursor uninstall project   # remove from project
```

## Status

```bash
npx hent-ai-cursor status
```

## How It Works

A single Cursor Rule (`.cursor/rules/hent-ai.mdc`) instructs the agent to:

1. Answer the user's question completely
2. Self-classify the response emotion (happy, sorry, confused, focused, loyalty, neutral)
3. Output the matching character image as markdown at the very last line

No external API calls, no hooks — just one Cursor Rule.

## Emotions

| Emotion | Description | Trigger Examples |
|---------|-------------|-----------------|
| happy | Done! | Task completed, success, tests passed |
| sorry | Sorry... | Error occurred, mistake, failure |
| confused | Hmm... | Uncertain, need more info |
| focused | Analyzing... | Debugging, code analysis, investigating |
| loyalty | Got it | Acknowledged, greeting, starting task |
| neutral | Calm | General info, none of the above |

## Custom Images

To replace the default images, swap the PNG files in the install path:

- Global: `~/.hent-ai/assets/optimized/`
- Project: `.cursor/hent-ai/assets/optimized/`

Filenames must be `happy.png`, `sorry.png`, `confused.png`, `focused.png`, `loyalty.png`, `neutral.png`. Recommended size: 256x256 or smaller.

## License

MIT
