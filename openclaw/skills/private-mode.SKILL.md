---
name: "private-mode"
description: "Per-channel asset set switching for Hent-ai emotion images. Triggers on: 'private mode on', 'private 모드', 'private off', '일반 모드', set switching requests."
user-invocable: true
---

# Private Mode

Switch a Discord channel's emotion image set between `default` and `private` (or any named set registered in the manifest).

## Invocation

User says any of:
- "private 모드 켜줘", "private mode on", "프라이빗 모드"
- "일반 모드로", "normal mode", "private off", "기본 모드"
- "에셋 세트 바꿔줘", "set to {name}"

## Procedure

### Enable private mode

```bash
cd ~/.clawhip/github/IYENTeam/Hent-ai && npx tsx openclaw/scripts/set_channel_mode.ts --channel <CHANNEL_ID> --mode private
```

Then confirm to the user: "이 채널은 private 모드로 전환되었습니다."

### Disable private mode (revert to default)

```bash
cd ~/.clawhip/github/IYENTeam/Hent-ai && npx tsx openclaw/scripts/set_channel_mode.ts --channel <CHANNEL_ID> --mode default
```

Then confirm: "일반 모드로 돌아갑니다."

### Switch to any named set

```bash
cd ~/.clawhip/github/IYENTeam/Hent-ai && npx tsx openclaw/scripts/set_channel_mode.ts --channel <CHANNEL_ID> --mode <SET_ID>
```

## Channel ID

The Discord channel ID is the numeric snowflake. Extract it from the conversation context (metadata.to field in OpenClaw, formatted as `channel:123456789`). Strip the `channel:` prefix and pass the numeric part.

## Rules

- Only execute when the user explicitly requests a mode change.
- The change is per-channel and persists across bot restarts.
- If the requested set doesn't exist in the manifest, the plugin silently falls back to the default. Warn the user if you suspect the set isn't set up yet.
- Permission check: if `allowedUsers` is configured in the plugin config, verify the requesting user is in the list before executing.

## Prerequisites

- The `private` set must exist at `imageDir/sets/private/` with emotion PNGs.
- The set must be registered in `imageDir/manifest.json`.
- To create private assets, use the onboarding flow or manually place images and run the manifest registration.

## References

- Asset manifest system: `openclaw/assets/manifest.ts`
- Channel overrides persistence: `openclaw/assets/channel-overrides.ts`
- Plugin reads overrides on each request: `openclaw/index.ts` → `getEmotionMapForChannel()`
