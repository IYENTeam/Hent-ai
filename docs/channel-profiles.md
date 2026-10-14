# 채널별 프로필/정책: 서비스 아키텍처

Hent-ai의 채널별 프로필, 채널 매핑, 에셋 선택은 Hent-ai HTTP 서비스가 소유합니다. 어떤 채널에서 봇이 듣고 답하는지는 `hent bridge`의 `~/.hent/channels.json`(`hent channels`)이 정하고, 무엇을 말할지는 `hent-mode` 세션이 정합니다. ([ADR-0002](adr/ADR-0002-session-brain-bridge.md))

## 핵심 개념

| 용어 | 소유자 | 설명 |
| --- | --- | --- |
| Profile | Hent-ai service | 캐릭터/성격/모델/에셋 연결 정보 |
| Channel mapping | Hent-ai service | Discord channel ID → profile/asset set mapping |
| Channel listening | `hent bridge` | `channels.json`에 있는 채널은 모두 세션으로 전달 (모드 없음, 답할지는 세션이 판단) |
| Asset set/storage | Hent-ai service | imported/generated 이미지와 metadata |
| Affect asset routing | Hent-ai service | 세션이 준 `ResponseAffectV2`로 매핑된 세트 전체를 nearest-neighbor ranking |
| Media delivery | 세션 (`hent send`) | 서비스가 고른 이미지를 받아 bridge로 첨부 전송 |

## 흐름

```text
Discord 메시지
  └─ hent bridge가 기록 후 세션에 "[hent] INBOUND" 한 줄로 push
       └─ 세션이 답할지 판단 (kit/skill/hent-mode/references/conversation.md)
            ├─ 답함: hent send --reply-to <id> --text ... --affect ...
            │    └─ POST /v1/final-response/verdict (2초 제한) → 이미지 첨부, 실패 시 텍스트만
            └─ 안 답함: hent skip <id>
```

선제 이미지(pre-reply media)는 `hent media --pre-reply`로 받아 `hent send --file`로 보냅니다. 서비스가 느리거나 죽어도 답장은 지연 없이 텍스트로 나갑니다.

## Service APIs for profiles/channels

The service package is responsible for exposing profile/channel management APIs, for example:

- profile list/get/create/update
- channel profile/mode mapping get/set
- cron-enabled channel allowlist list/revision API for community polling
- asset-set import and storage metadata
- generation/onboarding job state

Use those service APIs or service CLI tools for channel-profile changes. Local `hentai.db`, `manifest.json`, and `channel-overrides.json` are not runtime sources of truth.

Discord threads need their own mapping: `hent send --to <thread id>` asks the service with the thread id, so a parent-channel mapping does not automatically cover thread ids.

`VisualAffectV2`는 실제 이미지 픽셀에서 측정한 24차원 값과 SHA provenance를 포함합니다.
service importer가 동일 순서의 vector를 저장하고, final response의 `ResponseAffectV2`와 weighted
distance로 mapped set 전체를 순위화합니다. 최소 거리가 같은 후보는 랜덤 선택합니다. 후보 중
하나라도 tag/vector가 없거나 서로 다르면 V2 모드를 활성화하지 않고 legacy fallback으로
처리합니다. 세션과 bridge는 tag/vector를 읽거나 순위를 매기지 않습니다.

## Migration note

OpenClaw and Hermes adapters were removed (ADR-0002). Channels move from OpenClaw to the session one
at a time; see the Cutover section of `docs/agent-runbook.md`.

## Runtime validation checklist

- `curl -s 127.0.0.1:8789/v1/health` on the bridge host reports `"gateway":"connected"`.
- `hent channels list` shows the channel in `reply` or `ambient` mode.
- The target channel or thread id has an enabled service mapping.
- A test message in the channel produces one `hent send` line `SENT <id> media=yes`.
