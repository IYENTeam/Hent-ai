# 채널별 프로필/정책: 서비스 아키텍처

Hent-ai의 채널별 프로필, 채널 정책, 에셋 선택은 이제 Hent-ai HTTP 서비스가 소유합니다. `openclaw/` 확장은 더 이상 SQLite DB, `manifest.json`, `channel-overrides.json`, 로컬 이미지 디렉토리, classifier fallback을 읽지 않습니다. OpenClaw 확장은 미디어 lifecycle hook을 서비스에 전달하고 결과 media만 OpenClaw에 반환하는 얇은 adapter입니다.

## 핵심 개념

| 용어 | 현재 소유자 | 설명 |
| --- | --- | --- |
| Profile | Hent-ai service | 캐릭터/성격/모델/에셋 연결 정보 |
| Channel mapping | Hent-ai service | Discord/OpenClaw channel ID → profile/mode mapping |
| Channel policy | Hent-ai service | 채널별 활성화, date-mode, private-mode, 민감 미디어 정책 |
| Asset set/storage | Hent-ai service | imported/generated 이미지와 metadata |
| OpenClaw media delivery | OpenClaw | adapter가 반환한 `mediaUrl`을 텍스트 lifecycle에 맞춰 전송/append |

## OpenClaw adapter 설정

OpenClaw 플러그인 config에는 서비스 접속 정보만 필요합니다.

```jsonc
{
  "plugins": {
    "entries": {
      "hent-ai-service-adapter": {
        "enabled": true,
        "config": {
          "hentAiService": {
            "url": "https://hent-ai.example.com",
            "token": "${HENT_AI_SERVICE_TOKEN}",
            "timeoutMs": 5000
          }
        }
      }
    }
  }
}
```

- `hentAiService.url`: 필수. localhost가 아닌 URL은 HTTPS여야 합니다.
- `hentAiService.token`: 필수. literal token 또는 `${ENV_VAR}` placeholder를 지원합니다.
- `hentAiService.timeoutMs`: 선택. 요청 timeout이며 기본값은 5000ms입니다.

설정이 없거나 유효하지 않으면 adapter는 hook을 등록하지 않고 disabled 상태를 로그에 남깁니다.

## Hook 흐름

```text
User message
  └─ OpenClaw pre_reply_media
       └─ adapter POST /v1/pre-reply/media
            └─ service decides channel/profile/policy/media
       └─ adapter returns { media, diagnostics }
  └─ OpenClaw sends pre-reply text + media, or text-only on skip

Final text sent
  └─ OpenClaw message_sent_media
       └─ adapter POST /v1/final-response/verdict
            └─ service decides verdict.media
       └─ adapter returns { media, diagnostics }
  └─ OpenClaw appends/edits/follows up media, or does nothing on skip
```

Adapter failure behavior is non-blocking. Timeout, network error, HTTP error, `null`, or malformed media returns `media:null` with diagnostics so OpenClaw text continues.

## Service APIs for profiles/channels

The service package is responsible for exposing profile/channel management APIs, for example:

- profile list/get/create/update
- channel profile/mode mapping get/set
- asset-set import and storage metadata
- generation/onboarding job state

Use those service APIs or service CLI tools for channel-profile changes. Do not update `openclaw/` plugin config, local `hentai.db`, `manifest.json`, or `channel-overrides.json` expecting runtime adapter changes; those files are no longer adapter runtime sources of truth.

## Migration note

Older docs described a thick OpenClaw plugin that:

- read `@hent-ai/shared/db`
- scanned manifests and local asset folders
- applied channel toggles locally
- classified final text locally
- patched Discord messages directly

That behavior has been removed from `openclaw/`. The service is the only Hent-ai runtime authority; OpenClaw owns text/media delivery mechanics.
