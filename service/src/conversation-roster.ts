import type { DiscordMembershipSnapshot, DiscordParticipantScope } from "./adaptive-ambient-contracts.js";

export type DiscordRosterMember = { readonly userId: string; readonly bot: boolean };
export type DiscordRosterPageRequest = { readonly limit: 1000; readonly after?: string };
export type DiscordRosterPageFetcher = (request: DiscordRosterPageRequest) => Promise<readonly DiscordRosterMember[]>;
export type ActiveHumanEvent = { readonly authorId: string; readonly authorIsBot: boolean; readonly createdAtMs: number };

export type RosterAccumulation = {
  readonly roster: DiscordMembershipSnapshot;
  readonly pagesRead: number;
  readonly terminated: "complete" | "page_failure" | "duplicate" | "non_increasing" | "max_pages";
};

const ROSTER_PAGE_SIZE = 1000;
const MAX_ROSTER_PAGES = 1000;
const ROSTER_FRESHNESS_MS = 5 * 60 * 1000;
const ACTIVE_HUMAN_WINDOW_MS = 10 * 60 * 1000;

export async function accumulateDiscordRoster(
  scope: DiscordParticipantScope,
  fetchPage: DiscordRosterPageFetcher,
  observedAtMs: number,
): Promise<RosterAccumulation> {
  const members: string[] = [];
  const seen = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_ROSTER_PAGES; pageNumber += 1) {
    let page: readonly DiscordRosterMember[];
    try {
      page = await fetchPage({ limit: ROSTER_PAGE_SIZE, ...(after ? { after } : {}) });
    } catch {
      return incomplete(scope, members, observedAtMs, pageNumber, "page_failure");
    }
    const validation = validatePage(page, seen, after);
    if (validation !== null) return incomplete(scope, members, observedAtMs, pageNumber + 1, validation);
    for (const member of page) {
      seen.add(member.userId);
      members.push(member.userId);
    }
    if (page.length < ROSTER_PAGE_SIZE) {
      return { roster: { scope, memberIds: members, complete: true, observedAtMs }, pagesRead: pageNumber + 1, terminated: "complete" };
    }
    after = page.at(-1)?.userId;
  }
  return incomplete(scope, members, observedAtMs, MAX_ROSTER_PAGES, "max_pages");
}

export function isFreshCompleteRoster(roster: DiscordMembershipSnapshot, nowMs: number): boolean {
  return roster.complete && Number.isFinite(nowMs) && Number.isFinite(roster.observedAtMs)
    && nowMs >= roster.observedAtMs && nowMs - roster.observedAtMs <= ROSTER_FRESHNESS_MS;
}

export function deriveActiveHumanIds(
  roster: DiscordMembershipSnapshot,
  events: readonly ActiveHumanEvent[],
  nowMs: number,
): readonly string[] {
  if (!isFreshCompleteRoster(roster, nowMs)) return [];
  const members = new Set(roster.memberIds);
  return [...new Set(events
    .filter((event) => !event.authorIsBot && Number.isFinite(event.createdAtMs)
      && event.createdAtMs <= nowMs && event.createdAtMs >= nowMs - ACTIVE_HUMAN_WINDOW_MS && members.has(event.authorId))
    .map((event) => event.authorId))].sort();
}

function validatePage(page: readonly DiscordRosterMember[], seen: ReadonlySet<string>, after?: string): "duplicate" | "non_increasing" | null {
  let previous: bigint | null = after === undefined ? null : BigInt(after);
  const pageIds = new Set<string>();
  for (const member of page) {
    let current: bigint;
    try {
      current = BigInt(member.userId);
    } catch {
      return "non_increasing";
    }
    if (seen.has(member.userId) || pageIds.has(member.userId)) return "duplicate";
    if (current < 1n || (previous !== null && current <= previous)) return "non_increasing";
    previous = current;
    pageIds.add(member.userId);
  }
  return null;
}

function incomplete(
  scope: DiscordParticipantScope,
  memberIds: readonly string[],
  observedAtMs: number,
  pagesRead: number,
  terminated: Exclude<RosterAccumulation["terminated"], "complete">,
): RosterAccumulation {
  return { roster: { scope, memberIds, complete: false, observedAtMs }, pagesRead, terminated };
}
