# Hent-ai for Hermes Agent

This directory contains the Hermes Agent plugin entrypoint for Hent-ai.
It is separate from the OpenClaw TypeScript plugin and does not change the
existing OpenClaw integration.

## Install from a clone

```bash
git clone https://github.com/IYENTeam/Hent-ai.git
cd Hent-ai
ln -s "$PWD/hermes" ~/.hermes/plugins/hent-ai
hermes plugins enable hent-ai
hermes gateway restart
```

The symlinked layout lets the plugin reuse the repository-level `assets/`
directory.

## Install by copying

```bash
git clone https://github.com/IYENTeam/Hent-ai.git
mkdir -p ~/.hermes/plugins/hent-ai
cp -R Hent-ai/hermes/* ~/.hermes/plugins/hent-ai/
cp -R Hent-ai/assets ~/.hermes/plugins/hent-ai/assets
hermes plugins enable hent-ai
hermes gateway restart
```

## Configuration

Optional environment variables:

- `HENT_AI_ASSET_DIR`: absolute path to a custom emotion image directory.
- `HENT_AI_HERMES_PLATFORMS`: comma-separated Hermes platforms that should
  receive emotion images. Defaults to `discord,telegram,slack,matrix,mattermost`.
  Set to `*` to allow all platforms.

## How it works

The plugin registers Hermes' `transform_llm_output` hook. For supported gateway
platforms, it detects the emotion of the final assistant response and appends a
Hermes `MEDIA:<path>` directive. Hermes Gateway then sends the image using its
native media delivery path for the active platform.

The initial Hermes implementation is intentionally rule-based. Optional
`ctx.llm` classification can be added later without changing the OpenClaw plugin.
