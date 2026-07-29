import { createHash } from "node:crypto";
import {
  isDiscordParticipantScopeAllowed,
  type DiscordParticipantChannelMapping,
  type DiscordParticipantStartupConfig,
} from "./adaptive-ambient-contracts.js";
import type { AdaptiveAmbientStore, Fence, ParticipantIngressEvent, ServiceClock } from "./adaptive-ambient-store.js";
import type { DiscordParticipantClient, DiscordParticipantMessage } from "./discord-participant-client.js";

const LEGACY_LEASE_KEY = "discord-ambient-worker";
const STALE_EVENT_MS = 10 * 60_000;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 1_000;

type Scope = { readonly guildId: string; readonly channelId: string };
type Heartbeat = (run: () => void, intervalMs: number) => () => void;
type WorkBoundary = (input: { readonly signal: AbortSignal; readonly fence: Fence }) => Promise<void>;

export type DiscordAmbientWorkerCoreOptions = {
  readonly store: AdaptiveAmbientStore;
  readonly client: Pick<DiscordParticipantClient, "fetchMessages">;
  readonly scope: Scope;
  readonly startup: DiscordParticipantStartupConfig;
  readonly channelMapping: (scope: Scope) => DiscordParticipantChannelMapping | null;
  readonly holderId: string;
  /** A composition-owned lease starts the archive scheduler before this core polls. */
  readonly initialFence?: Fence;
  /** Production composition keys leases by guild/channel; the legacy default preserves direct-core compatibility. */
  readonly leaseKey?: string;
  readonly selfUserId?: string;
  readonly clock?: ServiceClock;
  readonly scheduleHeartbeat?: Heartbeat;
  /** Task-9 composition point. It is called only after a successful ingress boundary. */
  readonly runWork?: WorkBoundary;
};

export type DiscordAmbientWorkerCore = {
  readonly runOnce: () => Promise<"aborted" | "disabled" | "ingested" | "lease_unavailable" | "seeded">;
  readonly stop: () => Promise<void>;
  readonly claimNextWork: () => string | null;
  readonly signal: AbortSignal;
};

export function createDiscordAmbientWorkerCore(options: DiscordAmbientWorkerCoreOptions): DiscordAmbientWorkerCore {
  const clock = options.clock ?? Date.now;
  const scheduleHeartbeat = options.scheduleHeartbeat ?? defaultHeartbeat;
  const controller = new AbortController();
  let fence: Fence | null = options.initialFence ?? null;
  let cancelHeartbeat: (() => void) | null = null;
  let active: Promise<"aborted" | "disabled" | "ingested" | "lease_unavailable" | "seeded"> | null = null;
  let stopping = false;

  function currentFence(): Fence | null {
    return !controller.signal.aborted && !stopping ? fence : null;
  }

  function loseLease(reason: string): void {
    const lostFence = fence;
    if (!lostFence || controller.signal.aborted) return;
    controller.abort(new Error(reason));
    cancelHeartbeat?.(); cancelHeartbeat = null;
    options.store.recordUnfencedDiagnostic(lostFence, reason);
  }

  function startHeartbeat(): void {
    if (cancelHeartbeat) return;
    cancelHeartbeat = scheduleHeartbeat(() => {
      try {
        const renewed = fence ? options.store.renewLease(fence) : null;
        if (!renewed) loseLease("discord worker lease renewal lost");
        else fence = renewed;
      } catch {
        loseLease("discord worker lease renewal failed");
      }
    }, 10_000);
  }

  function ensureLease(): boolean {
    if (currentFence()) { startHeartbeat(); return true; }
    if (controller.signal.aborted || stopping) return false;
    fence = options.store.acquireLease(options.leaseKey ?? LEGACY_LEASE_KEY, options.holderId);
    if (!fence) return false;
    startHeartbeat();
    return true;
  }

  if (fence) startHeartbeat();

  async function run(): Promise<"aborted" | "disabled" | "ingested" | "lease_unavailable" | "seeded"> {
    if (!ensureLease()) return controller.signal.aborted ? "aborted" : "lease_unavailable";
    if (!isDiscordParticipantScopeAllowed(options.startup, options.scope, options.channelMapping(options.scope))) return "disabled";
    const held = currentFence();
    if (!held) return "aborted";
    let messages: readonly DiscordParticipantMessage[];
    try {
      messages = await fetchForwardMessages(options.client, options.scope.channelId, options.store.cursor(options.scope) ?? undefined, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return "aborted";
      throw error;
    }
    if (!currentFence()) return "aborted";
    const ordered = [...messages].sort((left, right) => snowflakeOrder(left.id, right.id));
    const cursor = options.store.cursor(options.scope);
    if (cursor === null) {
      const newest = ordered.at(-1);
      if (newest && !options.store.setCursor(options.scope, newest.id, held)) return "aborted";
      return "seeded";
    }
    const forward = ordered.filter((message) => snowflakeOrder(message.id, cursor) > 0);
    if (forward.length === 0) {
      const held = currentFence();
      if (!held) return "aborted";
      if (options.runWork) await options.runWork({ signal: controller.signal, fence: held });
      return controller.signal.aborted ? "aborted" : "ingested";
    }
    const newest = forward.at(-1);
    if (!newest) return "ingested";
    options.store.ingestForwardEvents({ scope: options.scope, cursor: newest.id, fence: held, events: forward.map((message) => ingressEvent(message, options.scope, options.selfUserId, clock())) });
    const afterIngress = currentFence();
    if (!afterIngress) return "aborted";
    if (options.runWork) await options.runWork({ signal: controller.signal, fence: afterIngress });
    return controller.signal.aborted ? "aborted" : "ingested";
  }

  return {
    get signal() { return controller.signal; },
    runOnce() {
      if (!active) {
        active = run();
        void active.then(() => { active = null; }, () => { active = null; });
      }
      return active;
    },
    claimNextWork() {
      const held = currentFence();
      return held ? options.store.claimNextWork(options.scope, held) : null;
    },
    async stop() {
      stopping = true;
      controller.abort(new Error("discord worker stopped"));
      cancelHeartbeat?.(); cancelHeartbeat = null;
      if (active) await active;
      if (fence) options.store.releaseLease(fence);
      fence = null;
    },
  };
}

function ingressEvent(message: DiscordParticipantMessage, scope: Scope, selfUserId: string | undefined, now: number): ParticipantIngressEvent {
  const self = selfUserId !== undefined && message.author.id === selfUserId;
  const createdAtMs = Date.parse(message.timestamp);
  const metadata = {
    discordAuthorId: message.author.id,
    discordAuthorBot: message.author.bot,
    mentions: message.mentions,
    replyTo: message.replyTo,
    ingressDigest: digest(message),
  };
  return {
    eventId: message.id, eventDigest: digest(message), queue: !self && !message.author.bot, observeOnly: !self && now - createdAtMs > STALE_EVENT_MS,
    raw: { scopeId: `discord:${scope.guildId}:${scope.channelId}`, channelId: scope.channelId, messageId: message.id,
      authorRole: self ? "assistant" : "user", text: message.content, eventTs: message.timestamp, botSelfLoop: self, metadata },
  };
}

function digest(message: DiscordParticipantMessage): string {
  return createHash("sha256").update(JSON.stringify({ id: message.id, channelId: message.channelId, content: message.content, timestamp: message.timestamp, author: message.author, mentions: message.mentions, replyTo: message.replyTo })).digest("hex");
}

async function fetchForwardMessages(
  client: Pick<DiscordParticipantClient, "fetchMessages">,
  channelId: string,
  initialAfter: string | undefined,
  signal: AbortSignal,
): Promise<readonly DiscordParticipantMessage[]> {
  const messages: DiscordParticipantMessage[] = [];
  const seen = new Set<string>();
  let after = initialAfter;
  for (let pageNumber = 0; pageNumber < MAX_MESSAGE_PAGES; pageNumber += 1) {
    const page = await client.fetchMessages(channelId, { ...(after ? { after } : {}), limit: MESSAGE_PAGE_SIZE }, signal);
    let maximum = after;
    const ascending = [...page].sort((left, right) => snowflakeOrder(left.id, right.id));
    for (const message of ascending) {
      if (seen.has(message.id) || (after !== undefined && snowflakeOrder(message.id, after) <= 0) || (maximum !== undefined && snowflakeOrder(message.id, maximum) <= 0)) {
        throw new Error("Discord message pagination was not strictly cursor-forward");
      }
      seen.add(message.id);
      messages.push(message);
      maximum = message.id;
    }
    if (page.length < MESSAGE_PAGE_SIZE) return messages;
    if (maximum === after || maximum === undefined) throw new Error("Discord message pagination did not advance");
    after = maximum;
  }
  throw new Error("Discord message pagination exceeded the page limit");
}

function snowflakeOrder(left: string, right: string): number { return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0; }
function defaultHeartbeat(run: () => void, intervalMs: number): () => void { const timer = setInterval(run, intervalMs); return () => clearInterval(timer); }
