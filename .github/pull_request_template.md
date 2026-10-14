## Summary

## Verification

- [ ] `node scripts/release-gate.mjs`
- [ ] No real image generation was triggered.
- [ ] Runtime-facing claims include tests, E2E evidence, or readback evidence.

## Architecture Boundary

- [ ] This change keeps the service token-free: no Discord code or messenger token in `service/`; the session kit (`kit/`) stays dependency-free and fails open.
- [ ] If this changes service-owned classifier/profile/channel/asset/delivery behavior, an owner-approved architecture decision is linked.
- [ ] If this changes emotion contract behavior, `tests/fixtures/emotion-contract-v1.json` and all parity tests are updated.
