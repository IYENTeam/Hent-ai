## Summary

## Verification

- [ ] `node scripts/release-gate.mjs`
- [ ] No real image generation was triggered.
- [ ] Runtime-facing claims include tests, E2E evidence, or readback evidence.

## Architecture Boundary

- [ ] This change keeps OpenClaw service-thin: no local classifier, manifest scan, profile DB read, generation call, direct Discord REST, or delivery orchestration.
- [ ] If this changes service-owned classifier/profile/channel/asset/delivery behavior, an owner-approved architecture decision is linked.
- [ ] If this changes emotion contract behavior, `tests/fixtures/emotion-contract-v1.json` and all parity tests are updated.
