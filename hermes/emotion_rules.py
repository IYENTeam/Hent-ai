from __future__ import annotations

import re
from collections.abc import Iterable

DEFAULT_EMOTION_MAP: dict[str, str] = {
    "sorry": "sorry.png",
    "happy": "happy.png",
    "confused": "confused.png",
    "focused": "focused.png",
    "loyalty": "loyalty.png",
    "neutral": "neutral.png",
}
EMOTION_CONTRACT_VERSION = "EmotionContractV1"
DEFAULT_EMOTION = "neutral"
DEFAULT_SUPPORTED_PLATFORMS = {"discord", "telegram", "slack", "matrix", "mattermost"}

EMOTION_RULES: list[tuple[str, tuple[re.Pattern[str], ...]]] = [
    (
        "sorry",
        (
            re.compile(r"sorry|apolog|my bad|mistake|messed up|regret|oops", re.I),
            re.compile(r"죄송|미안|실수|잘못|에러가? 발생|오류가? 발생|버그.*발견|실패", re.I),
        ),
    ),
    (
        "happy",
        (
            re.compile(r"done|complete|succeed|fixed|shipped|great|awesome|excellent|perfect|nailed|pass|resolved|✅|🎉|🔥", re.I),
            re.compile(r"proud|happy|fantastic|wonderful|congrats|celebrate|woohoo|yay", re.I),
            re.compile(r"완료|성공|통과|해결|고쳤|수정.*완료|빌드.*성공|테스트.*통과|잘 ?됐|문제.*없", re.I),
        ),
    ),
    (
        "confused",
        (
            re.compile(r"confused|unclear|not sure|strange|unknown cause|weird|unexpected", re.I),
            re.compile(r"question|how do we|how should|what should|any idea|could you clarify", re.I),
            re.compile(r"확인.*필요|불확실|잘 ?모르|애매|이해가 안|의미가|어떤.*의미|모호|추가.*정보", re.I),
        ),
    ),
    (
        "focused",
        (
            re.compile(r"investigating|debugging|analyzing|implementing|working on|coding|building", re.I),
            re.compile(r"in progress|checking|processing|deploying|testing|verifying", re.I),
            re.compile(r"분석|조사|확인|살펴|디버깅|검토|읽[어고]|찾[아고]|작업 ?중|처리 ?중|검사", re.I),
        ),
    ),
    (
        "loyalty",
        (
            re.compile(r"got it|understood|on it|yes sir|will do|right away|hello|hi there|sure thing", re.I),
            re.compile(r"네[,.]?|알겠|이해했|시작하겠|바로|확인했|말씀대로|지시.*따[르라]|접수", re.I),
        ),
    ),
]

MEDIA_DIRECTIVE_RE = re.compile(
    r"""[`"']?MEDIA:\s*(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"']+)[`"']?""",
    re.I,
)


def detect_emotion(text: str, fallback: str = DEFAULT_EMOTION) -> str:
    for emotion, patterns in EMOTION_RULES:
        for pattern in patterns:
            if pattern.search(text):
                return emotion
    return fallback


def should_attach_for_platform(platform: str, allowed: Iterable[str]) -> bool:
    if not platform:
        return False
    normalized = platform.lower()
    allowed_set = set(allowed)
    return "*" in allowed_set or normalized in allowed_set


def strip_media_directives(text: str) -> str:
    without_directives = MEDIA_DIRECTIVE_RE.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", without_directives).strip()
