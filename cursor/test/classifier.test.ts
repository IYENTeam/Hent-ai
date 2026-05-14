import { describe, expect, it } from "vitest";
import { detectEmotion, extractEmotion, EMOTION_RULES } from "../src/classifier/ruleClassifier";
import { VALID_EMOTIONS } from "../src/types";

describe("detectEmotion — 영어", () => {
  it("완료 키워드 → happy", () => {
    expect(detectEmotion("Task completed successfully")).toBe("happy");
    expect(detectEmotion("All tests passed!")).toBe("happy");
    expect(detectEmotion("Fixed the bug")).toBe("happy");
  });

  it("사과 키워드 → sorry", () => {
    expect(detectEmotion("Sorry, I made a mistake.")).toBe("sorry");
    expect(detectEmotion("I apologize for the error")).toBe("sorry");
  });

  it("혼란 키워드 → confused", () => {
    expect(detectEmotion("I'm not sure about this")).toBe("confused");
    expect(detectEmotion("How should we proceed?")).toBe("confused");
  });

  it("집중 키워드 → focused", () => {
    expect(detectEmotion("Currently debugging the issue")).toBe("focused");
    expect(detectEmotion("Testing in progress")).toBe("focused");
  });

  it("수용 키워드 → loyalty", () => {
    expect(detectEmotion("Got it, understood")).toBe("loyalty");
    expect(detectEmotion("Will do right away")).toBe("loyalty");
  });

  it("매칭 없음 → neutral", () => {
    expect(detectEmotion("The weather is nice today")).toBe("neutral");
  });

  it("대소문자 무시", () => {
    expect(detectEmotion("DONE SUCCEED")).toBe("happy");
  });

  it("첫 번째 매칭 우선", () => {
    expect(detectEmotion("Sorry, still analyzing")).toBe("sorry");
  });
});

describe("detectEmotion — 한국어", () => {
  it("완료 표현 → happy", () => {
    expect(detectEmotion("파일 수정이 완료되었습니다")).toBe("happy");
    expect(detectEmotion("빌드 성공했습니다")).toBe("happy");
    expect(detectEmotion("테스트 통과!")).toBe("happy");
    expect(detectEmotion("문제를 해결했습니다")).toBe("happy");
  });

  it("사과 표현 → sorry", () => {
    expect(detectEmotion("죄송합니다, 실수가 있었습니다")).toBe("sorry");
    expect(detectEmotion("에러가 발생했습니다")).toBe("sorry");
    expect(detectEmotion("버그를 발견했습니다")).toBe("sorry");
  });

  it("혼란 표현 → confused", () => {
    expect(detectEmotion("추가 확인이 필요합니다")).toBe("confused");
    expect(detectEmotion("이 부분이 불확실합니다")).toBe("confused");
    expect(detectEmotion("잘 모르겠습니다")).toBe("confused");
  });

  it("집중 표현 → focused", () => {
    expect(detectEmotion("코드를 분석하고 있습니다")).toBe("focused");
    expect(detectEmotion("디버깅 중입니다")).toBe("focused");
    expect(detectEmotion("파일을 살펴보겠습니다")).toBe("focused");
  });

  it("수용 표현 → loyalty", () => {
    expect(detectEmotion("네, 알겠습니다")).toBe("loyalty");
    expect(detectEmotion("바로 시작하겠습니다")).toBe("loyalty");
    expect(detectEmotion("이해했습니다")).toBe("loyalty");
  });
});

describe("detectEmotion — 커스텀 규칙", () => {
  it("커스텀 규칙 사용", () => {
    const customRules = [{ emotion: "sleepy" as any, patterns: [/drowsy|sleepy/i] }];
    expect(detectEmotion("feeling so drowsy", customRules)).toBe("sleepy");
  });

  it("커스텀 폴백", () => {
    expect(detectEmotion("nothing special", undefined, "happy")).toBe("happy");
  });
});

describe("extractEmotion (LLM 응답 파싱)", () => {
  it("정확한 매칭", () => {
    expect(extractEmotion("happy")).toBe("happy");
  });

  it("대소문자 무시", () => {
    expect(extractEmotion("HAPPY")).toBe("happy");
  });

  it("공백 trim", () => {
    expect(extractEmotion("  happy  ")).toBe("happy");
  });

  it("따옴표 제거", () => {
    expect(extractEmotion('"happy"')).toBe("happy");
    expect(extractEmotion("'happy'")).toBe("happy");
  });

  it("추가 텍스트에서 감정 추출", () => {
    expect(extractEmotion("The emotion is: happy")).toBe("happy");
    expect(extractEmotion("I would classify this as focused")).toBe("focused");
  });

  it("null/undefined/빈 문자열 → null", () => {
    expect(extractEmotion(null)).toBeNull();
    expect(extractEmotion(undefined)).toBeNull();
    expect(extractEmotion("")).toBeNull();
    expect(extractEmotion("   ")).toBeNull();
  });

  it("유효하지 않은 감정 → null", () => {
    expect(extractEmotion("angry")).toBeNull();
  });
});
