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

- `HENT_AI_SERVICE_URL`: Hent-ai HTTP service base URL. Defaults to
  `http://127.0.0.1:8787` when `HENT_AI_SERVICE_TOKEN` is set.
- `HENT_AI_SERVICE_TOKEN`: bearer token for Hent-ai service `/v1` endpoints.
  When set, Hermes delegates final-response verdict/media selection to the
  service.
- `HENT_AI_HERMES_CACHE_DIR`: directory for downloaded service media files.
  Defaults to `~/.cache/hent-ai/hermes-media`.
- `HENT_AI_HERMES_SERVICE_TIMEOUT_MS`: service request timeout in milliseconds.
  Defaults to `5000`.
- `HENT_AI_ASSET_DIR`: absolute path to a custom emotion image directory.
- `HENT_AI_HERMES_PLATFORMS`: comma-separated Hermes platforms that should
  receive emotion images. Defaults to `discord,telegram,slack,matrix,mattermost`.
  Set to `*` to allow all platforms.

## How it works

The plugin registers Hermes' `transform_llm_output` hook. For supported gateway
platforms, it strips any model-supplied `MEDIA:` directives, posts the final
assistant text to Hent-ai service `/v1/final-response/verdict`, downloads the
returned service media URL to a local cache file, and appends Hermes'
`MEDIA:<path>` directive. Hermes Gateway then sends the image using its native
media delivery path for the active platform.

When `HENT_AI_SERVICE_TOKEN` is configured, the service is authoritative: HTTP
errors, null verdicts, missing media, or failed media downloads leave the
Hermes response unchanged and do not fall back to local rules. Without a service
token, the plugin keeps the legacy local rule-based image selection path.
