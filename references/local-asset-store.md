# External Local Asset Store

Runtime image pools live outside the repository. A new local deployment should use `~/.hent-ai/assets`; an existing deployment must keep its configured absolute `HENT_AI_ASSET_ROOT` until a verified migration switches it.

Expected layout:

```text
<asset-root>/
  manifest.json
  sets/
    <set-id>/
      *.png
```

The external manifest owns runtime set metadata and `affectAssets`. The repository owns schemas, migration code, tests, and documentation only.

For a new Codex-generated set, `npm run setup:affect -- ... --apply` automates this sequence and keeps its resumable state in a sibling `setup/` directory. Read [codex-image-generation-and-tagging.md](codex-image-generation-and-tagging.md) for generation-time tagging and the terminal verification contract.

## Migration Sequence

1. Resolve the source and target to absolute paths and verify they differ.
2. Validate safe set IDs and filenames, exactly one manifest entry per image, regular files only, and matching SHA-256 provenance.
3. Run `affect-store` without `--apply`; record count, bytes, checksum, and destination.
4. Back up the live database and service-manager configuration.
5. Re-run with `--apply --activate`. Existing identical files may resume; different bytes must abort rather than overwrite.
6. Import the external manifest into the service database using Node.js 22.
7. Map only intended channels to the new set. Bump the verifier/asset cache-policy version when the affect contract changes so legacy cached verdicts cannot bypass V2.
8. Change `HENT_AI_ASSET_ROOT`, restart, and verify health, routed filename, routing mode, stored object hash, HTTP response bytes, and a real OpenClaw/Discord message.
9. After all checks pass, remove the staged generated pool and runtime manifest entry from the repository. Keep the backed-up DB and previous service configuration for rollback.

Do not copy secrets into scripts or documentation. Read them from the existing service environment when an authenticated local check is necessary.
