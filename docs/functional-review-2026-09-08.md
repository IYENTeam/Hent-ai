# 기능·빌드·코드 위생 조사 — 2026-09-08

기준 커밋: `b091cc4` (`main`). 이전 세션 `01a07e6e-9eba-73e2-b8ec-030e9bcaa5f2`의 최신 원격 동기화 이후 조사 결과를 이어서 정리했다. 요청에 따라 사이버 보안 취약점 조사와 관련 재현은 범위에서 제외했다. 이 문서는 수정 완료 목록이 아니라 수정할 작업 목록이다.

이후 구현 내역과 최신 검증 결과는 [기능 수정 진행 기록](functional-fix-progress-2026-09-08.md)에 있다. 아래 재현·검증 기록은 수정 전 기준 커밋의 조사 당시 상태다.

이전 서브에이전트 보고서의 중복을 합쳤다. P1은 먼저 고칠 사용자 영향이 큰 문제, P2는 후속 기능·운영 결함, P3는 코드 위생·성능 개선이다. 우선순위는 이 조사에서 제안한 값이며 실제 운영 사고 발생을 뜻하지 않는다.

근거 구분: **재확인**은 이번 재개에서 실행한 격리 재현, **기존 재현**은 동일 커밋의 이전 조사 보고서에 남은 실행 결과, **정적 확인**은 소스·설정 간 불일치다. 실제 채널 전송이나 유료 생성으로 검증하지 않았다. 소스 위치는 기준 커밋의 줄 번호다.

**먼저 수정할 8개 작업 (P1)**

1. **F01 — 사용자 메시지가 assistant 기록으로 덮어써진다.** `openclaw/index.ts:974`의 사용자 기록 직후 `:983`에서 같은 ID로 evaluate를 호출한다. `service/src/conversation-runtime.ts:135`는 이를 assistant 이벤트로 저장하고, `conversation-store.ts:64`의 upsert가 기존 역할을 바꾼다. 같은 문장을 두 번 입력한 사람에게 AI 반복 발화용 nudge까지 생성된다. 사용자 intake 평가와 assistant 기록을 분리하고 이벤트 역할을 보존해야 한다. 회귀 검증: 실제 adapter intake와 임시 DB를 연결해 두 사용자 행이 모두 `user`로 남고 반복 nudge가 나오지 않는지 확인. **재확인:** 두 행 모두 `assistant`, 두 번째 입력은 `nudge`.

2. **F02 — 전송 완료 전 같은 nudge를 여러 호출에 허용한다.** `service/src/conversation-runtime.ts:162`는 완료된 기록만 중복 판단에 쓰며, `:181`에서 만드는 계획은 전송 권한을 예약하지 않는다. 같은 요청 세 개가 같은 plan ID의 `nudge`를 받았다. 실제 전송 후 commit하는 어댑터에서는 중복 메시지로 이어질 수 있다. 서비스가 만료·복구 가능한 전송 예약을 소유하고 재시도에서 기존 chunk 영수증을 재사용하도록 해야 한다. 회귀 검증: 지연된 mock 전송, 동시 evaluate, 부분 전송 실패, commit 응답 유실. **재확인:** 세 호출에 동일한 전송 가능 계획 반환. 실제 중복 채팅은 보내지 않았다.

3. **F03 — lease 갱신 실패 후 워커가 살아 있는 채 영구 정지한다.** `service/src/discord-ambient-worker-core.ts:57`에서 abort한 뒤 모든 `runOnce()`가 `aborted`를 반환한다. `discord-ambient-worker.ts:170`은 그 결과를 무시해 상태가 계속 `running`이다. 절전이나 긴 이벤트 루프 지연으로 갱신을 놓치면 프로세스 감시자의 재시작도 기대할 수 없다. 상위 실행기가 종료 상태를 처리해 코어를 재구성하거나 정상 종료 후 재시작되게 해야 한다. 회귀 검증: lease 만료 후 멈춘 코어를 방치하지 않고 복구하며 이전 작업이 전송되지 않는지 확인. **재확인:** 이후 호출이 계속 `aborted`.

4. **F04 — 이미지 다운로드가 최종 답변을 무기한 기다리게 할 수 있다.** `openclaw/index.ts:354`의 `hydrateLocalServiceMedia`는 GET 및 `arrayBuffer()`에 요청의 AbortSignal을 전달하지 않는다. verdict POST의 timeout이 지나도 후속 이미지 처리가 끝나지 않을 수 있다. 전체 처리 기한을 이미지 다운로드와 body 읽기까지 전달하고 만료 시 원문 답변을 반환해야 한다. 회귀 검증: POST 성공 후 GET 정지, headers 수신 후 body 정지 각각에서 기한 내 hook 종료. **기존 재현 + 현재 소스 대조:** timeout 10ms, 40ms 후 hook pending; GET signal 없음.

5. **F05 — 생성 패키지가 빌드 성공해도 CLI·라이브러리를 실행할 수 없다.** `generate/package.json:7`과 `:10`은 `dist/main.js`, `dist/index.js`를 선언하지만 `generate/tsconfig.json:16`의 sibling shared 참조 때문에 출력은 `dist/generate/src/…`가 된다. 실제 출력 경로를 실행해도 `shared/package.json:7`의 raw TS export와 `shared/db.ts:14`의 없는 `profile.js` 참조로 실패한다. 단순 경로 수정만으로 해결되지 않는다. shared JS 배포 또는 bundling을 포함해 출력 그래프를 정하고 package export와 일치시켜야 한다. 회귀 검증: 소스 트리 밖에 설치한 tarball에서 Node 22의 plain `node`, CLI `--help`·`--version`, 라이브러리 import. **기존 재현 + 현재 설정 대조:** 컴파일 성공, 선언 경로 `MODULE_NOT_FOUND`, 실제 출력 경로에서도 shared 모듈 로딩 실패.

6. **F06 — 재import가 API에서 끈 채널과 변경한 프로필을 되돌린다.** `service/src/importer.ts:233`이 누락된 override에 `activeSet`과 `true`를 미리 채운다. `:331`에서 기존 값을 보존하려 해도 명시된 설정과 기본값을 구분하지 못한다. 빈 override import 후 API에서 비활성화·프로필 변경, 재import하면 다시 활성화되고 프로필도 초기값으로 바뀐다. 계획 단계에서 명시 여부를 보존하고 새 mapping에만 기본값을 적용해야 한다. 회귀 검증: 빈 override는 기존 설정 유지, 명시 override는 의도대로 적용. **기존 재현.**

7. **F07 — Hermes의 MEDIA 정리가 정상 코드와 공백을 손상시킨다.** `hermes/emotion_rules.py:81`은 연속 공백·탭을 전역 축약한다. `hermes/__init__.py:159`에서 이 처리를 거쳐 이미지가 붙은 답변에 적용되므로 Python 중첩 들여쓰기와 문자열의 두 칸 공백까지 바뀐다. 제거할 MEDIA 지시문의 범위만 수정하고 나머지 바이트는 보존해야 한다. 회귀 검증: Python/YAML 코드, 탭, 문자열 공백, Markdown 줄바꿈을 로컬·서비스 이미지 양쪽 경로에서 보존. **기존 재현:** 중첩 Python과 문자열 내용 변경.

8. **F08 — 외부 에셋 저장소 migration이 동시 manifest 변경을 유실한다.** `generate/src/local-affect-store.ts:149`에서 읽은 manifest를 이미지 복사 후 `:173`에서 그대로 병합·교체한다. atomic rename은 다른 작업자가 그 사이 추가한 set을 보존하지 못한다. 공통 writer lock 안에서 최신 상태를 다시 읽어 병합하거나 변경 감지 후 재시도해야 한다. 회귀 검증: 임시 에셋 저장소의 두 writer가 서로 다른 set을 추가해도 둘 다 보존되고 활성 set 변경 충돌이 명시적으로 처리되는지 확인. **기존 임시 파일 재현:** 중간에 추가한 set이 성공 응답 이후 사라짐. 실제 manifest·asset set은 수정하지 않았다.

**후속 기능 작업 (P2)**

| ID | 문제와 발생 조건 | 위치 | 수정 및 회귀 검증 방향 | 근거 |
| --- | --- | --- | --- | --- |
| F09 | 과거의 반복 두 건 때문에 새 주제로 전환한 최신 답변도 반복으로 판단 | `service/src/watcher-core.ts:295` | 최신 발화가 포함된 반복 근거를 요구. 반복 후 주제 전환은 nudge 없음 | 재확인 |
| F10 | 과거 evaluate 재시도가 이벤트 시간을 갱신해 대화 순서를 변경 | `service/src/conversation-runtime.ts:228`, `conversation-store.ts:70` | 최초 이벤트 시각과 재관측 시각 분리. a1→a2→a1 재시도 후 순서 유지 | 재확인: a2→a1 |
| F11 | 시작 시 빈 채널은 다음에 도착한 첫 메시지 묶음까지 초기 이력으로 버림 | `service/src/discord-ambient-worker-core.ts:103` | 빈 초기 조회 완료도 영속화. 빈 조회→첫 사용자 메시지에서 raw/work 생성 | 재확인: ingestion=0 |
| F12 | shutdown이 진행 중 archive를 기다리지 않고 SQLite 종료 | `service/src/discord-ambient-worker.ts:174`, `conversation-archive-scheduler.ts:30` | async drain 후 DB close. 지연 mock provider 중 종료하면 close 이후 DB 읽기 없음 | 재확인: closed DB sentinel 오류 |
| F13 | 전송이 Retry-After를 버리고 영구 오류도 계속 재시도 | `service/src/discord-ambient-delivery.ts:56`, `adaptive-ambient-store.ts:227` | 다음 시도 시각·오류 분류 저장. 60초 제한이면 59초에는 보내지 않고, 영구 오류는 진단 가능한 중단 상태 | 기존 mock 재현 |
| F14 | 140 UTF-16 단위에서 메시지를 자르며 이모지가 반으로 갈림 | `service/src/discord-ambient-delivery.ts:77` | code point 또는 grapheme 경계에서 분할. surrogate pair·ZWJ 이모지 검증 | 기존 재현 |
| F15 | 별도 thread/topic ID가 outbound 전송에 전달되지 않음 | `openclaw/index.ts:569`, `:166` | host의 string/number threadId를 운반하고 scope에 정규화. Telegram 등 별도 topic 필드가 있는 경로 검증 | 기존 mock 재현; 호스트 경로 의존 |
| F16 | 기존 첨부가 단일 mediaUrl만 있으면 감정 이미지가 덮어쓸 수 있음 | `openclaw/index.ts:544` | 단일·복수 첨부를 모두 보존하며 추가. mediaUrls 없는 host payload 검증 | 정적 확인; payload 형태 의존 |
| F17 | 일시적인 이미지 routing 실패를 null verdict로 24시간 캐시 | `service/src/final-response-use-case.ts:70`, `:104` | 분류 결과와 이미지 선택 실패를 분리. 매핑 복구 후 verifier 재호출 없이 이미지 재선택 | 기존 mock 재현 |
| F18 | verifier 모델·설정 변경 후에도 이전 판단 캐시를 사용 | `service/src/final-response-use-case.ts:162` | 유효한 분류 정책 식별자를 캐시 키에 포함. 같은 정책 hit, 변경 정책 miss | 기존 mock 재현 |
| F19 | 유효 affect와 함께 온 잘못된 emotion이 응답·캐시에 남음 | `service/src/final-response-use-case.ts:90`, `:179` | 검증된 필드로 결과 재구성. affect-only 허용, 모르는 emotion은 제거 | 기존 mock 재현 |
| F20 | coarse emotion 후보가 0개일 때 undefined.candidate 접근 | `service/src/semantic-assets/router.ts:76` | 빈 목록을 별도 처리해 no-media 또는 정의된 fallback 반환 | 기존 실제 router/mock 저장소 재현 |
| F21 | 한 guild의 같은 사용자가 두 번째 채널에서 관계 프로필을 갱신하지 못함 | `service/src/db-schema-adaptive.ts:5`, `adaptive-ambient-store.ts:269` | 채널을 포함한 복합 키 migration과 upsert 정합성. 같은 사용자·두 채널 및 legacy 빈 채널 행 검증 | 기존 in-memory DB 재현 |
| F22 | 채널 mapping 갱신이 두 테이블 중 하나만 반영한 채 실패 | `service/src/db.ts:86` | 입력 검증 및 transaction. 두 번째 쓰기 실패 시 전체 원상 유지 | 기존 in-memory DB 재현 |
| F23 | 삭제되거나 manifest에서 제거된 import 이미지가 계속 선택됨 | `service/src/importer.ts:303` | source 소유권을 구분한 retirement/reconciliation. generated 행 보존, 없는 이미지 선택 제외 | 기존 임시 fixture 재현 |
| F24 | API로 먼저 만든 profile의 디렉터리 이미지 import 실패 | `service/src/importer.ts:285`, `:313` | profile과 asset_set의 존재 여부를 독립 확인. 기존 프로필 정보 유지하며 FK 충족 | 기존 재현: FK 오류와 남은 storage 행 |
| F25 | import 후반 실패가 앞선 DB 변경을 남기며 dry-run도 문제를 놓침 | `service/src/importer.ts:279` | 적용 전 참조 검증 및 전체 DB transaction. 오류 시 import_runs 포함 상태 불변 | 기존 재현 |
| F26 | 동일 ID의 legacy 디렉터리 이미지가 manifest 이미지·태그를 덮어씀 | `service/src/importer.ts:210`, `:314` | 계획 단계 ID 충돌 보고 또는 명확한 source 우선순위. 태그·이미지·집계 일관성 검증 | 기존 임시 fixture 재현 |
| F27 | manifest에 activeSet이 없으면 명시적 채널 override도 무시 | `service/src/importer.ts:227` | override는 항상 처리하고 누락 기본값에만 activeSet 사용 | 기존 재현 |
| F28 | confidence floor 0.6 설정이 실제 provider에서 기본 0.7에 막힘 | `service/src/adaptive-ambient-provider.ts:95` | 구조 검증과 채널 정책 분리. 실제 parser+mock completion에서 0.65 결과를 설정대로 처리 | 기존 mock 재현: 불필요한 두 번 호출 |
| F29 | 20개 초과 backlog의 오래된 대상 이벤트를 빈 가짜 이벤트로 대체 | `service/src/adaptive-ambient-runtime.ts:172` | 대상 raw event를 직접 조회·전달. 21개 backlog의 첫 이벤트 mention/reply 보존 | 기존 실제 runtime/in-memory DB 재현 |
| F30 | speakStreak가 쉬어도 초기화되지 않아 누적 발화 수로 동작 | `service/src/conversation-ambient.ts:209` | 발화 기회를 건너뛸 때 연속 횟수 reset. 발화→skip→발화에서 1→0→1 | 기존 결정 함수 재현 |
| F31 | provider prompt가 silenceRequest 필드를 설명하지 않아 압력 계산 입력 누락 | `service/src/adaptive-ambient-provider.ts:73` | prompt·예시에 현재 schema 반영. 실제 adapter의 mock 응답으로 pressure 변화 검증 | prompt 정적 확인 및 mock 캡처; 실제 모델 빈도 미측정 |
| F32 | legacy delivery API가 충돌 commit도 성공으로 응답 | `service/src/conversation-runtime.ts:205`, `watcher-routes.ts:101` | commit 결과를 전파. 동일 영수증 재시도 성공, 다른 ID는 409 | 기존 route/in-memory DB 재현 |
| F33 | 재시작·설정 변경 뒤 동일 plan의 새 chunk와 저장된 필수 chunk 불일치 | `service/src/conversation-runtime-delivery.ts:39`, `:112` | 계획 전체를 불변 저장·재사용. chunk 크기 변경 후에도 기존 계획 commit 가능 | 기존 재현; pending 계획 중 변경 시 |
| F34 | Hermes 미디어 쓰기 실패 후 부분 파일을 계속 캐시 hit로 사용 | `hermes/service_adapter.py:175`, `:198` | 임시 파일 완성 후 atomic replace, 불완전 캐시 재시도 | 기존 쓰기 실패 주입 재현 |
| F35 | Hermes transcript LRU와 달리 budget/cooldown/dedup 상태는 계속 증가 | `hermes/watcher_adapter.py:73`, `:135` | 모든 관련 상태의 만료·보존 기간을 정의. LRU 이후 전체 map 크기 확인 | 기존 mock 재현: buffer 500, 다른 map 601 |
| F36 | TS·Python emotion 규칙 불일치 및 일반 단어 부분 일치 오분류 | `shared/emotions.ts:40`, `hermes/emotion_rules.py:46` | 공통 fixture 확장. reviewing/reading, incomplete, 네트워크 등의 음성 사례 검증 | 기존 TS/Python 재현; Hermes 로컬 호환 경로 한정 |
| F37 | 검증기·retagger가 통과시킨 태그를 runtime parser가 거부 | `scripts/verify-affect-assets.mjs:34`, `shared/affect.ts:103` | 공통 schema/parser 또는 parity fixture. evidence 길이·종류와 provenance 필드 일치 | 기존 verifier/parser 재현 |
| F38 | tagging 중 원본 교체 시 예전 이미지의 태그에 새 이미지 hash를 기록 | `scripts/codex-visual-affect-retag.mjs:130`, `:165` | 실제 전달한 snapshot hash 사용, publish 전 원본 일치 확인 | 기존 fake Codex 실행 재현; 실제 모델 호출 없음 |
| F39 | offline tagging helper가 완료 영수증 확인 전에 재호출하고 timestamp 충돌로 실패 | `generate/src/affect-tags.ts:83`, `semantic-tags.ts:148` | 기존 영수증 검증·재사용을 호출보다 먼저 수행. 같은 입력 두 번에 mock 호출 한 번 | 기존 mock 재현; 공개 helper 소비자 경로 |
| F40 | semantic batch accept/reject 동시 실행이 rejected 영수증과 final 파일을 함께 남김 | `generate/src/semantic-batch.ts:422` | 항목별 결정 전이를 직렬화. fault hook으로 accept/reject 순서를 교차 검증 | 기존 임시 fixture 재현 |

**빌드·테스트·문서 및 코드 위생 작업**

| ID | 우선순위 | 작업 | 근거와 완료 기준 |
| --- | --- | --- | --- |
| H01 | P2 | OpenClaw clean install 계약 정리 | `openclaw/package.json:21`의 unpublished peer 및 sibling SDK 경로를 CI가 제거하고 설치한다. 실제 host import와 맞는 의존성 계약을 정하고 sibling checkout 없는 설치 검증 추가 |
| H02 | P2 | 패키지 매니저·lockfile·설치 문서 정합성 | runbook의 openclaw `npm ci`에 필요한 package-lock이 없고 pnpm lock은 현재 manifest와 다르다. CI의 비고정 설치를 없앨 수 있는 재현 가능한 bootstrap 확립 |
| H03 | P2 | 루트 scripts 계약 테스트를 CI·portable release에 포함 | 패키지 테스트와 별도로 실행되지 않는다. 이전 전체 실행은 37개 중 1개 실패. `scripts/branch-flow-policy.test.mjs:59`의 기대값과 workflow 변경을 의도에 맞게 정리한 후 누락된 lane 연결 |
| H04 | P2 | 일반 CI asset integrity 검사를 실제 manifest 계약과 통일 | `.github/workflows/ci.yml:227`은 파일 수를 세고 0개도 경고로 처리. 임시 fixture의 없는 이미지 참조·잘못된 activeSet 등을 차단하는 공통 정적 검사 사용 |
| H05 | P2 | 생성 quick-start를 실제 CLI 진입점으로 변경 | `README.md:90`은 실행 dispatcher가 아닌 cli 모듈을 호출. F05 완료 후 무료 `--help`로 실행 경로 검증 |
| H06 | P2 | 서비스 소유 프로필 설정 문서로 갱신 | `README.md:234`는 legacy ProfileDatabase에 만든 프로필을 서비스에 바로 매핑하는 흐름이며 일반 OpenClaw prompt의 persona 동작도 현재 구현과 다름. 임시 service DB·fixture import로 문서 흐름 검증 |
| H07 | P2 | 아키텍처 문서의 V1/V2 설명 충돌 정리 | AGENTS의 verifier-first 설명과 최신 roadmap/runbook의 ResponseAffectV2 흐름이 다르다. owner의 계약 확인 후 V1/V2 범위를 명시. 조사에서 런타임 의미나 AGENTS 규칙을 임의 변경하지 않음 |
| H08 | P2 | runbook의 release 명령 목록을 실행 스크립트와 통일 | `docs/agent-runbook.md:48`의 expanded equivalent가 전체 gate와 다름. 중복 목록을 없애거나 `release-gate.mjs --list-json`에서 도출 |
| H09 | P3 | 종료 오류에도 lease·DB 정리 보장 | `discord-ambient-worker-core.ts:138`은 active rejection 시 release에 도달하지 않음. 이번 mock 재현 release 호출 0회. finally/allSettled로 전체 drain·정리 보장 |
| H10 | P3 | 누적 기록의 조회 비용 제한 | `conversation-runtime.ts:258` 등 전체 이력을 읽고 JS에서 자르는 경로를 SQL LIMIT으로 변경. queue의 scope/status/order 인덱스와 실제 query plan 검증. verifier cache 만료 행 정리 |
| H11 | P3 | 중복 schema·약한 테스트 타입·legacy 모듈 정리 | shared affect 계약과 script 복제본 parity 검증, 실제 parser를 우회하는 hand-written mock 타입 축소. 미연결 OpenClaw legacy 모듈은 runtime 결함과 구분하여 migration 경계에 정리 |

**검증 기록과 한계**

동일 `b091cc4`에서 이전 세션이 실행한 로그(`/tmp/hentai-main-audit-tests/`)를 확인했다. 이번에는 변경되지 않은 패키지 전체 검사를 반복하지 않았다.

| 검사 | 이전 실행 결과 |
| --- | --- |
| Service Vitest | 282 통과 |
| OpenClaw Vitest | 466 통과 |
| Generate Vitest | 64 통과 |
| Shared Vitest | 51 통과 |
| Hermes unittest | 357 통과 |
| Service/OpenClaw/Generate TypeScript | 모두 종료 코드 0 |
| 루트 script 테스트 | 36 통과, 1 실패 (H03) |

이번 재개에서는 Node `v22.18.0`과 설치된 tsx를 사용해 F01/F02/F09/F10을 in-memory SQLite로 재확인했고, F03/F11/F12/H09를 mock store/provider로 재확인했다. 두 재현 스크립트 모두 종료 코드 0이며, 이는 위 결함의 존재를 확인하는 assertion이 통과했다는 뜻이다. 정상 기능 검사 통과를 뜻하지 않는다. F04/F05는 현재 소스·패키지 설정과도 대조했다. LSP workspace를 활성화해 워커 심볼을 확인했다.

재개 재현 파일은 `/tmp/hentai-functional-watcher-resume.mts`, `/tmp/hentai-audit07-repro.mts`이다. 원래 분야별 보고서는 `/tmp/hentai-main-audit-NN.md`에 있으며 임시 파일은 장기 보존을 보장하지 않는다. 이 문서에 문제 조건·소스 위치·수정 방향·검증 수준을 독립적으로 남겼다.

운영 gateway 교체 E2E, 외부 채널 전송, 실제 이미지 생성, 운영 DB·manifest 수정은 실행하지 않았다. 전체 release gate 통과를 주장하지 않는다. 저장소 변경은 이 조사 문서뿐이다.

**추천 수정 순서**

1. 대화 기록·중복 전송: F01/F02/F09/F10을 서비스와 thin adapter의 통합 회귀 검사로 묶는다.
2. 응답·워커 안정성: F03/F04/F11/F12/H09, 이어서 F13/F14.
3. 배포 가능한 패키지: F05/H01/H02/H05와 plain-node 설치 smoke 검사.
4. 데이터 보존: F06/F08/F21–F27. 모든 manifest/asset 작업은 임시 fixture와 적용 전후 diff 검증을 포함한다.
5. Hermes 원문 보존 F07을 우선 적용하고 나머지 cache·metadata·ambient 동작 및 H03–H08을 별도 작은 변경으로 진행한다.

각 수정은 관련 패키지 테스트를 통과해야 한다. 이 조사에서는 코드 수정·커밋·push·PR 생성을 수행하지 않았다.
