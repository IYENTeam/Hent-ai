# 개발 명세: Hent-ai 대화 모듈 완성 (그룹챗 참여자 파이프라인)

작성일: 2026-07-02
상태: 제안 (owner 승인 대기)
베이스: `origin/codex/discord-chat-participant` (95093f9, 2cb7f6f) — main(f7c9521) 대비 참여자 모델 재설계 완료 브랜치

## 0. 배경과 목표

### 0.1 의도한 동작 (제품 요구)

hent-ai 서비스는 단체 대화방에서 사람처럼 대화하는 에이전트다.

1. 최근 대화들에 대한 생각(원시 이벤트)이 raw하게 쌓인다.
2. 연결된 LLM 프로바이더가 이를 정리한 맥락을 만들고 Hent-ai 서비스가 저장한다.
   (Hent-ai는 LLM 처리를 직접 하지 않고 프로바이더/프록시에 연결만 한다.)
3. 서비스는 정리 맥락을 주기적으로 갱신한다.
4. 갱신 시 연결된 에이전트의 soul(페르소나)을 참고해 적절한 메시지를 형성한다.
5. 메시지는 카톡처럼 한 줄씩 쪼개지고, 각 줄 길이에 비례한 딜레이를 두고 전송된다.

### 0.2 현재 상태 요약 (2026-07-02 리서치 결과)

| 의도 단계 | main 상태 | chat-participant 브랜치 상태 |
|---|---|---|
| 1. raw 축적 | 부분 구현 (naive 체크포인트, 읽는 곳 없음) | 동일 |
| 2. LLM 정리 맥락 저장 | 미연결 (결과 버림, compaction 미호출) | 동일 |
| 3. 주기 갱신 | 없음 (fixation 평가 타이머만) | 주기 reply-check 타이머 있음, 맥락 갱신은 없음 |
| 4. soul 기반 메시지 | 미연결 (하드코딩 nudge) | `DecisionProvider` 훅 존재, **구현체 없음** |
| 5. 분할+길이 비례 딜레이 | 인덱스 램프 딜레이 | **딜레이 소실 (`wait(0)`)** |

핵심 결손 3가지:
- `ConversationDecisionProvider` LLM 구현체가 레포에 없다 (인터페이스만 존재).
- 프로덕션 엔트리포인트가 없다 (`createHentAiServerWithPoller`를 호출하는 코드 없음).
- 작업기억(단기 맥락 갱신 + 장기 압축) 파이프라인이 스케줄러에 연결되지 않았다.

### 0.3 비목표 (Non-goals)

- OpenClaw 호스팅 모드의 대화 참여 (watcher HTTP 라우트는 브랜치에서 제거됨 — 결정 D1 참조).
  OpenClaw 어댑터는 감정 이미지 verdict 경로만 유지한다.
- Hermes 어댑터의 대화 참여.
- 멀티 게이트웨이(WebSocket) 전환 — REST 폴링 유지.
- 벡터 검색 기반 장기 기억 — 요약 테이블 수준까지만.

### 0.4 아키텍처 결정

- **D1. 대화 참여의 canonical 경로는 standalone Discord REST 폴러다.**
  `codex/discord-chat-participant`가 watcher HTTP 라우트/OpenClaw watcher 훅을 제거했고, 이 방향을 채택한다.
- **D2. LLM 호출은 전부 OpenAI 호환 chat-completions 프록시 계약으로 통일한다.**
  `verifier.ts`의 기존 패턴(endpoint/token/model/timeout/extraHeaders/extraBody)을 일반화해 재사용한다.
  발화 결정·단기 맥락·기억 압축 3가지 용도가 같은 클라이언트를 공유한다 (모델만 용도별 오버라이드 허용).
- **D3. 페르소나 SSOT는 DB(`profiles.soul_snippet`)다.**
  soul.md 파일은 기존 `profile set-soul` CLI로 DB에 주입하는 플로우를 유지한다.
  채널 → `channel_mappings.profile_id` → `profiles.soul_snippet` 순으로 해석한다.
- **D4. 안전 게이트는 기존 `evaluateConversationSpeechPolicy`를 유지한다** (쿨다운·시간당 예산·사람 idle·신뢰도·페르소나 새니타이즈). 완화는 env로만 한다.

---

## Phase 0 — 베이스 통합과 실행 가능화

목표: "돌릴 수 있는 프로세스"를 만든다. 이 페이즈가 끝나면 env만 넣으면 서비스가 뜨고, 왜 말을 안 하는지 로그로 전부 설명된다.

### P0-1. 브랜치 통합

- `origin/codex/discord-chat-participant`를 main에 머지한다.
  - 충돌 원칙: 브랜치가 삭제한 파일(openclaw watcher-*, service watcher-routes, conversation-delivery-plan, conversation-runtime-delivery, conversation-evaluate-context 등)은 삭제를 채택.
  - main에만 있는 #113 이후 수정은 브랜치에 이미 반영되어 있는지 diff로 확인 후 통합.
- `codex/hent-ai-service-hardening`에서 선별 체리픽:
  - `4ee61ee` (discord 평가를 채널당 1건이 아니라 메시지별 큐로) — 충돌 시 동등 로직 재구현.
  - `docs/memory-eval-scaffold.md` — Phase 2의 설계 근거 문서로 채택.
  - 나머지(asset/hermes/gates)는 대화 모듈과 무관하므로 별도 PR로 분리.

### P0-2. 프로덕션 엔트리포인트: `service/src/main.ts` (신규)

```
책임:
  1) env 로드 → ServiceDatabase 오픈 (HENT_AI_DB_PATH)
  2) verifier 생성 (env 없으면 감정 verdict 비활성 — 경고 로그 후 계속)
  3) 대화 provider 생성 (Phase 1) — env 없으면 decisionProvider 미주입 + 경고
  4) createHentAiServerWithPoller(...) → server.listen(HENT_AI_PORT, HENT_AI_HOST)
  5) SIGINT/SIGTERM → stopPoller() → server.close() graceful shutdown
```

- `package.json`: `"start": "node --experimental-strip-types src/main.ts"` (또는 빌드 후 `dist/main.js`; 레포 빌드 방식 따름), `bin.hent-ai-service` 등록.
- 문서: `openclaw/README.md`의 standalone 섹션에 기동 커맨드와 필수 env 추가.

### P0-3. 기동 진단 (silent no-op 제거)

기동 직후 한 번, 아래를 **명시적으로** 로그한다:

| 조건 | 동작 |
|---|---|
| `conversationConfig.diagnostics.length > 0` | `error` 로그로 각 진단 + "conversation disabled" 명시 |
| `HENT_AI_CONVERSATION_ENABLED` false/미설정 | `warn`: "conversation disabled by env" |
| 폴러 config null | `warn`: 어떤 env(token/channels)가 비었는지 각각 명시 |
| `HENT_AI_DISCORD_POLLER_BOT_USER_ID` 미설정 | `warn`: "self-message 인식 불가 — assistant 턴이 기록되지 않음" |
| decisionProvider 미주입 | `warn`: "reply check는 돌지만 항상 no_reply(missing_decision_provider)" |

### P0-4. 수용 기준

- [ ] `npm start` (env 완비 시) → 서버 listen + 폴러 시작 로그.
- [ ] env를 하나씩 빼면서 기동했을 때, 각 경우 위 표의 로그가 정확히 출력된다.
- [ ] 기존 테스트 전부 green (`service`, `openclaw`, `hermes`).

---

## Phase 1 — LLM 프로바이더 연결 (발화 결정 + soul 브리지)

목표: 의도 단계 4의 핵심. 봇이 하드코딩 문자열이 아니라, soul을 주입받은 LLM의 판단으로 말한다.

### P1-1. 공용 프로바이더 클라이언트: `service/src/conversation-provider-client.ts` (신규)

`verifier.ts`의 `createOpenAiChatCompletionsFinalResponseVerifier` 패턴을 일반화:

```ts
export type ConversationProviderClientConfig = {
  endpoint: string;          // HENT_AI_CONVERSATION_PROVIDER_ENDPOINT
  token: string;             // HENT_AI_CONVERSATION_PROVIDER_TOKEN
  model: string;             // HENT_AI_CONVERSATION_PROVIDER_MODEL
  timeoutMs: number;         // HENT_AI_CONVERSATION_PROVIDER_TIMEOUT_MS (기본 20000)
  extraHeaders?: Record<string, string>; // ..._EXTRA_HEADERS (JSON)
  extraBody?: Record<string, unknown>;   // ..._EXTRA_BODY (JSON)
  fetchImpl?: typeof fetch;  // 테스트 주입용
};

export interface ConversationProviderClient {
  // ConversationPrompt = { system, user } → chat-completions messages로 변환
  complete(prompt: ConversationPrompt, opts?: { model?: string }): Promise<string | null>;
}

export function loadConversationProviderConfigFromEnv(env?): ConversationProviderClientConfig | null;
// endpoint/token/model 중 하나라도 없으면 null (P0-3에서 경고 로그)
```

- 응답 파싱: `choices[0].message.content`를 문자열로 반환, 비정상 shape이면 null + 로그.
- 타임아웃: AbortController (verifier와 동일).
- 오류는 throw하지 않고 null 반환 + 진단 수집 (프로바이더 장애가 폴러를 죽이면 안 됨).

### P1-2. 발화 결정 프로바이더: `service/src/conversation-decision-provider.ts` (신규)

`ConversationDecisionProvider` 인터페이스(`conversation-config.ts:47`)의 첫 구현체.

```ts
export type DecisionProviderDeps = {
  client: ConversationProviderClient;
  resolvePersonaFor(channelId: string): ConversationPolicyPersona;
  model?: string; // HENT_AI_CONVERSATION_DECISION_MODEL (기본: client.model)
};

export function createLlmConversationDecisionProvider(deps: DecisionProviderDeps): ConversationDecisionProvider;
```

`decide(request)` 흐름:
1. `persona = deps.resolvePersonaFor(request.scope.channelId)`
2. `prompt = buildSpeechDecisionPrompt({ config, scope, recentTurns, memorySummaries, persona: persona.text })`
   — 기존 계약 `hent_ai.conversation.speech_decision.v1` 그대로 사용.
3. `text = await client.complete(prompt)`
4. `parsed = parseSpeechDecisionResponse(text, config)`
   — 기존 파서가 주입 마커·청크 길이·신뢰도 임계값 검증을 이미 수행.
5. 매핑: `parsed.no_reply → {kind:"no_reply", reason, diagnostics}`,
   `parsed.speak → {kind:"speak", confidence, chunks, diagnostics}`.
   파싱 실패는 전부 `no_reply`(fail-closed).

### P1-3. soul 브리지: `service/src/conversation-persona.ts` (신규)

- `conversation-speech-policy.ts`의 `resolveConversationPersona`/`sanitizePersonaNote`를 정책 입력 전체 없이 쓸 수 있게 리팩터:
  `resolvePersonaText(input: { soulSnippet: string | null; configPersona?: string }): ConversationPolicyPersona` 를 export (기존 함수는 이를 호출하도록 변경, 동작 불변).
- DB 조회 구현:
  ```
  resolvePersonaFor(channelId):
    mapping = db.getChannelMapping(channelId)         // db.ts:152
    profile = mapping?.profileId ? db.getProfile(...) : null
    return resolvePersonaText({ soulSnippet: profile?.soulSnippet ?? null,
                                configPersona: config.persona })
  ```
- 우선순위 유지: `channel_profile(soulSnippet)` → `config.persona`(신규 env `HENT_AI_CONVERSATION_PERSONA`) → `GENERIC_CONVERSATION_PERSONA`.
- 사람 정체성 주장 새니타이즈 + "Never claim to be human" 경계는 기존 로직 그대로 (roadmap의 bounded-persona 정책 준수).

### P1-4. 런타임 배선

- `server-with-poller.ts`: `createConversationRuntime(db, config, { decisionProvider })` 로 주입.
  옵션에 `conversationDecisionProvider?: ConversationDecisionProvider` 추가 (테스트 오버라이드용).
- `conversation-chat-reply.ts`의 하드코딩 완화:
  - `channel: { enabled: true }` → `db.getChannelMapping(channelId)`의 `enabled` 조회로 교체
    (미등록 채널 기본값은 env `HENT_AI_CONVERSATION_DEFAULT_CHANNEL_ENABLED`, 기본 true —
    폴러의 `channels` env에 이미 나열된 채널만 폴링하므로 이중 opt-in 부담 방지).
  - `safeguards.duplicateTurn`: 직전 assistant 턴과 첫 청크가 동일(정규화 비교)하면 true.
  - `safeguards.selfEcho`: 최근 윈도우의 마지막 턴이 assistant이고 사람 턴이 그 뒤에 없으면 true.
- config env 확장 (`conversation-config.ts`): `HENT_AI_CONVERSATION_COOLDOWN_MS`, `_BUDGET_PER_HOUR`, `_MIN_HUMAN_IDLE_MS`, `_CONFIDENCE_THRESHOLD`, `_MAX_CHUNKS`, `_MAX_CHUNK_CHARS`, `_PERSONA`, `_RECENT_TURNS`(P2-4).
  기존 "invalid env → 전체 disabled" 정책은 유지하되, 진단 메시지에 어떤 키가 문제인지 이미 포함되므로 P0-3 로그로 노출.

### P1-5. 수용 기준

- [ ] mock chat-completions 서버로: 사람 메시지 기록 → 평가 tick → speak 결정 → persona 텍스트가 프롬프트 user JSON에 포함됨을 검증.
- [ ] `soul_snippet` 있는 프로필이 매핑된 채널은 `persona.source === "channel_profile"`.
- [ ] 프로바이더 5xx/타임아웃/비JSON 응답 → no_reply + 진단, 프로세스 생존.
- [ ] 신뢰도 < threshold → no_reply(`low_confidence`).
- [ ] 쿨다운/예산/사람 idle 게이트가 speak를 억제하는 케이스 각 1개.

---

## Phase 2 — 작업기억 파이프라인 (단기 맥락 갱신 + 장기 압축)

목표: 의도 단계 1·2·3. "raw 축적 → LLM 정리 → 주기 갱신 → 발화에 반영" 사이클 완성.

### P2-1. 단기 맥락(체크포인트) LLM 갱신

- 신규 `service/src/conversation-context-refresher.ts`:
  ```
  refreshScope(scopeId, channelId):
    recent = store.listRawEvents(scopeId).slice(-recentTurnWindow)
    checkpoint = store.getCheckpoint(scopeId)
    if (recent의 마지막 event id == checkpoint.recentEventIds 마지막) return "fresh"
    prompt = buildShortTermContextPrompt({ scope, recentTurns })   // 기존 계약 v1
    parsed = parseShortTermContextResponse(await client.complete(prompt, {model: contextModel}))
    실패 → 기존 naive summarizeRecentEvents 폴백 (현재 동작 보존, 진단 기록)
    성공 → upsertCheckpoint(summary = renderContext(parsed), recentEventIds)
  ```
  `renderContext`: `activeTopic / recentIntent / openQuestions / shouldRemember`를 한 덩어리 텍스트로 렌더 (프롬프트 주입용). 원본 JSON은 `recent_event_ids_json` 옆에 보존할 필요 없음 — summary 텍스트가 소비 형태.
- 트리거: **reply check tick과 동일한 인터벌에서, 결정 호출 직전에 수행** (별도 타이머 불필요, LLM 호출 1회 추가).
  단, `HENT_AI_CONVERSATION_CONTEXT_REFRESH=off`면 스킵(비용 절감 모드).
- 소비: `conversation-chat-reply.ts`에서 `memorySummaries = [checkpoint.summary, ...store.listSummaries(...)]`
  순으로 합쳐 `ConversationDecisionRequest.memorySummaries`에 전달. (계약 변경 없이 주입 — speech_decision 프롬프트는 이미 memorySummaries를 받음.)

### P2-2. 장기 기억 압축 스케줄러

- 신규 `service/src/conversation-memory-scheduler.ts`:
  ```
  createMemoryCompactionScheduler({ store, provider, config, intervalMs, log }):
    start(): 기동 1회 실행 + setInterval(intervalMs)
    stop()
  ```
  본체는 **기존 `compactConversationMemory`를 그대로 호출** (이미 완성: cutoff 그룹핑 → memory_compaction.v1 → addSummary → deleteRawEventsByIds).
- provider 어댑터: `ConversationMemoryCompactionProvider.compact(request)` → `client.complete(request.prompt, {model: memoryModel})`.
- env: `HENT_AI_CONVERSATION_COMPACTION_INTERVAL_MS` (기본 21_600_000 = 6h),
  `HENT_AI_CONVERSATION_RAW_RETENTION_DAYS` (기존, 기본 14 — 그룹챗 활성방 기준 2~3으로 낮추는 것 권장, 운영 판단).
- 결과 로그: `compactedScopeCount/summaryCount/prunedRawCount/diagnostics`.
- `server-with-poller.ts` (혹은 main.ts)에서 생성·시작하고 shutdown에 stop 포함.

### P2-3. 용량 기반 압축 (선택, 후순위)

- 시간 기준(retentionDays)만으로는 활성 방에서 raw가 무한히 크는 문제 방지:
  scope별 raw 이벤트 수 > `HENT_AI_CONVERSATION_MAX_RAW_PER_SCOPE`(기본 500)이면 최신 `recentTurnWindow×3`을 남기고 압축.
- `memory-eval-scaffold.md`의 "Summaries should be reversible to raw-event ids" 원칙 준수: `sourceEventStartId/EndId` 기록은 기존 구조가 이미 충족.

### P2-4. 윈도우 설정화

- `RECENT_TURN_WINDOW_SIZE = 8` (conversation-runtime.ts) → `config.recentTurnWindow`,
  env `HENT_AI_CONVERSATION_RECENT_TURNS` (기본 24 — 단체방에서 8은 문맥 소실이 심함).

### P2-5. 수용 기준

- [ ] 사람 메시지 N개 유입 → 다음 tick에 체크포인트가 LLM 산출로 갱신되고, 발화 프롬프트의 memorySummaries[0]에 포함된다.
- [ ] 컨텍스트 프로바이더 실패 시 naive 폴백으로 동작 지속 + 진단.
- [ ] 오래된 raw 이벤트가 스케줄러 실행 후 summary 1건으로 압축되고 raw는 삭제된다.
- [ ] 압축된 summary가 이후 발화 결정 프롬프트에 나타난다.
- [ ] 스케줄러 중복 실행 방지 (실행 중 재진입 가드).

---

## Phase 3 — 사람 같은 분할 전송

목표: 의도 단계 5. "카톡 한 줄" 청크 + 길이 비례 딜레이 + 타이핑 인디케이터.

### P3-1. 청크 규격 재조정

- 기본값 변경 (`conversation-config.ts`): `maxChunkChars` 1800 → **140**, `maxChunks` 4 → **5**.
  하드캡: 청크당 1800자(Discord 2000자 여유), 청크 수 8.
- LLM이 이미 `chunks[]`를 반환하므로(speech_decision.v1) 1차 분할 주체는 프로바이더.
  서비스는 검증만: 過長 청크는 문장/공백 경계로 재분할(기존 `splitDeliveryText` 로직을 branch에 복원하여 재사용), 빈 청크 제거.
- 프롬프트 보강(`buildSpeechDecisionPrompt` system): "chunks are separate chat bubbles, one short conversational line each, like a human typing in a group chat" 지시 추가. policy에 maxChunks/maxChunkChars가 이미 전달되므로 모델이 준수 가능.

### P3-2. 길이 비례 딜레이

- 신규 `service/src/conversation-delivery-timing.ts`:
  ```ts
  delayForChunkByLength(chunkText, config, random) =
    clamp(config.minDelayMs,
          round((basePauseMs + perCharMs * chunkText.length) * jitter(random, 0.85, 1.2)),
          config.maxDelayMs)
  ```
  - env: `HENT_AI_CONVERSATION_PER_CHAR_MS` (기본 55 — 한국어 채팅 타자 속도 근사), `HENT_AI_CONVERSATION_BASE_PAUSE_MS` (기본 400).
  - 첫 청크에도 딜레이 적용 (사람이 읽고 생각하는 시간) — 단 `minHumanIdleMs` 게이트가 이미 있으므로 첫 딜레이는 `basePauseMs`만.
- 단위 테스트: 짧은/긴 청크의 딜레이 단조성, clamp 경계, 지터 범위.

### P3-3. 전송 루프 복원 + 타이핑 인디케이터

- `discord-rest-poller.ts`의 `DiscordRestClient`에 `triggerTyping(channelId)` 추가:
  `POST /channels/{id}/typing` (효과 ~10초 지속).
- `discord-poller-integration.ts` `deliverChatReply` 수정 (branch의 `wait(0)` 교체):
  ```
  for each chunk:
    delay = delayForChunkByLength(chunk, config, random)
    await client.triggerTyping(channelId)       // 실패는 무시(비필수)
    if (delay > 9000) 9초마다 triggerTyping 재호출
    await wait(delay)
    sentId = await client.sendMessage(channelId, chunk)
    runtime.recordAssistant(...)                 // 기존 유지 (self-echo 방지 기록)
  ```
- **신선도 가드**: 딜레이 중 같은 채널에 새 사람 메시지가 관측되면(`pendingChatReplies`에 더 최신 messageId 등장) 남은 청크 전송을 중단하고 해당 채널을 재평가 대상으로 남긴다 — 뒷북 방지.

### P3-4. 수용 기준

- [ ] speak 결정 시 청크가 순서대로, 각 청크 길이에 비례한 딜레이 후 전송된다 (mock client의 타임스탬프 검증).
- [ ] 전송 전 typing 인디케이터 호출이 발생한다.
- [ ] 딜레이 중 새 사람 메시지 유입 → 남은 청크 중단 + 재평가 큐 유지.
- [ ] 청크는 모두 `maxChunkChars` 이하이고 Discord 2000자 한도를 넘지 않는다.

---

## Phase 4 — 운영 안정성 (silent failure 제거)

### P4-1. Message Content 인텐트 감지

- 증상: 인텐트 미활성 시 REST 응답의 `content`가 빈 문자열 → 현재 폴러가 조용히 필터링 → "봇 무반응".
- 폴 결과에서 (사람 저자 & content 빈 문자열) 메시지 비율을 추적, 연속 K회(기본 3회 tick) 전부 빈 content면:
  `error` 로그 "Discord Message Content Intent가 Developer Portal에서 비활성화된 것으로 보임" (채널별 1회 rate-limit).

### P4-2. 전송 실패 내구성

- `runReplyCheck`(branch) / `runEvaluation`(main): 채널별 try/catch.
  실패 시 pending 엔트리를 **삭제하지 않고** `attempts` 증가, `maxDeliveryAttempts`(기본 3) 초과 시에만 폐기 + error 로그.
- `sendMessage` 429: `Retry-After` 준수 후 1회 재시도. 403/404: 즉시 폐기 + 채널 설정 문제 로그.
- 한 채널의 실패가 다른 채널의 평가를 막지 않아야 한다 (per-channel isolation).

### P4-3. 폴러 상태 영속화

- DB 신규 테이블 (`db-schema.ts`):
  ```sql
  CREATE TABLE IF NOT EXISTS discord_poller_state (
    channel_id TEXT PRIMARY KEY,
    last_seen_message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- 폴러 기동 시 로드: 저장된 `last_seen_message_id`가 있으면 seed-skip 없이 그 이후 메시지부터 처리 (다운타임 메시지 유실 방지). 저장이 없을 때만 기존 seed-skip.
- 각 poll tick 후 upsert. (스키마 관리는 기존 `ensureSchema` 패턴 준수.)

### P4-4. 자기 루프·중복 방어 재점검

- 봇이 보낸 청크는 sentId로 `recordAssistant` 되므로 다음 poll에서 upsert dedupe (기존 `ON CONFLICT` 유지) — 회귀 테스트 추가.
- `BOT_USER_ID` 미설정이면 P0-3 경고에 더해, 자기 메시지가 "타 봇"으로 스킵되어 assistant 턴 기록이 소실됨을 문서에 명시 (필수 env로 승격).

### P4-5. 수용 기준

- [ ] sendMessage가 1회 throw해도 다음 tick에 재시도되어 최종 전송된다.
- [ ] 빈 content 연속 유입 시 인텐트 경고 로그.
- [ ] 프로세스 재시작 후 다운타임 중 메시지가 처리된다 (mock client 시나리오).

---

## Phase 5 — 검증과 롤아웃

### P5-1. 테스트 매트릭스

| 계층 | 대상 | 방식 |
|---|---|---|
| unit | provider-client 파싱/타임아웃, decision-provider 매핑, persona 브리지, delivery-timing, context-refresher 폴백 | vitest, mock fetch |
| integration | 폴러 tick → intake → 평가 → 정책 게이트 → 분할 전송 → ledger/기록 | mock DiscordRestClient + mock provider, fake timers |
| e2e (opt-in) | 실 Discord 채널 왕복 | 기존 `verify:discord-rest` 확장: 사람 메시지 게시 → speak까지 관찰 |
| redteam | 프롬프트 주입(트랜스크립트 내 지시), 사람 정체성 주장 유도, 청크 폭주 | 기존 contract-parser 마커 검증 + 신규 케이스 |

### P5-2. 롤아웃 순서

1. Phase 0 머지 (동작 변화 없음, 실행 가능화만) → 스테이징 채널 1개로 기동 확인.
2. Phase 1 + Phase 3 함께 배포 (발화가 생기는 최초 시점) — `budgetPerHour` 낮게(예: 6), 채널 1개, `HENT_AI_CONVERSATION_ENABLED=true`는 스테이징만.
3. 1주 관찰(로그: no_reply 사유 분포, 발화 빈도, 청크 품질) 후 Phase 2 배포.
4. Phase 4는 각 항목 독립 PR로 수시 배포 가능.
5. 프로덕션 확대: 채널 목록 확장 + 예산 상향.

### P5-3. 관측 지표 (로그 기반)

- tick당: pending 채널 수, decide 호출 수, speak/no_reply 비율, no_reply 사유 분포.
- 전송: 청크 수, 총 지연, 실패/재시도 수.
- 기억: 체크포인트 갱신 성공률, 압축 실행 결과.
- 프로바이더: 지연시간, 오류율 (장애 시 fail-closed 동작 확인용).

---

## 환경 변수 총괄

| 변수 | 기본 | 페이즈 | 설명 |
|---|---|---|---|
| `HENT_AI_PORT` / `HENT_AI_HOST` | 8787 / 127.0.0.1 | P0 | HTTP 서버 |
| `HENT_AI_DB_PATH` | ./hent-ai.sqlite | P0 | SQLite 경로 |
| `HENT_AI_CONVERSATION_ENABLED` | false | 기존 | 마스터 스위치 |
| `HENT_AI_DISCORD_POLLER_TOKEN` (폴백 `DISCORD_BOT_TOKEN`, `HENT_AI_DISCORD_TOKEN`) | — | 기존 | 필수 |
| `HENT_AI_DISCORD_POLLER_CHANNELS` (폴백 `HENT_AI_WATCH_CHANNELS`) | — | 기존 | 필수, 콤마 구분 |
| `HENT_AI_DISCORD_POLLER_BOT_USER_ID` | — | 기존 | 사실상 필수 (P4-4) |
| `HENT_AI_DISCORD_POLLER_INTERVAL_MS` | 15000 | 기존 | 폴 주기 |
| `HENT_AI_DISCORD_POLLER_EVALUATION_INTERVAL_MS` | 60000 | 기존 | reply check 주기 |
| `HENT_AI_CONVERSATION_PROVIDER_ENDPOINT/_TOKEN/_MODEL` | — | P1 | LLM 프록시 연결 (필수) |
| `HENT_AI_CONVERSATION_PROVIDER_TIMEOUT_MS` | 20000 | P1 | |
| `HENT_AI_CONVERSATION_PROVIDER_EXTRA_HEADERS/_EXTRA_BODY` | — | P1 | JSON |
| `HENT_AI_CONVERSATION_DECISION_MODEL/_CONTEXT_MODEL/_MEMORY_MODEL` | provider model | P1/P2 | 용도별 오버라이드 |
| `HENT_AI_CONVERSATION_PERSONA` | — | P1 | 프로필 없을 때 폴백 페르소나 |
| `HENT_AI_CONVERSATION_COOLDOWN_MS` | 600000 | P1 | 발화 쿨다운 |
| `HENT_AI_CONVERSATION_BUDGET_PER_HOUR` | 20 | P1 | 시간당 발화 예산 |
| `HENT_AI_CONVERSATION_MIN_HUMAN_IDLE_MS` | 12000 | P1 | 사람 발화 직후 대기 |
| `HENT_AI_CONVERSATION_CONFIDENCE_THRESHOLD` | 0.7 | P1 | |
| `HENT_AI_CONVERSATION_RECENT_TURNS` | 24 | P2 | 최근 턴 윈도우 |
| `HENT_AI_CONVERSATION_CONTEXT_REFRESH` | on | P2 | 단기 맥락 LLM 갱신 |
| `HENT_AI_CONVERSATION_COMPACTION_INTERVAL_MS` | 21600000 | P2 | 압축 주기 |
| `HENT_AI_CONVERSATION_RAW_RETENTION_DAYS` | 14 | 기존 | 압축 컷오프 |
| `HENT_AI_CONVERSATION_MAX_CHUNKS` | 5 | P3 | |
| `HENT_AI_CONVERSATION_MAX_CHUNK_CHARS` | 140 | P3 | |
| `HENT_AI_CONVERSATION_MIN_DELAY_MS` / `_MAX_DELAY_MS` | 650 / 6500 | 기존 | 딜레이 clamp |
| `HENT_AI_CONVERSATION_PER_CHAR_MS` | 55 | P3 | 길이 비례 계수 |
| `HENT_AI_CONVERSATION_BASE_PAUSE_MS` | 400 | P3 | 기본 숨 고르기 |
| `HENT_AI_CONVERSATION_MAX_DELIVERY_ATTEMPTS` | 3 | P4 | 전송 실패 후 pending 폐기 한도 |

## 운영 전제 (코드 밖 체크리스트)

- Discord Developer Portal에서 **MESSAGE CONTENT INTENT 활성화** (REST 폴링도 없으면 content가 빈 문자열).
- 봇 권한: View Channel, Read Message History, Send Messages (+ Trigger Typing은 Send Messages에 포함).
- LLM 프록시가 OpenAI chat-completions 호환 `POST` + `choices[0].message.content` 반환.
- `profile set-soul`로 프로필에 soul 텍스트 주입 + `channel_mappings`에 채널↔프로필 매핑.

## 신규/변경 파일 요약

| 파일 | 구분 | 페이즈 |
|---|---|---|
| `service/src/main.ts` | 신규 | P0 |
| `service/src/conversation-provider-client.ts` | 신규 | P1 |
| `service/src/conversation-decision-provider.ts` | 신규 | P1 |
| `service/src/conversation-persona.ts` | 신규 | P1 |
| `service/src/conversation-context-refresher.ts` | 신규 | P2 |
| `service/src/conversation-memory-scheduler.ts` | 신규 | P2 |
| `service/src/conversation-delivery-timing.ts` | 신규 | P3 |
| `service/src/conversation-config.ts` | 확장 (env 키) | P1–P3 |
| `service/src/conversation-chat-reply.ts` | 수정 (채널 게이트·safeguards·checkpoint 주입) | P1–P2 |
| `service/src/discord-poller-integration.ts` | 수정 (딜레이·typing·재시도·신선도) | P3–P4 |
| `service/src/discord-rest-poller.ts` | 수정 (triggerTyping·state 영속) | P3–P4 |
| `service/src/server-with-poller.ts` | 수정 (provider·스케줄러 배선) | P1–P2 |
| `service/src/db-schema.ts` | 수정 (`discord_poller_state`) | P4 |
| `service/src/conversation-speech-policy.ts` | 리팩터 (`resolvePersonaText` 노출) | P1 |
| `openclaw/README.md`, `docs/agent-runbook.md` | 문서 갱신 | 전체 |

## 리스크와 완화

| 리스크 | 완화 |
|---|---|
| LLM 비용 폭증 (tick마다 decide+context 호출) | pending 있는 채널만 호출(기존 구조), `CONTEXT_REFRESH=off` 스위치, 예산·쿨다운 게이트 |
| 봇 자기 루프 | assistant 기록 + selfEcho/duplicate safeguard + 사람 idle 게이트 (사람 발화 없으면 no_reply) |
| 프롬프트 주입 (방 참여자가 지시 삽입) | speech_decision 파서의 주입 마커 검증 유지 + redteam 케이스 추가 |
| 사람 사칭 | 페르소나 새니타이저 + "Never claim to be human" 경계 (기존, 완화 금지) |
| 프로바이더 장애 | 모든 프로바이더 오류 fail-closed(no_reply), naive 폴백(컨텍스트), 폴러 생존 |
| 머지 리스크 (6,500줄 삭제) | Phase 0을 독립 PR로, 전체 테스트 + 스테이징 검증 후 진행 |
