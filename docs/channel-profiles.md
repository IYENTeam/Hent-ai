# 채널별 프로필(캐릭터) 설정 가이드

Hent-ai는 Discord 채널마다 다른 캐릭터 프로필을 매핑할 수 있습니다. 프로필마다 고유한 감정 이미지 세트와 성격(soul snippet)을 가지며, 채널에 진입하면 해당 프로필의 이미지와 페르소나가 자동으로 적용됩니다.

## 목차

- [핵심 개념](#핵심-개념)
- [프로필 구조](#프로필-구조)
- [프로필 등록](#프로필-등록)
- [채널-프로필 매핑](#채널-프로필-매핑)
- [플러그인 config 설정](#플러그인-config-설정)
- [채널 제어 (권장: defaultEnabled + overrides)](#채널-제어-권장-defaultenabled--overrides)
- [channel-overrides (레거시)](#channel-overrides-레거시)
- [동작 원리](#동작-원리)
- [주의사항](#주의사항)

---

## 핵심 개념

| 용어 | 설명 |
|------|------|
| **Profile** | 캐릭터 한 벌. ID, 이름, character 설명, soul snippet(성격), 모델 정보를 포함 |
| **Channel Mapping** | Discord 채널 ID → 프로필 ID 매핑. 채널별로 다른 캐릭터를 보여줌 |
| **defaultProfile** | 채널 매핑이 없을 때 사용하는 기본 프로필 ID |
| **Asset Set** | 감정 이미지 파일들의 집합 (manifest.json 기반) |
| **Soul Snippet** | 프로필에 연결된 성격 텍스트. 에이전트 프롬프트에 자동 주입됨 |

---

## 프로필 구조

### 데이터베이스 (SQLite)

프로필 데이터는 `<imageDir>/hentai.db`에 SQLite로 저장됩니다.

```
profiles 테이블:
  id          TEXT PRIMARY KEY    -- 프로필 슬러그 (예: "gothic", "cute-summer")
  name        TEXT NOT NULL       -- 표시 이름 (예: "고딕풍 이연")
  character   TEXT                -- 캐릭터 설명 (이미지 생성용)
  soul_snippet TEXT               -- 성격 텍스트 (프롬프트 주입용)
  model       TEXT                -- 이미지 생성 모델
  created_at  TEXT
  updated_at  TEXT

channel_profiles 테이블:
  channel_id  TEXT PRIMARY KEY    -- Discord 채널 snowflake ID
  profile_id  TEXT NOT NULL       -- → profiles.id (FK, CASCADE 삭제)
```

### 프로필 ID 규칙

- 소문자 영숫자, 하이픈(`-`), 언더스코어(`_`)만 허용
- 첫 글자는 문자 또는 숫자
- 최대 64자
- 경로 순회(`..`, `/`, `\`) 금지

```
✅ gothic, cute-summer, nibutani_v2
❌ ../hack, Gothic, 한글이름
```

### 이미지 디렉토리 레이아웃

```
<imageDir>/
├── hentai.db                  # SQLite DB (프로필 + 채널 매핑)
├── manifest.json              # 에셋 세트 매니페스트
├── channel-overrides.json     # 레거시 채널→세트 오버라이드
├── sets/                      # 에셋 세트별 이미지
│   ├── gothic-v1/
│   │   ├── happy.png
│   │   ├── neutral.png
│   │   └── ...
│   └── cute-v1/
│       └── ...
└── profiles/                  # 프로필별 이미지 (DB 기반)
    ├── gothic/
    │   ├── happy.png
    │   ├── neutral.png
    │   ├── sorry.png
    │   ├── confused.png
    │   └── focused.png
    └── cute-summer/
        └── ...
```

프로필 이미지 디렉토리(`profiles/<profileId>/`)가 존재하면 해당 디렉토리를 사용하고, 없으면 기본 `imageDir`로 폴백합니다.

---

## 프로필 등록

### CLI 스크립트

```bash
# 프로필 생성 예시 (nibutani 캐릭터)
npx tsx openclaw/scripts/create_nibutani.ts

# 프로필 전환 (채널 매핑)
npx tsx openclaw/scripts/switch_profile.ts \
  --channel 1234567890 \
  --profile gothic \
  --image-dir /path/to/assets
```

### 프로그래밍 방식

```typescript
import { ProfileDatabase } from "@hent-ai/shared/db";

const db = new ProfileDatabase("/path/to/imageDir");

// 1. 프로필 생성
db.createProfile({
  id: "gothic",
  name: "고딕풍 이연",
  character: "Dark gothic anime girl with long black hair",
  soulSnippet: "나는 어둡고 신비로운 분위기의 캐릭터야. 말투는 차분하고 약간 도도해.",
  model: "openai/dall-e-3",
});

// 2. 채널에 매핑
db.setChannelProfile("1234567890", "gothic");

// 3. 조회
db.getChannelProfile("1234567890");  // → "gothic"
db.listChannelProfiles();            // → [{ channelId: "1234567890", profileId: "gothic" }]
db.listProfiles();                   // → [{ id: "gothic", name: "고딕풍 이연", ... }]

// 4. 매핑 해제 (기본 프로필로 복귀)
db.removeChannelProfile("1234567890");

// 5. 프로필 삭제 (CASCADE로 채널 매핑도 함께 삭제)
db.deleteProfile("gothic");

db.close();
```

---

## 채널-프로필 매핑

### 매핑 방법 (switch_profile 스크립트)

```bash
# 특정 채널에 프로필 연결
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile <PROFILE_ID>

# 프로필 목록 확인
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile list

# 기본 프로필로 되돌리기
npx tsx openclaw/scripts/switch_profile.ts --channel <CHANNEL_ID> --profile default
```

### 프로필 해석 우선순위

메시지가 들어오면 다음 순서로 프로필을 결정합니다:

```
1. channel_profiles 테이블에서 채널 ID로 조회
2. 매핑이 없으면 → config의 defaultProfile 사용
3. defaultProfile도 없으면 → 기본 imageDir의 이미지 사용
```

코드 경로 (`profile-manager.ts`):

```typescript
export function resolveActiveProfileId(db, channelId, defaultProfileId) {
  if (channelId) {
    const mapped = db.getChannelProfile(channelId);
    if (mapped) return mapped;  // ← 채널 매핑 우선
  }
  return defaultProfileId ?? null;  // ← fallback
}
```

---

## 플러그인 config 설정

OpenClaw 플러그인 config (`openclaw.plugin.json`의 `configSchema` 기반)에서 설정합니다.

### 주요 설정 항목

```jsonc
{
  "plugins": {
    "entries": {
      "emotion-image": {
        "enabled": true,
        "config": {
          // 기본 프로필 ID (채널 매핑이 없는 채널에 적용)
          "defaultProfile": "gothic",

          // 이미지 디렉토리 (생략 시 워크스페이스 기반 자동 해석)
          "imageDir": "/path/to/emotion-image-assets",

          // 채널 on/off 정책
          "channels": {
            "defaultEnabled": true,
            "overrides": {
              "9999999999": false
            }
          },

          // Discord 봇 토큰 (환경변수 참조 가능)
          "discordToken": "${EMOTION_IMAGE_DISCORD_TOKEN}",

          // LLM 감정 분류 모델
          "classifierModel": "your-provider/gpt-4o-mini",

          // 기본 감정 (매칭 실패 시)
          "defaultEmotion": "neutral",

          // 감정별 이미지 매핑 (선택, manifest.json 우선)
          "emotionMap": {
            "happy": "happy.png",
            "neutral": [
              { "file": "neutral-shy.png", "label": "shy", "weight": 2 },
              { "file": "neutral-calm.png", "label": "calm", "weight": 1 }
            ]
          }
        }
      }
    }
  }
}
```

### defaultProfile 동작

`defaultProfile`이 설정되면:
- 채널 매핑이 없는 **모든 채널**에서 해당 프로필의 이미지와 페르소나 사용
- 채널별 매핑은 항상 defaultProfile보다 우선

---

## 채널 제어 (권장: defaultEnabled + overrides)

채널별 Hent-ai 활성/비활성은 이제 하나의 명확한 정책으로 표현합니다.

```jsonc
{
  "plugins": {
    "entries": {
      "emotion-image": {
        "enabled": true,
        "config": {
          "channels": {
            "defaultEnabled": true,
            "overrides": {
              "111111111": false, // 이 채널은 비활성
              "222222222": true   // 이 채널은 활성
            }
          }
        }
      }
    }
  }
}
```

판별 우선순위:

1. DB `channel_settings.enabled` — 런타임/스크립트에서 바꾼 채널별 명시 상태
2. config `channels.overrides[channelId]`
3. config `channels.defaultEnabled`
4. 기본값 `true`

> 설정 위치는 반드시 `plugins.entries["emotion-image"].config.channels`입니다.
> `plugins.emotion-image.channels` 또는 `plugins.entries.emotion-image.channels`는 플러그인 런타임에 전달되지 않습니다.

### 채널별 켜기/끄기 스크립트

```bash
# 특정 채널 비활성
npx tsx openclaw/scripts/set_channel_enabled.ts --channel 111111111 --enabled false --image-dir /path/to/emotion-image-assets

# 다시 활성
npx tsx openclaw/scripts/set_channel_enabled.ts --channel 111111111 --enabled true --image-dir /path/to/emotion-image-assets

# config 기본 정책으로 복귀
npx tsx openclaw/scripts/set_channel_enabled.ts --channel 111111111 --enabled default --image-dir /path/to/emotion-image-assets
```

### 레거시 blocklist / allowlist

기존 설정도 하위 호환으로 동작하지만 새 설정에서는 권장하지 않습니다.

```jsonc
{
  "channels": {
    "mode": "blocklist",
    "list": ["111111111", "222222222"]
  }
}
```

```jsonc
{
  "channels": {
    "mode": "allowlist",
    "list": ["333333333", "444444444"]
  }
}
```

레거시 `allowlist`/`blocklist`에서 `list: []`는 하위 호환을 위해 기존처럼 **전체 활성**입니다. 전체 비활성이 필요하면 새 형식 `defaultEnabled: false`를 사용하세요.

## channel-overrides (레거시)

DB 기반 프로필 시스템 이전에 사용하던 방식입니다. `channel-overrides.json` 파일로 채널별 에셋 세트를 지정합니다.

```json
// <imageDir>/channel-overrides.json
{
  "1234567890": "gothic-v1",
  "9876543210": "cute-v1"
}
```

### 현재 동작

DB `channel_settings.asset_set_id`가 우선이고, 그 다음 하위 호환용 `channel-overrides.json`가 참조됩니다.

```
채널 매핑 조회 순서:
1. ProfileDatabase.getChannelProfile(channelId) → 프로필 ID
2. (없으면) channel-overrides.json에서 에셋 세트 ID
3. (없으면) manifest.json의 activeSet
4. (없으면) 기본 emotionMap
```

> **권장:** 새 채널별 에셋 세트 전환은 `channel_settings.asset_set_id`를 사용하는 `set_channel_mode.ts`를 사용하세요. `channel-overrides.json`는 하위 호환을 위해서만 유지됩니다.

---

## 동작 원리

### 메시지 수신 시 (message_received)

1. 사용자 메시지 수신
2. `createChannelEnabledResolver(...)`로 채널 활성 상태 확인
3. 채널의 활성 프로필에서 이미지 디렉토리 결정 (`resolveProfileImageDirForChannel`)
4. 응원 요청 감지 → cheer 이미지 생성 (별도 흐름)
5. `focused` 감정 이미지를 "생각 중" 표시로 전송

### 메시지 발신 시 (message_sent)

1. 봇 메시지 발신 성공
2. `createChannelEnabledResolver(...)`로 채널 활성 상태 확인
3. 채널의 활성 프로필 기반으로 이미지 디렉토리 및 emotionMap 결정
4. LLM 또는 규칙 기반으로 감정 분류
5. 해당 감정의 이미지를 메시지에 첨부 (Discord PATCH API)

### Dynamic Persona (성격 주입)

프로필에 `soulSnippet`이 설정되어 있으면, 에이전트 프롬프트에 자동으로 주입됩니다:

```typescript
// dynamic-persona.ts
function buildDynamicPrompt(basePrompt, soulSnippet) {
  return basePrompt + "\n\n--- Hent-ai Character ---\n" + soulSnippet;
}
```

채널별로 다른 성격의 응답을 생성할 수 있습니다.

---

## 주의사항

1. **프로필 ID는 변경 불가** — 한 번 생성하면 ID는 바뀌지 않습니다. 이름(`name`)은 `updateProfile`로 변경 가능합니다.

2. **프로필 삭제 시 CASCADE** — 프로필을 삭제하면 연결된 채널 매핑도 함께 삭제됩니다.

3. **이미지 디렉토리 필수** — `profiles/<profileId>/` 디렉토리에 감정 이미지가 없으면 기본 `imageDir`로 폴백합니다. 프로필만 DB에 있고 이미지가 없으면 의도와 다른 이미지가 표시될 수 있습니다.

4. **Discord 토큰 필요** — 이미지 첨부는 Discord REST API를 직접 호출합니다. `EMOTION_IMAGE_DISCORD_TOKEN` 환경변수 또는 config의 `discordToken`이 필수입니다.

5. **경로 보안** — 이미지 경로는 반드시 `imageDir` 내부로 제한됩니다. 절대경로나 `..`을 포함한 경로는 자동으로 거부됩니다 (`assertPathInside`).

6. **channel-overrides는 레거시** — 새 채널 활성/에셋 세트 상태는 DB `channel_settings`를 사용하세요.

7. **온보딩 중 이미지 비활성** — `.onboarding-active` 락 파일이 존재하면 감정 이미지 첨부가 자동으로 비활성화됩니다.
