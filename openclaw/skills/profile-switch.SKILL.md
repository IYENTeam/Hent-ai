---
name: "profile-switch"
description: "Switch Hent-ai character profiles per Discord channel. Triggers on: 'profile switch', 'change character', '프로필 바꿔', '캐릭터 전환', 'switch to <name>'."
user-invocable: true
---

# Profile Switch

Switch a Discord channel's active character profile. Each profile has its own emotion images and optional personality.

## Invocation

User says any of:
- "프로필 바꿔줘", "캐릭터 바꿔", "프로필 전환"
- "switch profile", "change character", "use gothic profile"
- "프로필 목록", "list profiles"
- "기본 프로필로", "default profile"

## Procedure

### List available profiles

```bash
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile list --image-dir <IMAGE_DIR>
```

Or query the DB directly: profiles are stored in `<imageDir>/hentai.db`.

### Switch channel to a profile

```bash
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile <PROFILE_ID>
```

Then confirm: "이 채널의 프로필이 '<PROFILE_NAME>'(으)로 전환되었습니다."

### Revert to default profile

```bash
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile default
```

Then confirm: "기본 프로필로 돌아갑니다."

### With custom image directory

```bash
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile <PROFILE_ID> --image-dir /path/to/assets
```

## Channel ID

The Discord channel ID is the numeric snowflake. Extract it from the conversation context (metadata.to field in OpenClaw, formatted as `channel:123456789`). Strip the `channel:` prefix and pass the numeric part.

## Rules

- Only execute when the user explicitly requests a profile change.
- The change is per-channel and persists across bot restarts (stored in SQLite).
- If the requested profile doesn't exist, the script exits with an error. Inform the user.
- Permission check: if `allowedUsers` is configured in the plugin config, verify the requesting user is in the list before executing.

## Prerequisites

- Profiles must be created first (via onboarding, CLI, or manual setup).
- Each profile needs emotion images at `imageDir/profiles/<profileId>/`.
- The profile must be registered in the SQLite database (`imageDir/hentai.db`).

## References

- Profile manager: `openclaw/profile-manager.ts`
- Dynamic persona: `openclaw/dynamic-persona.ts`
- Migration from legacy: `openclaw/migration.ts`
- SQLite database: `shared/db.ts`
