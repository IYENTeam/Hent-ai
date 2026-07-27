import {
  applyAmbientIdleDecay,
  applyAmbientPressure,
  calculateAmbientProbability,
  evaluateAmbientDecision,
  IDLE_DECAY_TAU_MS,
  PRESSURE_TAU_MS,
} from "../src/conversation-ambient.js";
import {
  ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS,
  type AmbientAppraisalParseResult,
  type AmbientAppraisalProposal,
  type AmbientState,
  type DiscordParticipantScope,
} from "../src/adaptive-ambient-contracts.js";

const scope: DiscordParticipantScope = { guildId: "calibration-guild", channelId: "calibration-channel" };
const botUserId = "calibration-bot";
const baselineMs = Date.parse("2026-07-25T12:00:00.000Z");
type ReplayState = AmbientState & { readonly speakStreak?: number; readonly skipStreak?: number };
type ReplayRow = {
  readonly event: string;
  readonly elapsedMinutes: number;
  readonly driveBefore: number;
  readonly pressure: number;
  readonly baseProbability: number;
  readonly probability: number;
  readonly draw: number | null;
  readonly speak: boolean;
};

function appraisal(
  decision: "observe" | "speak",
  desiredDrive: number,
  silenceRequest: AmbientAppraisalProposal["silenceRequest"] = { present: false },
): AmbientAppraisalParseResult {
  return {
    kind: "valid",
    proposal: {
      schema: ADAPTIVE_AMBIENT_CONTRACT_SCHEMAS.appraisal,
      decision,
      desiredDrive,
      confidence: 1,
      chunks: decision === "speak" ? ["synthetic reply"] : [],
      relationshipProposals: [],
      silenceRequest,
    },
  };
}

function replay(
  events: readonly { readonly event: string; readonly nowMs: number; readonly appraisal: AmbientAppraisalParseResult; readonly mentioned: boolean }[],
  initialState: ReplayState | null,
  options: { readonly ambientPityEnabled?: boolean; readonly pressureTauMs?: number } = {},
): ReplayRow[] {
  let state = initialState;
  return events.map((event) => {
    const driveBefore = state === null ? 0.5 : applyAmbientIdleDecay(state.drive, state.updatedAtMs, event.nowMs, IDLE_DECAY_TAU_MS);
    const pressure = applyAmbientPressure(state, event.appraisal, event.nowMs, options.pressureTauMs ?? PRESSURE_TAU_MS);
    const result = evaluateAmbientDecision({
      appraisal: event.appraisal,
      eventId: event.event,
      state,
      message: { mentions: event.mentioned ? [botUserId] : [], replyTo: null },
      botUserId,
      roster: { scope, memberIds: ["human-a", "human-b"], complete: true, observedAtMs: event.nowMs },
      activeHumanIds: ["human-a", "human-b"],
      nowMs: event.nowMs,
      ambientPityEnabled: options.ambientPityEnabled ?? true,
      pressureTauMs: options.pressureTauMs,
    });
    const proposal = event.appraisal.kind === "valid" ? event.appraisal.proposal : null;
    const baseProbability = proposal === null || result.driveUpdate === null ? 0 : calculateAmbientProbability({
      decision: proposal.decision,
      validChunks: proposal.decision === "observe" ? proposal.chunks.length === 0 : proposal.chunks.length > 0,
      nextDrive: result.driveUpdate.drive,
      confidence: proposal.confidence,
      evidenceWeight: result.evidenceWeight,
    });
    state = result.driveUpdate;
    return {
      event: event.event,
      elapsedMinutes: (event.nowMs - baselineMs) / 60_000,
      driveBefore,
      pressure,
      baseProbability,
      probability: result.probability,
      draw: result.draw,
      speak: result.shouldSpeak,
    };
  });
}

function printScenario(name: string, rows: readonly ReplayRow[]): void {
  console.log(`\n${name}`);
  console.log("event                           min  drive_before  pressure  p_base  p_eff   draw    speak");
  for (const row of rows) {
    console.log(`${row.event.padEnd(31)} ${row.elapsedMinutes.toFixed(0).padStart(3)}  ${row.driveBefore.toFixed(4).padStart(12)}  ${row.pressure.toFixed(4).padStart(8)}  ${row.baseProbability.toFixed(4).padStart(6)}  ${row.probability.toFixed(4).padStart(6)}  ${(row.draw ?? 0).toFixed(4).padStart(6)}  ${row.speak ? "yes" : "no"}`);
  }
  const speaks = rows.filter((row) => row.speak).length;
  console.log(`final speak rate: ${speaks}/${rows.length} = ${(speaks / rows.length).toFixed(3)}`);
}

function assertInvariant(condition: boolean, message: string): void {
  if (!condition) throw new Error(`calibration invariant failed: ${message}`);
}

function main(): void {
  const baseline = replay(
    Array.from({ length: 8 }, (_, index) => ({
      event: `baseline-${String(index).padStart(2, "0")}`,
      nowMs: baselineMs + index * 60_000,
      appraisal: appraisal("speak", 0.5),
      mentioned: true,
    })),
    null,
    { ambientPityEnabled: false },
  );

  const idleSeed: ReplayState = { scope, drive: 0.8, version: 1, updatedAtMs: baselineMs, pressure: 0, pressureUpdatedAtMs: baselineMs, speakStreak: 0, skipStreak: 0 };
  const idle = replay([0, 60, 120].map((minutes) => ({
    event: `drive-0.8-after-${minutes}m-idle`,
    nowMs: baselineMs + minutes * 60_000,
    appraisal: appraisal("speak", 0.8),
    mentioned: true,
  })), idleSeed, { ambientPityEnabled: false });

  const pressureEvents = [0, 1, 2, 3, 4].map((minute, index) => ({
    event: `silence-request-${index + 1}`,
    nowMs: baselineMs + minute * 60_000,
    appraisal: appraisal("observe", 1, { present: true, intensity: "mild" }),
    mentioned: false,
  }));
  const pressure = replay([
    ...pressureEvents,
    { event: "pressure-ambient-00", nowMs: baselineMs + 5 * 60_000, appraisal: appraisal("speak", 1), mentioned: false },
    { event: "pressure-mention-02", nowMs: baselineMs + 6 * 60_000, appraisal: appraisal("speak", 1), mentioned: true },
  ], null, { ambientPityEnabled: false });

  const pitySeed: ReplayState = { scope, drive: 0.1, version: 1, updatedAtMs: baselineMs, pressure: 0, pressureUpdatedAtMs: baselineMs, speakStreak: 0, skipStreak: 0 };
  const pity = replay(["06", "10", "12", "13", "16", "17", "19", "23"].map((suffix, index) => ({
    event: `pity-fail-${suffix}`,
    nowMs: baselineMs + index * 60_000,
    appraisal: appraisal("speak", 0.1),
    mentioned: true,
  })), pitySeed);

  printScenario("Scenario A: baseline drive 0.5", baseline);
  printScenario("Scenario B: drive 0.8 then idle decay", idle);
  printScenario("Scenario C: five mild silence requests, ambient suppression, explicit mention", pressure);
  printScenario("Scenario D: eight consecutive failed draws with pity", pity);

  const idleDeviations = idle.map((row) => Math.abs(row.driveBefore - 0.5));
  assertInvariant(idleDeviations.every((value, index) => index === 0 || value < idleDeviations[index - 1]!), "idle decay is monotonic toward the 0.5 baseline");
  assertInvariant(pressure.every((row) => row.pressure >= 0 && row.pressure <= 1), "pressure remains bounded in [0,1]");
  assertInvariant(pressure.slice(0, 5).every((row, index) => index === 0 || row.pressure >= pressure[index - 1]!.pressure), "repeated silence requests raise pressure");
  assertInvariant(!pressure[5]!.speak && pressure[6]!.speak, "pressure suppresses ambient speech but not an explicit mention");
  assertInvariant(pity.every((row) => row.probability + Number.EPSILON >= row.baseProbability), "effective pity probability is never below base probability");
  assertInvariant(pity.every((row) => !row.speak), "selected pity draws remain consecutive failures");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  throw error;
}
