import { AFFECT_DIMENSIONS, AFFECT_SPACE_VERSION, RESPONSE_AFFECT_SCHEMA_VERSION, type AffectDimensionsV2, type ResponseAffectV2 } from "../../../shared/affect.ts";

export type ParseAffectResult =
  | { readonly ok: true; readonly affect: ResponseAffectV2 }
  | { readonly ok: false; readonly error: string };

const INTEGER_PATTERN = /^\d+$/;

function parseScaled(raw: string, label: string): { readonly value: number } | { readonly error: string } {
  const trimmed = raw.trim();
  if (!INTEGER_PATTERN.test(trimmed)) return { error: `${label} must be an integer 0-100, got "${trimmed}"` };
  const value = Number(trimmed);
  if (value > 100) return { error: `${label} must be an integer 0-100, got ${value}` };
  return { value: value / 100 };
}

export function parseAffectArg(value: string): ParseAffectResult {
  const parts = value.split("|");
  if (parts.length !== 2) return { ok: false, error: "affect must be \"<24 comma-separated values>|<confidence>\"" };
  const [dimensionPart, confidencePart] = parts as [string, string];

  const values = dimensionPart.split(",");
  if (values.length !== AFFECT_DIMENSIONS.length) {
    return { ok: false, error: `expected ${AFFECT_DIMENSIONS.length} comma-separated dimension values, got ${values.length}` };
  }

  const dimensions = {} as Record<(typeof AFFECT_DIMENSIONS)[number], number>;
  for (let index = 0; index < AFFECT_DIMENSIONS.length; index += 1) {
    const key = AFFECT_DIMENSIONS[index]!;
    const parsed = parseScaled(values[index]!, key);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    dimensions[key] = parsed.value;
  }

  const confidence = parseScaled(confidencePart, "confidence");
  if ("error" in confidence) return { ok: false, error: confidence.error };

  return {
    ok: true,
    affect: {
      schemaVersion: RESPONSE_AFFECT_SCHEMA_VERSION,
      affectSpaceVersion: AFFECT_SPACE_VERSION,
      dimensions: dimensions as AffectDimensionsV2,
      confidence: confidence.value,
    },
  };
}
