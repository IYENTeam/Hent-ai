# Onboarding 구현 명세

## 개요

OpenClaw `message_received` 훅 기반 대화형 온보딩 플로우.
유저가 "onboarding" 입력 → 캐릭터 설명 → base 생성/확인 → 감정별 1장씩 생성/확인 → 완료.

온보딩은 고정 switch 절차가 아니라 skill registry 기반으로 dispatch한다. 현재 세션 state에 대응하는 skill이 입력을 처리하며, 기본 skill 세트가 기존 UX를 그대로 구현한다.

---

## 상태 머신

```
AWAITING_CHARACTER
  → AWAITING_IMAGE_INTENT (이미지 첨부 시)
  → GENERATING_BASE
  → AWAITING_BASE_CONFIRM
  → GENERATING_EMOTION(currentIndex)      ← 감정 루프
  → AWAITING_EMOTION_CONFIRM(currentIndex) ← 감정 루프
  → COMPLETED
```

## Skill Registry

| Skill ID | 담당 state |
|---|---|
| `character-intake` | `AWAITING_CHARACTER` |
| `image-intent` | `AWAITING_IMAGE_INTENT` |
| `base-confirmation` | `AWAITING_BASE_CONFIRM` |
| `emotion-confirmation` | `AWAITING_EMOTION_CONFIRM` |
| `base-generation` | `GENERATING_BASE` |
| `emotion-generation` | `GENERATING_EMOTION` |

`handleMessage`는 `getOnboardingSkill(session.state)`로 skill을 찾고 해당 skill의 `handle(context)`만 호출한다. 새 온보딩 기능은 skill을 추가하거나 기존 skill을 교체하는 방식으로 확장한다.

```typescript
enum OnboardingState {
  AWAITING_CHARACTER,
  AWAITING_IMAGE_INTENT,
  GENERATING_BASE,
  AWAITING_BASE_CONFIRM,
  GENERATING_EMOTION,
  AWAITING_EMOTION_CONFIRM,
  COMPLETED,
}
```

---

## 세션 구조

```typescript
interface OnboardingSession {
  channelId: string;
  userId: string;
  state: OnboardingState;
  character: string;
  baseFeedback: string[];
  baseImageBuffer: Buffer | null;
  referenceImageUrl: string | null;
  currentEmotionIndex: number;
  currentEmotionBuffer: Buffer | null;
  emotionFeedback: Record<string, string[]>;
  createdAt: number;
  lastActivityAt: number;
}
```

**세션 관리:**
- Key: `channelId:userId`
- TTL: 30분 무활동 시 자동 만료
- GENERATING 상태에서 유저 입력 → "생성중입니다. 잠시 기다려주세요 ⏳"
- Workspace: `imageDir/.onboarding-workspaces/<channel>-<sessionKey|userId>`에 임시 저장한다.
- `imageDir`는 게이트웨이 프로필/워크스페이스별 asset root다. 명시 설정이 없으면 OpenClaw profile workspace 아래 `.hent-ai/emotion-image-assets`를 사용한다.
- 완료 전까지 프로필별 `imageDir`의 `base.png` / 감정 파일을 덮어쓰지 않는다.
- 완료 시 workspace 파일을 해당 프로필별 `imageDir`로 복사하고, 취소 시 workspace를 삭제한다.

---

## 플로우 상세

### 트리거

```typescript
const TRIGGERS = /^(onboarding|온보딩|셋업|setup)\s*$/i;
```

`message_received` 에서 감지. 활성 세션 있으면 거부.

---

### Step 1: AWAITING_CHARACTER

**봇:**
```
🎨 Hent-ai 온보딩을 시작합니다!

캐릭터를 설명해주세요.
예: "cute orange cat", "pixel art robot", "anime girl with blue hair"

이미지를 첨부하면:
• 이미지만 → 그대로 base 캐릭터로 사용합니다
• 이미지 + 텍스트 → 이미지를 참고하여 텍스트 기반으로 생성합니다

("취소"를 입력하면 종료)
```

**유저 입력 분기:**

| 입력 | character | referenceImageUrl | 전이 |
|---|---|---|---|
| 텍스트만 | content | null | → GENERATING_BASE |
| 이미지 첨부 (텍스트 유무 무관) | content (있으면) | 다운로드 → dataUrl | → AWAITING_IMAGE_INTENT |
| "취소" | — | — | 세션 삭제 |

---

### Step 1.5: AWAITING_IMAGE_INTENT

이미지가 첨부된 경우, 해당 이미지를 어떻게 사용할지 유저에게 확인한다.

**봇 (첨부된 이미지를 다시 보여주며):**
```
이미지를 받았어요! 어떻게 사용할까요?

1️⃣ 이 이미지를 그대로 base 캐릭터로 사용
2️⃣ 이 이미지를 참고해서 새로 생성
```

**유저 입력:**

| 입력 | 동작 |
|---|---|
| "1" / "그대로" / "그거" / "사용" | 이미지를 base로 직접 채택 → `baseImageBuffer = downloaded` → AWAITING_BASE_CONFIRM |
| "2" / "참고" / "레퍼런스" / "새로" | 이미지를 reference로 설정 → GENERATING_BASE |
| "취소" | 세션 삭제 |

**파싱:**
```typescript
const USE_AS_BASE = /^(1|그대로|그거|사용|use|as.?is)/i;
const USE_AS_REF = /^(2|참고|레퍼런스|reference|새로|생성|new)/i;
```

---

### Step 2: GENERATING_BASE

**봇:** "⏳ base 캐릭터를 생성하고 있어요..."

**로직:**
```typescript
const prompt = buildBasePrompt(session.character, session.baseFeedback);
const buffer = await generateImage({
  prompt,
  model,
  size: "1024x1024",
  referenceImages: session.referenceImageUrl ? [session.referenceImageUrl] : undefined,
});
session.baseImageBuffer = buffer;
```

**전이:** → AWAITING_BASE_CONFIRM (이미지 전송과 함께)

---

### Step 3: AWAITING_BASE_CONFIRM

**봇 (이미지 첨부):**
```
이 캐릭터가 마음에 드나요?

• "좋아" / "ok" → 감정 이미지 생성으로 진행
• "다시" / "재생성" → 같은 설정으로 재생성
• 그 외 → 피드백 반영하여 재생성
```

**유저 입력:**

| 입력 패턴 | 동작 |
|---|---|
| 긍정 (`/^(좋아\|ㅇㅇ\|ok\|good\|yes\|완벽\|이거)/i`) | currentEmotionIndex=0, → GENERATING_EMOTION |
| 재생성 (`/^(다시\|재생성\|retry\|again)/i`) | → GENERATING_BASE |
| 그 외 | `baseFeedback.push(content)` → GENERATING_BASE |
| "취소" | 세션 삭제 |

---

### Step 4: GENERATING_EMOTION

**봇:** "⏳ {emotion} 생성중... [{index+1}/6]"

**로직:**
```typescript
const emotion = EMOTIONS[session.currentEmotionIndex];
const prompt = buildEmotionPrompt(session.character, emotion, session.emotionFeedback[emotion] ?? []);
const buffer = await generateImage({
  prompt,
  model,
  size: "1024x1024",
  referenceImages: [bufferToDataUrl(session.baseImageBuffer!)],
});
session.currentEmotionBuffer = buffer;
```

**전이:** → AWAITING_EMOTION_CONFIRM (이미지 전송과 함께)

---

### Step 5: AWAITING_EMOTION_CONFIRM

**봇 (이미지 첨부):**
```
{emotion} [{index+1}/6]
마음에 드나요?

• "좋아" → 저장하고 다음 감정으로
• 피드백 입력 → 반영하여 재생성
• "스킵" → 현재 결과 저장, 다음으로
```

**유저 입력:**

| 입력 패턴 | 동작 |
|---|---|
| 긍정 / "스킵" | writeFile → currentEmotionIndex++ → (다음 or COMPLETED) |
| 피드백 텍스트 | `emotionFeedback[emotion].push(text)` → GENERATING_EMOTION |
| "취소" | 세션 삭제 |

**분기:**
- `currentEmotionIndex < 6` → GENERATING_EMOTION (다음 감정)
- `currentEmotionIndex === 6` → COMPLETED

---

### Step 6: COMPLETED

**봇:**
```
✅ 온보딩 완료!

저장된 이미지:
  base.png, happy.png, neutral.png, loyalty.png, sorry.png, confused.png, focused.png
  → {imageDir}

이제부터 봇 응답에 감정 이미지가 자동으로 붙습니다. 🎉
```

세션 삭제. base.png도 imageDir에 보존.

---

## Discord REST 유틸 (신규)

| 함수 | 용도 |
|---|---|
| `sendTextMessage(token, channelId, text)` | 텍스트만 전송 |
| `sendImageBufferMessage(token, channelId, buffer, filename, text?)` | Buffer 직접 전송 |
| `editTextMessage(token, channelId, messageId, text)` | 진행 메시지 업데이트 |
| `getMessageAttachments(token, channelId, messageId)` | 유저 첨부 URL 조회 |
| `downloadUrl(url)` | Discord CDN 이미지 다운로드 |

---

## 유저 입력 파싱 규칙

```typescript
const POSITIVE = /^(좋아|ㅇㅇ|ok|good|yes|완벽|이거|넘좋|굿|ㅇㅋ|확인|진행|next)/i;
const REGENERATE = /^(다시|재생성|retry|again|ㄴㄴ|별로|nope|no)\s*$/i;
const SKIP = /^(스킵|skip|건너뛰기|넘어가|패스)/i;
const CANCEL = /^(취소|cancel|quit|종료|그만)/i;
```

위 패턴에 매칭되지 않는 모든 텍스트 = 피드백으로 간주.

---

## 설정 (pluginConfig 확장)

```jsonc
{
  "onboarding": {
    "enabled": true,
    "trigger": "onboarding",
    "model": "provider/gpt-5.4",
    "size": "1024x1024",
    "sessionTimeoutMs": 1800000,
    "allowedUsers": []
  }
}
```

---

## 엣지 케이스

| 상황 | 대응 |
|---|---|
| GENERATING 중 유저 입력 | "생성중입니다. 잠시만요 ⏳" |
| 30분 무응답 | 세션 만료 메시지 전송 + 삭제 |
| 생성 API 실패 | "생성 실패: {에러}. 다시 시도할까요?" (세션 유지, 이전 state로 복귀) |
| 기존 assets 존재 | 덮어쓰기 (경고 없음 — 온보딩 시작 시 안내) |
| 동일 채널 다른 유저 | "현재 {유저}가 온보딩 중입니다" |
| Codex 인증 없음 | "서버에서 codex login이 필요합니다" + 세션 삭제 |
| attachments 미포함 (SDK 제한) | Discord REST GET 재조회 |

---

## 파일 구조

```
openclaw/
├── index.ts                         (기존 + registerOnboarding 호출)
├── onboarding/
│   ├── index.ts                     (registerOnboarding export)
│   ├── session.ts                   (OnboardingSession, SessionManager)
│   ├── flow.ts                      (state별 핸들러)
│   ├── discord-utils.ts             (Discord REST 확장)
│   ├── parsers.ts                   (유저 입력 패턴 매칭)
│   └── prompts.ts                   (base/emotion 프롬프트 빌더)
├── test/
│   └── onboarding.test.ts
└── package.json
```

---

## 구현 우선순위

| Phase | 범위 |
|---|---|
| P0 | session.ts + parsers.ts + 트리거 감지 + 텍스트 대화 스캐폴드 |
| P1 | discord-utils.ts + base 생성/확인 루프 |
| P2 | 감정별 순차 생성/확인 루프 (전체 플로우 완성) |
| P3 | 레퍼런스 이미지 첨부 처리 + 에러 핸들링 + 타임아웃 |
| P4 | 테스트 + README |
