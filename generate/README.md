# @hent-ai/generate

Generate Hent-ai emotion image sets from a character prompt.

## Install

From this repository:

```bash
cd generate
npm ci
npm run build
npm test
```

Published-package consumers can use the package entrypoint and CLI after build:

```bash
hent-ai --help
```

## Usage

Generate the standard emotion set:

```bash
hent-ai generate \
  --character "polite gothic assistant" \
  --output ./assets/optimized \
  --concurrency auto
```

The generated set contains the canonical Hent-ai emotions:

- `happy`
- `neutral`
- `loyalty`
- `sorry`
- `confused`
- `focused`

## Compatibility

- Node.js 22 is the CI baseline.
- Image generation uses `god-tibo-imagen` and the configured provider credentials.
- The package uses npm locally; the repository root documents cross-package verification scripts.

## Verification

Before publishing or consuming a tarball, run:

```bash
npm run build
npm test
npm pack --dry-run --json
```

The tarball must include `dist/main.js` for the CLI and `dist/index.js` for library consumers.
