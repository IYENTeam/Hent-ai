// Clock pattern from Dori (sisyphuslabs/omo-dori-mode-experimental @ 40034ad,
// skills/dori-mode/scripts/src/run.ts), MIT License, Copyright (c) 2026 YeonGyu Kim.

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();
