import type { DiscordParticipantScope } from "./adaptive-ambient-contracts.js";

export type AmbientScopeDiagnostic = {
  readonly guildId: string;
  readonly channelId: string;
  readonly phase: "ingress" | "primary" | "validation" | "delivery";
  readonly status: string;
  readonly reason?: string;
};

export function sanitizeAmbientScopeDiagnostic(input: AmbientScopeDiagnostic): AmbientScopeDiagnostic {
  return {
    guildId: input.guildId,
    channelId: input.channelId,
    phase: input.phase,
    status: safeCode(input.status),
    ...(input.reason === undefined ? {} : { reason: safeCode(input.reason) }),
  };
}

export function ambientScopeDiagnostic(scope: DiscordParticipantScope, phase: AmbientScopeDiagnostic["phase"], status: string, reason?: string): AmbientScopeDiagnostic {
  return sanitizeAmbientScopeDiagnostic({ guildId: scope.guildId, channelId: scope.channelId, phase, status, reason });
}

function safeCode(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 96);
}
