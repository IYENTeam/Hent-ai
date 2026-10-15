// kit/brain.sh runs against a fake `herdr` on PATH: every call is recorded, and `agent prompt`
// registers the session the way the real brain would with `hent session set`.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BRAIN_SH = join(import.meta.dir, "../../brain.sh");
const PANE = "w9:p1";
const SESSION_ID = "thread-abc";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

type Scratch = { root: string; home: string; log: string; bin: string };

const scratch = (prefix: string): Scratch => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const home = join(root, ".hent");
  mkdirSync(home, { recursive: true });
  const log = join(root, "herdr.log");
  const herdr = join(bin, "herdr");
  writeFileSync(
    herdr,
    `#!/usr/bin/env bash
{ printf 'herdr\\0'; for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; } >> "$HERDR_LOG"
case "$1 $2" in
  "status server") ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"${PANE}"}}}' ;;
  "agent start") ;;
  "agent prompt") echo '{"agent":"codex","sessionId":"${SESSION_ID}","pane":"${PANE}","cwd":"/tmp"}' > "$HENT_HOME/session.json" ;;
esac
exit 0
`,
  );
  chmodSync(herdr, 0o755);
  return { root, home, log, bin };
};

type Run = { code: number; stdout: string; stderr: string; calls: string[][] };

const run = async (s: Scratch, args: readonly string[], env: Record<string, string> = {}): Promise<Run> => {
  const proc = Bun.spawn(["bash", BRAIN_SH, ...args], {
    env: {
      PATH: `${s.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: s.root,
      HENT_HOME: s.home,
      HERDR_LOG: s.log,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const calls = (existsSync(s.log) ? readFileSync(s.log, "utf8") : "")
    .split("\u001e")
    .filter((record) => record.length > 0)
    .map((record) => record.split("\u0000").filter((arg) => arg.length > 0));
  return { code, stdout, stderr, calls };
};

const prompts = (calls: readonly string[][]): string[] => calls.filter((c) => c[1] === "agent" && c[2] === "prompt").map((c) => c[4]!);
const instruction = (prompt: string): string => prompt.slice(prompt.indexOf("Read the hent-mode skill"));

test("brain.sh start sends a startup instruction that allows the native image workflow", async () => {
  const s = scratch("hent-brain-start-");
  const got = await run(s, ["start"]);

  expect(got.stderr).toBe("");
  expect(got.code).toBe(0);
  expect(got.stdout.trim()).toBe(`brain: codex running in herdr pane ${PANE}`);
  expect(got.calls.map((c) => c.slice(1, 3).join(" "))).toEqual([
    "status server",
    "workspace list",
    "workspace create",
    "agent start",
    "agent prompt",
  ]);
  expect(got.calls[3]!.slice(1, 11)).toEqual([
    "agent", "start", "hent-brain", "--kind", "codex", "--pane", PANE, "--timeout", "60000", "--",
  ]);
  expect(readFileSync(join(s.home, "brain-codex.sid"), "utf8").trim()).toBe(SESSION_ID);

  const [prompt] = prompts(got.calls);
  expect(prompt!.startsWith(`hent mode. You are the Hent-ai Discord bot brain. First run this exact shell command: hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd ${join(s.root, "hent-brain")} ; `)).toBe(true);

  // The native image workflow is allowed explicitly - tool, trees, the one written file - and every
  // other prohibition stays.
  const rules = instruction(prompt!);
  expect(rules).toContain("call the built-in image_gen tool and view_image the PNG it saves");
  expect(rules).toContain(join(s.root, ".codex", "generated_images"));
  expect(rules).toContain("hent media, hent typing, hent asset add, hent send --file");
  expect(rules).toContain(`written under ${join(s.home, "state", "media")}`);
  expect(rules).toContain("Run only hent commands");
  expect(rules).toContain("read-only cat, ls and sed -n");
  expect(rules).toContain("write no files except the one VisualAffect JSON");
  expect(rules).toContain("never reveal internal details");
}, 20_000);

test("brain.sh start --resume re-sends the current startup instruction as the first prompt", async () => {
  const s = scratch("hent-brain-resume-");
  writeFileSync(join(s.home, "brain-prompt.md"), "Extra house rule.\n");
  const codexHome = join(s.root, "codex-home");

  const first = await run(s, ["start"], { CODEX_HOME: codexHome });
  expect(first.code).toBe(0);
  rmSync(s.log);

  const resumed = await run(s, ["start", "--resume"], { CODEX_HOME: codexHome });
  expect(resumed.stderr).toBe("");
  expect(resumed.code).toBe(0);
  expect(resumed.calls.find((c) => c[2] === "start")!.slice(10)).toEqual([
    "--", "resume", "-s", "workspace-write", "-a", "never", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", s.home, SESSION_ID,
  ]);

  // A resumed session still carries its old instructions, so the current ones are re-sent verbatim.
  const [resumedPrompt] = prompts(resumed.calls);
  expect(resumedPrompt!.startsWith('Session restarted; these instructions replace the ones you were started with. First run this exact shell command: hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd ')).toBe(true);
  expect(instruction(resumedPrompt!)).toBe(instruction(prompts(first.calls)[0]!));
  expect(instruction(resumedPrompt!)).toContain(join(codexHome, "generated_images"));
  expect(instruction(resumedPrompt!)).toContain("image_gen");
  expect(instruction(resumedPrompt!)).toContain("Extra house rule.");
}, 20_000);

test("brain.sh start --resume without a recorded session refuses to start anything", async () => {
  const s = scratch("hent-brain-noresume-");
  const got = await run(s, ["start", "--resume"]);

  expect(got.code).toBe(1);
  expect(got.stderr.trim()).toBe(`brain: no recorded Codex session (${join(s.home, "brain-codex.sid")})`);
  expect(got.calls.some((c) => c[2] === "create" || c[2] === "start" || c[2] === "prompt")).toBe(false);
}, 20_000);
