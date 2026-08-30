# AffectSpaceV2 Contract

`VisualAffectV2` describes visible pixels. `ResponseAffectV2` describes the emotional and social tone of a completed assistant response. Both use the exact same ordered dimensions in `[0,1]`:

`valence`, `arousal`, `dominance`, `joy`, `anger`, `irritation`, `sadness`, `anxiety`, `fear`, `surprise`, `confusion`, `disgust`, `embarrassment`, `pride`, `determination`, `affection`, `warmth`, `playfulness`, `teasing`, `deference`, `smileIntensity`, `browTension`, `eyeOpenness`, `bodyOpenness`.

The source of truth is `shared/affect.ts`. Update producers, parsers, tests, weights, cache-policy versions, and this reference together when the contract changes.

## Generation-time Visual Tagging

Send only the actual image pixels and the schema instructions to a vision-capable LLM. Explicitly forbid inference from filename, planned label, prompt, or directory. Require:

- `schemaVersion: "VisualAffectV2"`
- `affectSpaceVersion: "AffectSpaceV2"`
- all 24 dimensions, with no extras or omissions
- confidence in `[0,1]`
- concise pixel-grounded evidence

The caller, not the model, binds `source.model`, `source.taggedAt`, `source.imageSha256`, and `source.promptVersion`. Store the immutable per-image result under the set's hidden `.affect/` directory and compile `affect-vectors.json` only after every hash matches.

## Response-time Routing

The verifier returns `ResponseAffectV2` with the same 24 dimensions. The router:

1. loads every valid `VisualAffectV2` candidate in the channel's mapped set;
2. computes normalized weighted Euclidean distance in the shared ordered space;
3. selects the minimum-distance candidate;
4. selects uniformly at random among candidates tied within `1e-12`.

For a V2-complete set, the old coarse emotion bucket must not filter candidates. Coarse emotion remains only for API compatibility and fallback to legacy sets. If any asset in a mapped V2 set lacks a valid tag/vector pair, fail closed to legacy routing instead of mixing incompatible spaces.

## Quality Review

Inspect nearest results for mixed affects, especially anger versus irritation, sadness versus embarrassment, warmth versus affection, and playful teasing versus hostility. Report actual coverage. If the maximum anger value is low because no image looks angry, the correct action is to generate more angry images, not inflate existing tags.
