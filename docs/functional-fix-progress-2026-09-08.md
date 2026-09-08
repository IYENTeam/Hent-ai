# 기능 수정 진행 기록 — 2026-09-08

기준 조사: [기능·빌드·코드 위생 조사](functional-review-2026-09-08.md), 기준 커밋 `b091cc4`. 통합 작업 브랜치는 `codex/functional-runtime-fixes`였으며, 아래 독립 PR들로 나누었다. 아직 dev에 병합되거나 운영에 배포된 수정이라는 뜻은 아니다. 사이버 보안 취약점 조사·재현은 제외했다. 이번 변경은 우선순위 P1 8개와 같은 경로의 관련 결함을 처리하는 첫 구현 묶음이다.

## 반영한 수정

| 조사 ID | 변경과 검증 |
| --- | --- |
| F01, F09, F10 | 사용자 intake의 evaluate는 assistant 이벤트를 만들지 않는다. 이전 클라이언트의 역할 충돌도 기존 행을 덮어쓰지 않는다. 최초 이벤트 시각을 보존하고, 최신 assistant 발화와 과거 발화를 비교한다. 실제 adapter hook과 서비스 DB를 연결해 사용자 역할·대화 순서·새 주제 전환을 검증했다. |
| F02, F32, F33 | 서비스 DB가 전송 예약, 고정 chunk 계획, 전송 중 상태, chunk별 메시지 ID를 소유한다. 동시 호출은 한 예약만 받고, 재시도는 저장된 영수증을 재사용한다. legacy commit 충돌도 409를 반환한다. 복수 서비스 인스턴스·동시 hook·부분 전송 복구·commit 실패 후 재시도·늦은 영수증·설정 변경을 검증했다. 아래 복구 한계가 있다. |
| F03, F11, F12, H09 | 이전 작업이 끝난 뒤 새 AbortSignal과 lease로 워커가 복구된다. 빈 채널의 초기 조회도 cursor에 남긴다. 종료는 진행 중 archive와 poll을 기다린 뒤 lease와 DB를 정리한다. 지연 provider·poll 및 작업 예외를 주입했다. |
| F04, F16 | 이미지 GET과 body 읽기에 전체 요청의 timeout을 전달한다. 기존 단일·복수 첨부를 보존한다. 헤더 이전 정지, body 정지, 기존 파일 첨부를 검증했다. |
| F05, H05 | 생성 패키지가 shared의 컴파일된 JS 그래프와 선언 파일을 함께 배포하고, 선언한 flat CLI·library 진입점을 제공한다. quick-start도 실행 가능한 dispatcher를 사용한다. 빌드 smoke와 실제 npm tarball의 plain Node 실행을 검증했다. |
| F06, F24, F25, F27 | 누락된 override와 명시 값을 구분해 재import 시 API 설정을 보존한다. activeSet 없는 명시 override도 적용한다. profile과 asset_set 존재 여부를 따로 확인하며, 참조 사전 검증과 전체 DB transaction을 적용한다. 후반 오류 시 rollback과 dry-run 참조 오류를 검증했다. |
| F07 | Hermes가 MEDIA 지시문과 바로 붙은 구분 공백만 정리한다. 정상 응답의 코드 들여쓰기·탭·문자열 공백·줄바꿈은 보존한다. 기존 호환 fixture와 추가 원문 보존 검사를 통과했다. |
| F08 | migration과 sets CLI가 공통 writer lock을 사용한다. migration은 lock 안에서 최신 manifest를 다시 읽어 병합하고, CLI는 오래된 snapshot 저장을 거부한다. 임시 저장소에서 두 migration 결과와 기존 set·activeSet 보존을 검증했다. |

H10의 일부도 반영했다. watcher의 최근 대화 조회는 SQL LIMIT을 사용하고, ID 없는 사용자 intake에는 UUID를 사용한다. 다른 전체 이력 조회·queue 인덱스·cache 청소 작업은 남아 있다.

## 전송 계약과 복구 한계

`POST /v1/watcher/evaluate`의 `trigger: "user"`는 이미 기록한 사용자 intake를 평가한다. 생략하면 기존 assistant evaluate 의미를 유지한다. 응답의 `deliveryPlan.dispatch`는 `claimId`, `expiresAtMs`, `deliveryMessageIds`를 제공한다.

어댑터는 서비스가 반환한 순서와 지연을 따라 host outbound adapter를 호출한다. 각 chunk 전송 직전에 `POST /v1/watcher/delivery-progress`로 `begin`, 성공 후 `receipt`와 host `messageId`를 보낸다. 전송 사이에 중단하면 `release`한다. 서비스가 예약 소유권과 다음 chunk를 검증하며, 어댑터에는 별도 분류·프로필·에셋 선택 정책이 없다.

전송 사이에 만료된 예약은 같은 signal의 다음 evaluate에서 저장된 계획과 영수증으로 복구된다. 기본 여유는 60초이며 남은 chunk 지연도 반영한다. 모든 영수증이 있으면 commit만 재시도한다. 예약 억제는 `audit.suppressedReason: "delivery_pending"`으로 나타난다.

**host 전송을 시작했지만 결과 영수증을 잃은 경우에는 자동 재전송하지 않는다.** 전송 여부가 불명확한 chunk가 남으면 만료 후에도 같은 scope의 watcher 계획을 억제한다. 늦게 도착한 동일 claim의 영수증은 받아서 해소할 수 있다. 영수증 자체를 복구할 수 없는 경우에는 host 기록과 대조하는 운영자 reconciliation이 필요하며, 이번 변경에는 수동 reset API가 없다. 외부 채널의 exactly-once 전송이나 모든 장애의 자동 복구를 보장하지 않는다. 일반 최종 답변 hook은 이 watcher 예약과 별개다.

점검 시 `conversation_delivery_dispatch`를 `conversation_delivery_ledger`와 plan_id로 조인해 planned 행의 `in_flight_chunk_id`, `expires_at_ms`, `receipts_json`을 읽는다. 전송 여부를 확인하지 않고 예약 행을 삭제하면 중복 전송을 만들 수 있다. 업그레이드 전의 planned ledger에는 복구할 영수증이 없으므로 같은 plan을 재생하지 않는다.

서비스와 OpenClaw 어댑터를 함께 배포해야 새 예약 계약이 완전히 적용된다. 새 어댑터는 dispatch 필드가 없는 이전 서비스 응답도 처리하지만, 그 조합에는 새 중복 방지 보장이 없다. 구 어댑터 역시 begin/receipt를 보내지 않으므로 새 서비스와 혼용하지 않는다.

## 데이터 변경과 롤백

DB schema v6는 `conversation_delivery_dispatch` 테이블과 인덱스를 추가한다. 기존 대화·에셋·프로필을 삭제하거나 재작성하지 않는다. v5 구조의 임시 DB를 재개해 대화 보존과 FK 정합성을 확인하는 회귀 검사가 있다. 운영 적용 전 SQLite 일관 백업을 만들고, 서비스와 어댑터를 함께 교체한 뒤 schema·pending dispatch·채널 mapping을 readback해야 한다.

코드 롤백 시 추가 테이블을 유지할 수 있지만 이전 코드에는 예약 보호가 없으므로 pending 전송을 먼저 확인하고 watcher를 비활성화한 상태에서 되돌려야 한다. 새로 수집된 데이터를 버리는 DB 백업 복원은 자동 수행하지 않는다. 이번 작업에서는 운영 DB, 실제 manifest 또는 asset set을 변경하지 않았다.

manifest lock은 공통 helper를 사용하는 writer 사이에만 적용된다. 외부 편집기는 같은 계약을 따라야 한다. 동시 `activate`는 직렬화된 마지막 요청이 활성 set을 결정하며, 중단된 writer의 lock은 자동 삭제하지 않는다. 자세한 재시도 조건은 [생성 패키지 README](../generate/README.md)에 있다.

## 검증과 남은 작업

Node `v22.18.0`에서 관련 패키지 전체 테스트와 Service/OpenClaw/Generate TypeScript 검사를 실행했다. 테스트 프로세스에서는 운영 `HENT_AI_*`, `DISCORD_*` 환경변수를 제외했다. 이미지 생성은 mock이며, adapter·서비스 통합 전송은 mock host 또는 격리된 loopback을 사용한다.

| 검사 | 결과 |
| --- | --- |
| Service Vitest | 298 통과, 운영 live 검사 2개 기존 조건에 따라 skip |
| OpenClaw Vitest | 472 통과; 실제 서비스 loopback 및 adapter 동시 전송·부분 영수증 복구 포함 |
| Generate Vitest | 66 통과; 소스 외부 package smoke와 임시 manifest 동시 변경 포함 |
| Hermes unittest | 359 통과; 공통 emotion fixture와 원문 보존 포함 |
| Service/OpenClaw/Generate TypeScript | 모두 종료 코드 0 |
| Service-owned boundary | 통과 |
| npm tarball | 81개 배포 항목 확인, 소스 외부 추출 후 plain Node `--help`, `--version`, 패키지 이름 import 통과 |
| LSP / diff | 확인한 주요 변경 파일의 오류·경고 0, `git diff --check` 통과, 실제 assets/manifest diff 없음 |

총 1,195개 테스트가 통과했다. tarball 검사는 이미 설치된 production 의존성만 개별 연결했으며, 새 머신에서 네트워크 설치나 native 모듈 재빌드까지 확인한 것은 아니다. 로그는 `/tmp/hentai-functional-fix-tests/`에 있고 임시 파일의 장기 보존은 보장하지 않는다. 전체 release gate와 실제 gateway 교체 E2E는 실행하지 않았으므로 release 준비 완료를 뜻하지 않는다.

후속 기능 작업은 F13–F15, F17–F23, F26, F28–F31, F34–F40이다. 코드 위생 작업은 H01–H04, H06–H08, H10의 나머지, H11이 남아 있다. H07의 아키텍처 계약은 owner 결정이 필요한 사항으로 유지한다. 수정은 아래 브랜치에 커밋·push하고 PR로 제출했다. 병합·배포·운영 재시작은 수행하지 않았다.

## PR 분리 결과

모든 PR은 동일한 `dev` 기준 커밋 `da2120e`에서 독립적으로 분리했다. 아래 테스트 수는 각 PR만 적용한 작업 트리에서 다시 실행한 결과이며, 앞의 1,195개는 전체 변경을 합친 작업 트리의 결과다. 모든 관련 TypeScript 검사, service-owned boundary, branch-flow 검사도 통과했다. Service의 운영 live 검사 2개는 기존 조건에 따라 skip했다.

| PR | 범위 | 분리 후 테스트 통과 |
| --- | --- | --- |
| [#139](https://github.com/IYENTeam/Hent-ai/pull/139) | 대화 기록·watcher 전송 예약 (Draft) | Service 292 + OpenClaw 469 |
| [#140](https://github.com/IYENTeam/Hent-ai/pull/140) | 이미지 timeout·첨부 보존 | OpenClaw 469 |
| [#141](https://github.com/IYENTeam/Hent-ai/pull/141) | 워커 복구·종료 drain | Service 287 |
| [#142](https://github.com/IYENTeam/Hent-ai/pull/142) | import 설정 보존·transaction | Service 285 |
| [#143](https://github.com/IYENTeam/Hent-ai/pull/143) | 생성 패키지 실행 경로 | Generate 65 |
| [#144](https://github.com/IYENTeam/Hent-ai/pull/144) | manifest 동시 변경 보존 | Generate 65 |
| [#145](https://github.com/IYENTeam/Hent-ai/pull/145) | Hermes 원문 공백 보존 | Hermes 359 |

watcher PR은 기존 [#137](https://github.com/IYENTeam/Hent-ai/pull/137)의 내부 안내 전환과 겹쳐 Draft로 제출했다. #137을 채택하면 대화 기록 보존 수정을 살리고 불필요해지는 outbound 예약 경로를 제거하거나 재설계해야 한다. 두 설계를 그대로 함께 병합하지 않는다. 이미지 PR도 같은 entrypoint를 수정하므로 #137 병합 후 rebase가 필요할 수 있다.

OpenClaw entrypoint를 변경하는 PR의 Changeset Validation에는 owner review가 필요하다. PR 제출만으로 해당 승인을 대신하지 않으며 owner-reviewed 라벨이나 승인 상태를 임의로 설정하지 않았다. 전체 release gate의 미실행 상태도 유지한다.
