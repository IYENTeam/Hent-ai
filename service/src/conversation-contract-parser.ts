import type { ConversationProviderDiagnostic } from "./conversation-config.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export type ParseResult<T> =
  | { readonly kind: "ok"; readonly value: T; readonly diagnostics: readonly ConversationProviderDiagnostic[] }
  | { readonly kind: "no_reply"; readonly reason: string; readonly diagnostics: readonly ConversationProviderDiagnostic[] };

export type FieldResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing"; readonly diagnostic: ConversationProviderDiagnostic }
  | { readonly kind: "invalid"; readonly diagnostic: ConversationProviderDiagnostic };

const INJECTION_MARKERS = [
  "ignore previous instructions",
  "disregard previous instructions",
  "system prompt",
  "developer message",
  "@everyone",
  "@here",
  "http://",
  "https://",
  "MEDIA:",
] as const;

export function fail(code: string, message: string): ParseResult<never> {
  return { kind: "no_reply", reason: code, diagnostics: [{ code, message }] };
}

export function parseJsonObject(text: string | null): ParseResult<JsonObject> {
  if (!text || text.trim().length === 0) return fail("malformed_json", "provider output was empty");
  const trimmed = text.trim();
  if (containsInjectionMarker(trimmed)) return fail("prompt_injection", "provider output contained prompt-injection-like content");
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return fail("malformed_json", "provider output must be a JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("malformed_json", "provider output was not valid JSON");
    throw error;
  }
  const object = toJsonObject(parsed);
  if (!object) return fail("malformed_json", "provider output must be a JSON object");
  if (containsJsonInjectionMarker(object)) return fail("prompt_injection", "provider output contained prompt-injection-like content");
  return { kind: "ok", value: object, diagnostics: [] };
}

export function validateSchemaAndFields(
  object: JsonObject,
  schema: string,
  fields: readonly string[],
): ConversationProviderDiagnostic | null {
  const schemaField = readString(object, "schema");
  if (schemaField.kind !== "ok") return schemaField.diagnostic;
  if (schemaField.value !== schema) return { code: "invalid_field", message: `schema must be ${schema}` };
  const unknownField = Object.keys(object).find((key) => !fields.includes(key));
  return unknownField ? { code: "prompt_injection", message: `unexpected field ${unknownField}` } : null;
}

export function containsInjectionMarker(text: string): boolean {
  const lowered = text.toLowerCase();
  const normalized = decodeLiteralUnicodeEscapes(text).toLowerCase();
  return INJECTION_MARKERS.some((marker) => {
    const loweredMarker = marker.toLowerCase();
    return lowered.includes(loweredMarker) || normalized.includes(loweredMarker);
  });
}

export function readString(object: JsonObject, key: string): FieldResult<string> {
  const value = object[key];
  if (value === undefined) return missing(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be a non-empty string` } };
  }
  return { kind: "ok", value };
}

export function readNullableString(object: JsonObject, key: string): FieldResult<string | null> {
  const value = object[key];
  if (value === undefined) return missing(key);
  if (value === null) return { kind: "ok", value };
  if (typeof value !== "string") return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be a string or null` } };
  return { kind: "ok", value };
}

export function readStringArray(object: JsonObject, key: string): FieldResult<readonly string[]> {
  const value = object[key];
  if (value === undefined) return missing(key);
  if (!Array.isArray(value)) return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be an array of strings` } };
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be an array of strings` } };
    items.push(item);
  }
  return { kind: "ok", value: items };
}

export function readConfidence(object: JsonObject, key: string): FieldResult<number> {
  const value = object[key];
  if (value === undefined) return missing(key);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be a number between 0 and 1` } };
  }
  return { kind: "ok", value };
}

export function readDecision(object: JsonObject, key: string): FieldResult<"no_reply" | "speak"> {
  const value = object[key];
  if (value === undefined) return missing(key);
  if (value === "no_reply" || value === "speak") return { kind: "ok", value };
  return { kind: "invalid", diagnostic: { code: "invalid_field", message: `${key} must be no_reply or speak` } };
}

export function failField<T>(result: Exclude<FieldResult<T>, { readonly kind: "ok" }>): ParseResult<never> {
  return fail(result.diagnostic.code, result.diagnostic.message);
}

function missing(key: string): FieldResult<never> {
  return { kind: "missing", diagnostic: { code: "missing_field", message: `${key} is required` } };
}

function toJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function containsJsonInjectionMarker(value: JsonValue): boolean {
  if (typeof value === "string") return containsInjectionMarker(value);
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value)
    ? value.some(containsJsonInjectionMarker)
    : Object.values(value).some(containsJsonInjectionMarker);
}

function decodeLiteralUnicodeEscapes(text: string): string {
  let decoded = "";
  let index = 0;
  while (index < text.length) {
    const escape = readLiteralUnicodeEscape(text, index);
    if (escape) {
      decoded += escape.value;
      index = escape.nextIndex;
    } else {
      decoded += text[index] ?? "";
      index += 1;
    }
  }
  return decoded;
}

function readLiteralUnicodeEscape(text: string, index: number): { readonly value: string; readonly nextIndex: number } | null {
  if (text[index] !== "\\" || text[index + 1] !== "u") return null;
  const hex = text.slice(index + 2, index + 6);
  if (!isHexQuad(hex)) return null;
  return { value: String.fromCharCode(Number.parseInt(hex, 16)), nextIndex: index + 6 };
}

function isHexQuad(value: string): boolean {
  if (value.length !== 4) return false;
  for (const char of value) {
    if (!isHexDigit(char)) return false;
  }
  return true;
}

function isHexDigit(char: string): boolean {
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
    default:
      return false;
  }
}
