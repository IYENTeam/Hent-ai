import { containsInjectionMarker } from "./conversation-contract-parser.js";
import {
  ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS,
  type AmbientAppraisalParseResult,
  type AmbientSilenceRequest,
  type RelationshipProposal,
} from "./adaptive-ambient-contracts.js";

const APPRAISAL_REQUIRED_FIELDS = ["schema", "decision", "desiredDrive", "confidence", "chunks", "relationshipProposals"] as const;
const APPRAISAL_FIELDS = [...APPRAISAL_REQUIRED_FIELDS, "silenceRequest"] as const;
const RELATIONSHIP_FIELDS = ["userId", "rapportDelta", "familiarityDelta", "notes"] as const;
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;
const MAX_RELATIONSHIP_PROPOSALS = 3;

export function parseAmbientAppraisalProposal(text: string | null, confidenceThreshold = 0.7): AmbientAppraisalParseResult {
  if (!text || text.trim().length === 0) return invalid("provider output must be a non-empty JSON object");
  if (containsInjectionMarker(text)) return invalid("provider output contained prompt-injection-like content");
  const normalized = stripCodeFence(text.trim());
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); } catch (error) { if (error instanceof SyntaxError) return invalid("provider output was not valid JSON"); throw error; }
  if (!record(parsed)) return invalid("provider output must be a JSON object");
  if (!onlyAllowed(parsed, APPRAISAL_FIELDS) || !hasFields(parsed, APPRAISAL_REQUIRED_FIELDS)) return invalid("provider output contained an unknown field");
  if (parsed.schema !== ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal) return invalid(`schema must be ${ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal}`);
  if (parsed.decision !== "observe" && parsed.decision !== "speak") return invalid("decision must be observe or speak");
  if (!unit(parsed.desiredDrive)) return invalid("desiredDrive must be a finite number between 0 and 1");
  if (!unit(parsed.confidence)) return invalid("confidence must be a finite number between 0 and 1");
  if (parsed.confidence < confidenceThreshold) return invalid(`confidence ${parsed.confidence} is below threshold ${confidenceThreshold}`);
  const chunks = parseChunks(parsed.chunks, parsed.decision);
  if (!chunks) return invalid("chunks must match the decision and contain one to five non-empty safe bubbles of at most 1800 characters");
  const relationshipProposals = parseRelationships(parsed.relationshipProposals);
  if (!relationshipProposals) return invalid("relationshipProposals must contain only bounded relationship proposals");
  const silenceRequest = parseSilenceRequest(parsed.silenceRequest);
  return { kind: "valid", proposal: { schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal, decision: parsed.decision, desiredDrive: parsed.desiredDrive, confidence: parsed.confidence, chunks, relationshipProposals, silenceRequest } };
}

function stripCodeFence(text: string): string {
  const fenceStart = /^```(?:json)?\s*\n/;
  const fenceEnd = /\n```\s*$/;
  if (!fenceStart.test(text) || !fenceEnd.test(text)) return text;
  return text.replace(fenceStart, "").replace(fenceEnd, "");
}

function parseChunks(value: unknown, decision: "observe" | "speak"): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (decision === "observe") return value.length === 0 ? [] : null;
  if (value.length < 1 || value.length > 5) return null;
  const chunks: string[] = [];
  for (const chunk of value) { if (typeof chunk !== "string" || chunk.trim().length === 0 || chunk.length > 1800 || containsInjectionMarker(chunk)) return null; chunks.push(chunk); }
  return chunks;
}

function parseRelationships(value: unknown): readonly RelationshipProposal[] | null {
  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIP_PROPOSALS) return null;
  const proposals: RelationshipProposal[] = [];
  for (const candidate of value) {
    if (!record(candidate) || !only(candidate, RELATIONSHIP_FIELDS)) return null;
    const { userId, rapportDelta, familiarityDelta, notes: candidateNotes } = candidate;
    if (typeof userId !== "string" || !snowflake(userId) || !delta(rapportDelta) || !delta(familiarityDelta)) return null;
    const notes = parseNotes(candidateNotes); if (!notes) return null;
    proposals.push({ userId, rapportDelta, familiarityDelta, notes });
  }
  return proposals;
}

function parseNotes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const notes: string[] = [];
  for (const note of value) { if (typeof note !== "string" || note.trim().length === 0 || note.length > 160 || containsInjectionMarker(note)) return null; notes.push(note); }
  return notes;
}
function parseSilenceRequest(value: unknown): AmbientSilenceRequest {
  if (!record(value) || !onlyAllowed(value, ["present", "intensity"]) || !hasFields(value, ["present"])) return { present: false };
  if (value.present === false) return { present: false };
  if (value.present === true && (value.intensity === "mild" || value.intensity === "strong" || value.intensity === "moderator")) return { present: true, intensity: value.intensity };
  return { present: false };
}
function only(value: Record<string, unknown>, fields: readonly string[]): boolean { return onlyAllowed(value, fields) && hasFields(value, fields); }
function onlyAllowed(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every((field) => fields.includes(field)); }
function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean { return fields.every((field) => field in value); }
function unit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function delta(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= -0.1 && value <= 0.1; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function snowflake(value: string): boolean { return SNOWFLAKE.test(value) && BigInt(value) <= MAX_SNOWFLAKE; }
function invalid(diagnostic: string): AmbientAppraisalParseResult { return { kind: "invalid", diagnostic }; }
