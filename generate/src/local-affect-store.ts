import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AFFECT_SPACE_VERSION, VISUAL_AFFECT_SCHEMA_VERSION, parseVisualAffectV2 } from "../../shared/affect.js";
import { VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION, type VisualAffectCollectionV2 } from "./affect-tags.js";
import { updateManifestFile } from "./manifest-update.js";

type ManifestSet = {
  readonly name?: string;
  readonly character?: string;
  readonly model?: string;
  readonly emotions?: Readonly<Record<string, readonly string[]>>;
  readonly [key: string]: unknown;
};

type AssetManifest = {
  readonly activeSet?: string;
  readonly sets?: Readonly<Record<string, ManifestSet>>;
};

export type LocalAffectStoreMigrationReport = {
  readonly dryRun: boolean;
  readonly sourceSetId: string;
  readonly targetSetId: string;
  readonly files: number;
  readonly bytes: number;
  readonly manifestPath: string;
  readonly activated: boolean;
  readonly checksum: string;
};

function safeSetId(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(normalized)) throw new Error(`${label} is not a safe set id`);
  return normalized;
}

function safeFilename(value: string): string {
  if (basename(value) !== value || !/^[^/\\\0]+\.(?:png|jpe?g|webp|gif)$/i.test(value)) throw new Error(`Unsafe asset filename: ${value}`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCollection(value: unknown): VisualAffectCollectionV2 {
  if (!isRecord(value)
    || value.schemaVersion !== VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION
    || value.affectSpaceVersion !== AFFECT_SPACE_VERSION
    || !isRecord(value.items)) throw new Error("Invalid VisualAffectCollectionV2");
  const items: Record<string, ReturnType<typeof parseVisualAffectV2>> = {};
  for (const [filename, raw] of Object.entries(value.items)) {
    safeFilename(filename);
    const affect = parseVisualAffectV2(raw);
    if (!affect?.source) throw new Error(`Invalid or unbound VisualAffectV2 for ${filename}`);
    items[filename] = affect;
  }
  return {
    schemaVersion: VISUAL_AFFECT_COLLECTION_SCHEMA_VERSION,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    items: items as VisualAffectCollectionV2["items"],
  };
}

function sourceSetFromManifest(value: unknown, sourceSetId: string): { manifest: AssetManifest; set: ManifestSet } {
  if (!isRecord(value) || !isRecord(value.sets) || !isRecord(value.sets[sourceSetId])) throw new Error(`Source manifest set not found: ${sourceSetId}`);
  return { manifest: value as AssetManifest, set: value.sets[sourceSetId] as ManifestSet };
}

function filesFromEmotions(set: ManifestSet): string[] {
  if (!isRecord(set.emotions)) throw new Error("Source set emotions are missing");
  const files = Object.values(set.emotions).flatMap((value) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Source set emotion files are invalid");
    return value.map(safeFilename);
  });
  if (files.length === 0 || new Set(files).size !== files.length) throw new Error("Source set files must be non-empty and unique");
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertRegularFile(path: string): Promise<number> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Asset must be a regular file: ${path}`);
  return stat.size;
}

async function copyExclusiveOrResume(source: string, target: string, expectedHash: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await sha256(target) !== expectedHash) throw new Error(`Refusing to overwrite different external asset: ${target}`);
  }
  if (await sha256(target) !== expectedHash) throw new Error(`Copied asset hash mismatch: ${target}`);
}

export async function migrateAffectAssetsToLocalStore(options: {
  readonly sourceRoot: string;
  readonly sourceSetId: string;
  readonly targetRoot: string;
  readonly targetSetId: string;
  readonly tagCollectionPath: string;
  readonly apply?: boolean;
  readonly activate?: boolean;
}): Promise<LocalAffectStoreMigrationReport> {
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const sourceSetId = safeSetId(options.sourceSetId, "sourceSetId");
  const targetSetId = safeSetId(options.targetSetId, "targetSetId");
  if (sourceRoot === targetRoot && sourceSetId === targetSetId) {
    throw new Error("Source and target set must differ when migrating within one external asset root");
  }
  const { set } = sourceSetFromManifest(await readJson(join(sourceRoot, "manifest.json")), sourceSetId);
  const collection = parseCollection(await readJson(resolve(options.tagCollectionPath)));
  const files = filesFromEmotions(set);
  const tagFiles = Object.keys(collection.items).sort();
  if (JSON.stringify(files) !== JSON.stringify(tagFiles)) throw new Error("Source manifest files and affect collection items differ");

  let bytes = 0;
  const checksum = createHash("sha256");
  for (const filename of files) {
    const source = join(sourceRoot, "sets", sourceSetId, filename);
    bytes += await assertRegularFile(source);
    const hash = await sha256(source);
    if (collection.items[filename]!.source?.imageSha256 !== hash) throw new Error(`Visual affect provenance hash mismatch: ${filename}`);
    checksum.update(`${filename}\0${hash}\n`);
  }

  const manifestPath = join(targetRoot, "manifest.json");
  let targetManifest: AssetManifest = { sets: {} };
  try {
    targetManifest = await readJson(manifestPath) as AssetManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const provenanceTimes = Object.values(collection.items).map((item) => item.source!.taggedAt).sort();
  const createdAt = typeof set.createdAt === "string" && set.createdAt.trim() ? set.createdAt : provenanceTimes[0]!;
  const targetSet: ManifestSet = {
    name: `${set.name ?? sourceSetId} Affect V2`,
    character: set.character,
    model: set.model,
    createdAt,
    sourceSetId,
    affectSpaceVersion: AFFECT_SPACE_VERSION,
    visualAffectSchema: VISUAL_AFFECT_SCHEMA_VERSION,
    emotions: set.emotions,
    affectAssets: collection.items,
  };
  if (targetManifest.sets?.[targetSetId] && JSON.stringify(targetManifest.sets[targetSetId]) !== JSON.stringify(targetSet)) {
    throw new Error(`External manifest already contains a different set: ${targetSetId}`);
  }

  if (options.apply) {
    for (const filename of files) {
      const source = join(sourceRoot, "sets", sourceSetId, filename);
      await copyExclusiveOrResume(source, join(targetRoot, "sets", targetSetId, filename), collection.items[filename]!.source!.imageSha256);
    }
    await updateManifestFile<AssetManifest>(manifestPath, (latest) => {
      if (latest?.sets?.[targetSetId] && JSON.stringify(latest.sets[targetSetId]) !== JSON.stringify(targetSet)) {
        throw new Error(`External manifest already contains a different set: ${targetSetId}`);
      }
      return {
        ...latest,
        ...(options.activate ? { activeSet: targetSetId } : {}),
        sets: { ...(latest?.sets ?? {}), [targetSetId]: targetSet },
      };
    });
  }

  return {
    dryRun: !options.apply,
    sourceSetId,
    targetSetId,
    files: files.length,
    bytes,
    manifestPath,
    activated: Boolean(options.apply && options.activate),
    checksum: checksum.digest("hex"),
  };
}

export async function runAffectStore(argv: readonly string[]): Promise<void> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--apply" || key === "--activate") flags.add(key);
    else if (key.startsWith("--") && argv[index + 1] && !argv[index + 1]!.startsWith("--")) values.set(key, argv[++index]!);
    else throw new Error(`Unknown or incomplete affect-store argument: ${key}`);
  }
  for (const key of ["--source-root", "--source-set", "--target-root", "--target-set", "--tags"]) {
    if (!values.get(key)) throw new Error(`Missing ${key}`);
  }
  const report = await migrateAffectAssetsToLocalStore({
    sourceRoot: values.get("--source-root")!,
    sourceSetId: values.get("--source-set")!,
    targetRoot: values.get("--target-root")!,
    targetSetId: values.get("--target-set")!,
    tagCollectionPath: values.get("--tags")!,
    apply: flags.has("--apply"),
    activate: flags.has("--activate"),
  });
  console.log(JSON.stringify(report, null, 2));
}
