# Classifier customization

Hent-ai currently has three runtime surfaces. Keep classifier behavior changes explicit because the supported customization level differs by surface.

## Cursor

Cursor uses the TypeScript rule classifier in `cursor/src/classifier/`. It supports the packaged rule set and plugin-side configuration used by the Cursor integration.

## OpenClaw

OpenClaw uses the OpenClaw plugin runtime under `openclaw/`. It can apply OpenClaw-specific preprocessing and plugin configuration before selecting an emotion image.

## Hermes

Hermes uses the Python plugin under `hermes/`. Its classifier path is intentionally lightweight and should be treated as a compatibility surface, not the source of truth for advanced TypeScript customization.

## Change checklist

When changing classifier rules or customization behavior:

1. Update the relevant runtime implementation.
2. Add or update tests for every runtime whose behavior is expected to match.
3. Document any intentional differences in this file.
4. Run `npm test --prefix cursor`, `npm test --prefix openclaw`, and `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest tests/hermes/ -v` when those surfaces are affected.
