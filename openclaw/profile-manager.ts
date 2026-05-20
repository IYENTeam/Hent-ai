import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ProfileDatabase } from "@hent-ai/shared/db";
import type { Profile, ProfileCreateInput, ProfileUpdateInput } from "@hent-ai/shared/profile";

const PROFILES_DIR = "profiles";

let cachedDb: ProfileDatabase | null = null;
let cachedImageDir: string | null = null;

export function getProfileDatabase(imageDir: string): ProfileDatabase {
  if (cachedDb && cachedImageDir === imageDir) return cachedDb;
  cachedDb?.close();
  cachedDb = new ProfileDatabase(imageDir);
  cachedImageDir = imageDir;
  return cachedDb;
}

export function closeProfileDatabase(): void {
  cachedDb?.close();
  cachedDb = null;
  cachedImageDir = null;
}

export function getProfileImageDir(imageDir: string, profileId: string): string {
  return resolve(imageDir, PROFILES_DIR, profileId);
}

export function profileImageDirExists(imageDir: string, profileId: string): boolean {
  return existsSync(getProfileImageDir(imageDir, profileId));
}

export function resolveActiveProfileId(
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string | null {
  if (channelId) {
    const mapped = db.getChannelProfile(channelId);
    if (mapped) return mapped;
  }
  return defaultProfileId ?? null;
}

export function resolveProfileImageDirForChannel(
  imageDir: string,
  db: ProfileDatabase,
  channelId: string | undefined,
  defaultProfileId: string | undefined,
): string {
  const profileId = resolveActiveProfileId(db, channelId, defaultProfileId);
  if (!profileId) return imageDir;

  const profileDir = getProfileImageDir(imageDir, profileId);
  return existsSync(profileDir) ? profileDir : imageDir;
}

export function createProfile(db: ProfileDatabase, input: ProfileCreateInput): Profile {
  return db.createProfile(input);
}

export function switchChannelProfile(
  db: ProfileDatabase,
  channelId: string,
  profileId: string,
): void {
  db.setChannelProfile(channelId, profileId);
}

export function listProfiles(db: ProfileDatabase): Profile[] {
  return db.listProfiles();
}

export function getProfile(db: ProfileDatabase, id: string): Profile | null {
  return db.getProfile(id);
}

export function updateProfile(
  db: ProfileDatabase,
  id: string,
  input: ProfileUpdateInput,
): Profile {
  return db.updateProfile(id, input);
}

export function deleteProfile(db: ProfileDatabase, id: string): boolean {
  return db.deleteProfile(id);
}
