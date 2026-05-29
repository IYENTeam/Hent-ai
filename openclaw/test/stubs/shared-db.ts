import type {
  ChannelProfileMapping,
  ChannelSettings,
  Profile,
  ProfileCreateInput,
  ProfileUpdateInput,
} from "./shared-profile.js";

export class ProfileDatabase {
  constructor(_imageDir: string) {}
  static fromDatabase(_db: unknown): ProfileDatabase { return new ProfileDatabase(""); }
  createProfile(input: ProfileCreateInput): Profile { throw new Error(`stub createProfile ${input.id}`); }
  getProfile(_id: string): Profile | null { return null; }
  updateProfile(_id: string, _input: ProfileUpdateInput): Profile { throw new Error("stub updateProfile"); }
  deleteProfile(_id: string): boolean { return false; }
  listProfiles(): Profile[] { return []; }
  setChannelProfile(_channelId: string, _profileId: string): void {}
  getChannelProfile(_channelId: string): string | null { return null; }
  removeChannelProfile(_channelId: string): boolean { return false; }
  listChannelProfiles(): ChannelProfileMapping[] { return []; }
  setChannelEnabled(_channelId: string, _enabled: boolean): void {}
  getChannelEnabled(_channelId: string): boolean | null { return null; }
  removeChannelEnabled(_channelId: string): boolean { return false; }
  setChannelAssetSet(_channelId: string, _assetSetId: string): void {}
  getChannelSettings(_channelId: string): ChannelSettings | null { return null; }
  close(): void {}
}
