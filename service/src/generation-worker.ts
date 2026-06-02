import type { ServiceDatabase, GenerationJob } from "./db.js";

export type GenerationProvider = {
  generate(request: unknown): Promise<unknown>;
};

export async function runNextGenerationJob(db: ServiceDatabase, provider: GenerationProvider): Promise<GenerationJob | null> {
  const job = db.claimNextGenerationJob();
  if (!job) return null;

  try {
    const result = await provider.generate(job.request);
    return db.markGenerationJobSucceeded(job.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return db.markGenerationJobFailed(job.id, message);
  }
}
