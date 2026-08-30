import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  buildSemanticImagePrompt,
  type SemanticGenerationItem,
  type SemanticGenerationPlanV1,
} from "./semantic-plan.js";

export const SEMANTIC_CANDIDATE_RECEIPT_VERSION = "SemanticCandidateReceiptV1" as const;
export const SEMANTIC_REVIEW_RECEIPT_VERSION = "SemanticCandidateReviewV1" as const;
export const SEMANTIC_ACCEPTANCE_INTENT_VERSION = "SemanticAcceptanceIntentV1" as const;

export interface SemanticCandidateReceiptV1 {
  readonly schemaVersion: typeof SEMANTIC_CANDIDATE_RECEIPT_VERSION;
  readonly itemId: string;
  readonly filename: string;
  readonly version: number;
  readonly candidatePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly recoveredFromOrphan?: true;
}

export interface SemanticCandidateReviewV1 {
  readonly schemaVersion: typeof SEMANTIC_REVIEW_RECEIPT_VERSION;
  readonly itemId: string;
  readonly version: number;
  readonly candidatePath: string;
  readonly sha256: string;
  readonly decision: "accepted" | "rejected";
  readonly reason: string;
  readonly finalPath?: string;
  readonly reviewedAt: string;
}

export interface SemanticAcceptanceIntentV1 {
  readonly schemaVersion: typeof SEMANTIC_ACCEPTANCE_INTENT_VERSION;
  readonly itemId: string;
  readonly version: number;
  readonly candidatePath: string;
  readonly sha256: string;
  readonly finalPath: string;
  readonly reason: string;
  readonly reviewedAt: string;
}

export interface SemanticBatchFaults {
  readonly afterCandidateBytesWritten?: () => void | Promise<void>;
  readonly afterAcceptanceIntentWritten?: () => void | Promise<void>;
  readonly afterFinalCopied?: () => void | Promise<void>;
}

export interface SemanticItemState {
  readonly status: "new" | "pending-review" | "rejected" | "accepted";
  readonly nextVersion: number;
  readonly candidate?: SemanticCandidateReceiptV1;
  readonly review?: SemanticCandidateReviewV1;
}

export interface SemanticCandidateReviewDecision {
  readonly decision: "accepted" | "rejected";
  readonly reason: string;
}

export interface RunSemanticBatchOptions {
  readonly setDir: string;
  readonly plan: SemanticGenerationPlanV1;
  readonly batch: number;
  readonly generate: (
    item: SemanticGenerationItem,
    prompt: string,
    referencePaths: readonly string[],
  ) => Promise<Buffer>;
  readonly review: (
    item: SemanticGenerationItem,
    candidatePath: string,
  ) => Promise<SemanticCandidateReviewDecision>;
  readonly now?: () => string;
  /** Fault injection used by crash-recovery tests; production callers leave this unset. */
  readonly faults?: SemanticBatchFaults;
}

export interface RunSemanticBatchResult {
  readonly generated: number;
  readonly resumed: number;
  readonly accepted: number;
  readonly rejected: number;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function candidatePathFor(setDir: string, itemId: string, version: number): string {
  return resolve(setDir, ".candidates", itemId, `v${version.toString().padStart(3, "0")}.png`);
}

function candidateReceiptPathFor(setDir: string, itemId: string, version: number): string {
  return resolve(setDir, ".receipts", itemId, `v${version.toString().padStart(3, "0")}-candidate.json`);
}

function reviewReceiptPathFor(setDir: string, itemId: string, version: number): string {
  return resolve(setDir, ".receipts", itemId, `v${version.toString().padStart(3, "0")}-review.json`);
}

function acceptanceIntentPathFor(setDir: string, hash: string): string {
  return resolve(setDir, ".hash-reservations", `${hash}.json`);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function parseCandidateReceipt(value: unknown): SemanticCandidateReceiptV1 {
  const receipt = value as Partial<SemanticCandidateReceiptV1>;
  if (
    !receipt
    || receipt.schemaVersion !== SEMANTIC_CANDIDATE_RECEIPT_VERSION
    || typeof receipt.itemId !== "string"
    || typeof receipt.filename !== "string"
    || !Number.isInteger(receipt.version)
    || typeof receipt.candidatePath !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
    || !Number.isInteger(receipt.byteLength)
    || typeof receipt.createdAt !== "string"
    || (receipt.recoveredFromOrphan !== undefined && receipt.recoveredFromOrphan !== true)
  ) throw new Error("Invalid semantic candidate receipt");
  return receipt as SemanticCandidateReceiptV1;
}

function parseReviewReceipt(value: unknown): SemanticCandidateReviewV1 {
  const receipt = value as Partial<SemanticCandidateReviewV1>;
  if (
    !receipt
    || receipt.schemaVersion !== SEMANTIC_REVIEW_RECEIPT_VERSION
    || typeof receipt.itemId !== "string"
    || !Number.isInteger(receipt.version)
    || typeof receipt.candidatePath !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
    || (receipt.decision !== "accepted" && receipt.decision !== "rejected")
    || typeof receipt.reason !== "string"
    || typeof receipt.reviewedAt !== "string"
  ) throw new Error("Invalid semantic candidate review receipt");
  return receipt as SemanticCandidateReviewV1;
}

function parseAcceptanceIntent(value: unknown): SemanticAcceptanceIntentV1 {
  const intent = value as Partial<SemanticAcceptanceIntentV1>;
  if (
    !intent
    || intent.schemaVersion !== SEMANTIC_ACCEPTANCE_INTENT_VERSION
    || typeof intent.itemId !== "string"
    || !Number.isInteger(intent.version)
    || typeof intent.candidatePath !== "string"
    || !/^[a-f0-9]{64}$/.test(intent.sha256 ?? "")
    || typeof intent.finalPath !== "string"
    || typeof intent.reason !== "string"
    || typeof intent.reviewedAt !== "string"
  ) throw new Error("Invalid semantic acceptance intent");
  return intent as SemanticAcceptanceIntentV1;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function receiptVersions(setDir: string, itemId: string): Promise<number[]> {
  const receiptDir = resolve(setDir, ".receipts", itemId);
  let files: string[];
  try {
    files = await readdir(receiptDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return [...new Set(files.flatMap((file) => {
    const match = file.match(/^v(\d{3})-(?:candidate|review)\.json$/);
    return match ? [Number(match[1])] : [];
  }))].sort((left, right) => left - right);
}

async function candidateVersions(setDir: string, itemId: string): Promise<number[]> {
  const candidateDir = resolve(setDir, ".candidates", itemId);
  let files: string[];
  try {
    files = await readdir(candidateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files.flatMap((file) => {
    const match = file.match(/^v(\d{3})\.png$/);
    return match ? [Number(match[1])] : [];
  }).sort((left, right) => left - right);
}

async function recoverCandidateReceipt(
  setDir: string,
  item: SemanticGenerationItem,
  version: number,
): Promise<SemanticCandidateReceiptV1> {
  const path = candidatePathFor(setDir, item.id, version);
  const image = await readFile(path);
  if (image.byteLength === 0) throw new Error(`Orphan semantic candidate for ${item.id} v${version.toString().padStart(3, "0")} is empty and requires audit`);
  const metadata = await stat(path);
  const receipt: SemanticCandidateReceiptV1 = {
    schemaVersion: SEMANTIC_CANDIDATE_RECEIPT_VERSION,
    itemId: item.id,
    filename: item.filename,
    version,
    candidatePath: portableRelative(setDir, path),
    sha256: sha256(image),
    byteLength: image.byteLength,
    createdAt: (metadata.birthtimeMs > 0 ? metadata.birthtime : metadata.mtime).toISOString(),
    recoveredFromOrphan: true,
  };
  const receiptPath = candidateReceiptPathFor(setDir, item.id, version);
  try {
    await writeJsonExclusive(receiptPath, receipt);
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return parseCandidateReceipt(await readJson(receiptPath));
  }
}

async function ensureFinalFromAcceptanceIntent(
  setDir: string,
  item: SemanticGenerationItem,
  candidate: SemanticCandidateReceiptV1,
  intent: SemanticAcceptanceIntentV1,
  faults?: SemanticBatchFaults,
): Promise<SemanticCandidateReviewV1> {
  if (
    intent.itemId !== item.id
    || intent.version !== candidate.version
    || intent.candidatePath !== candidate.candidatePath
    || intent.sha256 !== candidate.sha256
    || intent.finalPath !== item.filename
  ) throw new Error(`Semantic acceptance reservation for ${candidate.sha256} belongs to another item`);

  const candidatePath = resolve(setDir, candidate.candidatePath);
  const destination = resolve(setDir, item.filename);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await copyFile(candidatePath, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (sha256(existing) !== candidate.sha256) throw new Error(`Refusing to overwrite accepted semantic output ${item.filename}`);
  }
  await faults?.afterFinalCopied?.();

  const review: SemanticCandidateReviewV1 = {
    schemaVersion: SEMANTIC_REVIEW_RECEIPT_VERSION,
    itemId: item.id,
    version: candidate.version,
    candidatePath: candidate.candidatePath,
    sha256: candidate.sha256,
    decision: "accepted",
    reason: intent.reason,
    finalPath: item.filename,
    reviewedAt: intent.reviewedAt,
  };
  const reviewPath = reviewReceiptPathFor(setDir, item.id, candidate.version);
  try {
    await writeJsonExclusive(reviewPath, review);
    return review;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseReviewReceipt(await readJson(reviewPath));
    if (JSON.stringify(existing) !== JSON.stringify(review)) throw new Error(`Immutable semantic review differs for ${item.id} v${candidate.version}`);
    return existing;
  }
}

export async function inspectSemanticItemState(
  setDir: string,
  item: SemanticGenerationItem,
): Promise<SemanticItemState> {
  const storedCandidateVersions = await candidateVersions(setDir, item.id);
  const storedReceiptVersions = await receiptVersions(setDir, item.id);
  const versions = [...new Set([...storedCandidateVersions, ...storedReceiptVersions])].sort((left, right) => left - right);
  if (versions.length === 0) {
    return { status: "new", nextVersion: 1 };
  }

  const latestVersion = versions.at(-1)!;
  for (let expected = 1; expected <= latestVersion; expected += 1) {
    if (!versions.includes(expected)) throw new Error(`Semantic candidate history for ${item.id} is missing v${expected.toString().padStart(3, "0")}`);
    const candidatePath = candidatePathFor(setDir, item.id, expected);
    const candidateReceiptPath = candidateReceiptPathFor(setDir, item.id, expected);
    if (!(await pathExists(candidatePath))) throw new Error(`Missing immutable candidate bytes for ${item.id} v${expected.toString().padStart(3, "0")}`);
    if (!(await pathExists(candidateReceiptPath))) await recoverCandidateReceipt(setDir, item, expected);
  }

  const version = latestVersion;
  const candidateReceiptPath = candidateReceiptPathFor(setDir, item.id, version);
  if (!(await pathExists(candidateReceiptPath))) throw new Error(`Missing immutable candidate receipt for ${item.id} v${version}`);
  const candidate = parseCandidateReceipt(await readJson(candidateReceiptPath));
  const candidatePath = resolve(setDir, candidate.candidatePath);
  const candidateBuffer = await readFile(candidatePath);
  if (candidate.itemId !== item.id || candidate.filename !== item.filename || candidate.version !== version || sha256(candidateBuffer) !== candidate.sha256 || candidateBuffer.byteLength !== candidate.byteLength) {
    throw new Error(`Semantic candidate receipt mismatch for ${item.id} v${version}`);
  }

  const reviewPath = reviewReceiptPathFor(setDir, item.id, version);
  if (!(await pathExists(reviewPath))) {
    const intentPath = acceptanceIntentPathFor(setDir, candidate.sha256);
    if (await pathExists(intentPath)) {
      const intent = parseAcceptanceIntent(await readJson(intentPath));
      if (intent.itemId === item.id && intent.version === version) {
        const review = await ensureFinalFromAcceptanceIntent(setDir, item, candidate, intent);
        return { status: "accepted", nextVersion: version + 1, candidate, review };
      }
    }
    return { status: "pending-review", nextVersion: version, candidate };
  }
  const review = parseReviewReceipt(await readJson(reviewPath));
  if (review.itemId !== item.id || review.version !== version || review.sha256 !== candidate.sha256 || review.candidatePath !== candidate.candidatePath) {
    throw new Error(`Semantic review receipt mismatch for ${item.id} v${version}`);
  }
  if (review.decision === "rejected") return { status: "rejected", nextVersion: version + 1, candidate, review };

  const finalPath = resolve(setDir, item.filename);
  const finalBuffer = await readFile(finalPath);
  if (sha256(finalBuffer) !== candidate.sha256 || review.finalPath !== item.filename) throw new Error(`Accepted semantic output mismatch for ${item.id}`);
  return { status: "accepted", nextVersion: version + 1, candidate, review };
}

export async function stageSemanticCandidate(options: {
  readonly setDir: string;
  readonly item: SemanticGenerationItem;
  readonly version: number;
  readonly image: Buffer;
  readonly createdAt: string;
  readonly faults?: SemanticBatchFaults;
}): Promise<SemanticCandidateReceiptV1> {
  if (!Number.isInteger(options.version) || options.version < 1 || options.image.byteLength === 0) throw new Error("Semantic candidate version and image bytes must be valid");
  const path = candidatePathFor(options.setDir, options.item.id, options.version);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, options.image, { flag: "wx" });
  await options.faults?.afterCandidateBytesWritten?.();
  const receipt: SemanticCandidateReceiptV1 = {
    schemaVersion: SEMANTIC_CANDIDATE_RECEIPT_VERSION,
    itemId: options.item.id,
    filename: options.item.filename,
    version: options.version,
    candidatePath: portableRelative(options.setDir, path),
    sha256: sha256(options.image),
    byteLength: options.image.byteLength,
    createdAt: options.createdAt,
  };
  await writeJsonExclusive(candidateReceiptPathFor(options.setDir, options.item.id, options.version), receipt);
  return receipt;
}

async function reserveAcceptance(options: {
  readonly setDir: string;
  readonly item: SemanticGenerationItem;
  readonly candidate: SemanticCandidateReceiptV1;
  readonly reason: string;
  readonly reviewedAt: string;
}): Promise<SemanticAcceptanceIntentV1> {
  const intent: SemanticAcceptanceIntentV1 = {
    schemaVersion: SEMANTIC_ACCEPTANCE_INTENT_VERSION,
    itemId: options.item.id,
    version: options.candidate.version,
    candidatePath: options.candidate.candidatePath,
    sha256: options.candidate.sha256,
    finalPath: options.item.filename,
    reason: options.reason,
    reviewedAt: options.reviewedAt,
  };
  const path = acceptanceIntentPathFor(options.setDir, options.candidate.sha256);
  try {
    await writeJsonExclusive(path, intent);
    return intent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseAcceptanceIntent(await readJson(path));
    if (
      existing.itemId !== intent.itemId
      || existing.version !== intent.version
      || existing.candidatePath !== intent.candidatePath
      || existing.sha256 !== intent.sha256
      || existing.finalPath !== intent.finalPath
    ) throw new Error(`Semantic candidate ${options.item.id} duplicates an accepted or reserved image hash`);
    return existing;
  }
}

export async function reviewSemanticCandidate(options: {
  readonly setDir: string;
  readonly item: SemanticGenerationItem;
  readonly candidate: SemanticCandidateReceiptV1;
  readonly decision: SemanticCandidateReviewDecision;
  readonly reviewedAt: string;
  readonly faults?: SemanticBatchFaults;
}): Promise<SemanticCandidateReviewV1> {
  if (options.candidate.itemId !== options.item.id || options.candidate.filename !== options.item.filename) throw new Error("Candidate does not belong to semantic item");
  const reason = options.decision.reason.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (reason.length === 0 || reason.length > 500) throw new Error("Semantic candidate review reason must contain 1 to 500 characters");
  const receiptPath = reviewReceiptPathFor(options.setDir, options.item.id, options.candidate.version);
  if (await pathExists(receiptPath)) throw new Error(`Semantic candidate ${options.item.id} v${options.candidate.version} was already reviewed`);

  const candidatePath = resolve(options.setDir, options.candidate.candidatePath);
  const candidateBuffer = await readFile(candidatePath);
  if (sha256(candidateBuffer) !== options.candidate.sha256) throw new Error("Candidate bytes changed after staging");

  if (options.decision.decision === "accepted") {
    const intent = await reserveAcceptance({
      setDir: options.setDir,
      item: options.item,
      candidate: options.candidate,
      reason,
      reviewedAt: options.reviewedAt,
    });
    await options.faults?.afterAcceptanceIntentWritten?.();
    return ensureFinalFromAcceptanceIntent(options.setDir, options.item, options.candidate, intent, options.faults);
  }

  const review: SemanticCandidateReviewV1 = {
    schemaVersion: SEMANTIC_REVIEW_RECEIPT_VERSION,
    itemId: options.item.id,
    version: options.candidate.version,
    candidatePath: options.candidate.candidatePath,
    sha256: options.candidate.sha256,
    decision: "rejected",
    reason,
    reviewedAt: options.reviewedAt,
  };
  await writeJsonExclusive(receiptPath, review);
  return review;
}

export async function runSemanticBatch(options: RunSemanticBatchOptions): Promise<RunSemanticBatchResult> {
  if (!Number.isInteger(options.batch) || options.batch < 0 || options.batch >= 10) throw new Error("Semantic batch must be an integer from 0 through 9");
  const now = options.now ?? (() => new Date().toISOString());
  const items = options.plan.items.filter((item) => item.batch === options.batch);
  if (items.length !== 10) throw new Error(`Semantic batch ${options.batch} must contain exactly ten items`);

  let generated = 0;
  let resumed = 0;
  let accepted = 0;
  let rejected = 0;
  for (const item of items) {
    let state = await inspectSemanticItemState(options.setDir, item);
    if (state.status === "accepted") {
      resumed += 1;
      accepted += 1;
      continue;
    }
    let candidate = state.candidate;
    if (state.status !== "pending-review") {
      const image = await options.generate(item, buildSemanticImagePrompt(item), options.plan.references);
      candidate = await stageSemanticCandidate({
        setDir: options.setDir,
        item,
        version: state.nextVersion,
        image,
        createdAt: now(),
        faults: options.faults,
      });
      generated += 1;
    } else {
      resumed += 1;
    }
    if (!candidate) throw new Error(`Semantic candidate missing for ${item.id}`);
    const decision = await options.review(item, resolve(options.setDir, candidate.candidatePath));
    const review = await reviewSemanticCandidate({ setDir: options.setDir, item, candidate, decision, reviewedAt: now(), faults: options.faults });
    if (review.decision === "accepted") accepted += 1;
    else rejected += 1;
    state = await inspectSemanticItemState(options.setDir, item);
    if (review.decision === "accepted" && state.status !== "accepted") throw new Error(`Semantic item ${item.id} was not durably accepted`);
  }
  return { generated, resumed, accepted, rejected };
}
