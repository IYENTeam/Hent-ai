import { describe, expect, it } from "vitest";
import * as service from "./index.js";

describe("bounded relationship profiles and roster evidence", () => {
  it("merges bounded relationship proposals once per event/user/proposal index with stable notes", () => {
    const db = new service.ServiceDatabase();
    const store = service.createAdaptiveAmbientStore(db, () => 1_000);
    const fence = store.acquireLease("worker", "holder")!;
    const outcome = (eventId: string, workId: string, notes: readonly string[], rapportDelta: number): void => {
      expect(store.createWork({ id: workId, eventId, eventDigest: eventId, scope: { guildId: "guild", channelId: "channel" } })).toBe("created");
      expect(store.claimWork(workId, fence)).toBe(true);
      expect(store.recordOutcome({
        fence, eventId, workId, scope: { guildId: "guild", channelId: "channel" }, outcome: "observe", state: { drive: 0.5, version: 1 },
        relationships: [{ userId: "100", rapportDelta, familiarityDelta: 0.1, notes }],
      })).toBe("applied");
    };
    outcome("event-1", "work-1", [" Helpful   person ", "helpful person", "Met in rollout."], 0.1);
    expect(store.recordOutcome({ fence, eventId: "event-1", workId: "work-1", scope: { guildId: "guild", channelId: "channel" }, outcome: "observe", state: { drive: 0.5, version: 1 }, relationships: [{ userId: "100", rapportDelta: 0.1, familiarityDelta: 0.1, notes: ["must not replay"] }] })).toBe("idempotent");
    outcome("event-2", "work-2", ["Met in rollout.", "Trusted incident partner."], 0.1);

    expect(db.db.prepare("SELECT rapport,familiarity,notes_json FROM adaptive_relationship_profiles WHERE guild_id='guild' AND user_id='100'").get()).toEqual({
      rapport: 0.7, familiarity: 0.7, notes_json: expect.any(String),
    });
    expect(JSON.parse((db.db.prepare("SELECT notes_json FROM adaptive_relationship_profiles WHERE guild_id='guild' AND user_id='100'").get() as { notes_json: string }).notes_json)).toEqual(expect.arrayContaining(["helpful person", "Met in rollout.", "Trusted incident partner."]));
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM adaptive_relationship_ledger").get()).toEqual({ count: 2 });
    db.close();
  });

  it("accumulates only complete monotonically paged rosters and derives the exact fresh active-human intersection", async () => {
    const requests: service.DiscordRosterPageRequest[] = [];
    const members = (start: number, count: number): service.DiscordRosterMember[] => Array.from({ length: count }, (_, index) => ({ userId: String(start + index), bot: false }));
    const roster = await service.accumulateDiscordRoster({ guildId: "1", channelId: "2" }, async (request) => {
      requests.push(request);
      return requests.length === 1 ? members(1, 1000) : requests.length === 2 ? members(1001, 1000) : members(2001, 3);
    }, 10_000);
    expect(roster).toMatchObject({ pagesRead: 3, terminated: "complete", roster: { complete: true, memberIds: expect.arrayContaining(["1", "2003"]) } });
    expect(requests).toEqual([{ limit: 1000 }, { limit: 1000, after: "1000" }, { limit: 1000, after: "2000" }]);
    expect(service.deriveActiveHumanIds(roster.roster, [
      { authorId: "1", authorIsBot: false, createdAtMs: 0 },
      { authorId: "1", authorIsBot: false, createdAtMs: 9_999 },
      { authorId: "2003", authorIsBot: false, createdAtMs: 0 },
      { authorId: "9999", authorIsBot: false, createdAtMs: 9_999 },
      { authorId: "2", authorIsBot: true, createdAtMs: 9_999 },
    ], 10_000)).toEqual(["1", "2003"]);
    expect(service.deriveActiveHumanIds(roster.roster, [{ authorId: "1", authorIsBot: false, createdAtMs: 10_000 }], 310_001)).toEqual([]);
  });

  it("terminates incomplete on a page failure, duplicate or non-increasing page, and the 1000-page guard", async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({ userId: String(index + 1), bot: false }));
    const scope = { guildId: "1", channelId: "2" };
    await expect(service.accumulateDiscordRoster(scope, async () => { throw new Error("page two failed"); }, 0)).resolves.toMatchObject({ terminated: "page_failure", roster: { complete: false } });
    await expect(service.accumulateDiscordRoster(scope, async (request) => request.after ? page : page, 0)).resolves.toMatchObject({ terminated: "duplicate", roster: { complete: false, memberIds: expect.any(Array) } });
    await expect(service.accumulateDiscordRoster(scope, async () => [{ userId: "2", bot: false }, { userId: "1", bot: false }], 0)).resolves.toMatchObject({ terminated: "non_increasing", roster: { complete: false } });
    let backwardPage = 0;
    await expect(service.accumulateDiscordRoster(scope, async () => {
      backwardPage += 1;
      return backwardPage === 1 ? Array.from({ length: 1000 }, (_, index) => ({ userId: String(index + 1001), bot: false })) : [{ userId: "1", bot: false }];
    }, 0)).resolves.toMatchObject({ terminated: "non_increasing", roster: { complete: false } });
    let pageNumber = 0;
    const guarded = await service.accumulateDiscordRoster(scope, async () => {
      const start = pageNumber * 1000 + 1;
      pageNumber += 1;
      return Array.from({ length: 1000 }, (_, index) => ({ userId: String(start + index), bot: false }));
    }, 0);
    expect(guarded).toMatchObject({ pagesRead: 1000, terminated: "max_pages", roster: { complete: false } });
  });
});
