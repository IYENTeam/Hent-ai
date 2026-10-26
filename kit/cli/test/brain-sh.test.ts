// The fake herdr runs the actual generated launcher, whose fake Codex records
// its argv and registers the session the way the real brain would.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const codex = join(bin, "codex");
  writeFileSync(codex, `#!/usr/bin/env bash
if [ "$*" = "app-server daemon start" ]; then exit 0; fi
printf '%s\\0' "$@" > "$CODEX_LOG"
echo '{"agent":"codex","sessionId":"${SESSION_ID}","pane":"${PANE}","cwd":"/tmp"}' > "$HENT_HOME/session.json"
`);
  chmodSync(codex, 0o755);
  writeFileSync(
    herdr,
    `#!/usr/bin/env bash
{ printf 'herdr\\0'; for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; } >> "$HERDR_LOG"
case "$1 $2" in
  "status server") ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"${PANE}"}}}' ;;
  "pane run") shift 3; "$@" ;;
esac
exit 0
`,
  );
  chmodSync(herdr, 0o755);
  return { root, home, log, bin };
};

type Run = { code: number; stdout: string; stderr: string; calls: string[][]; codexArgs: string[] };

const run = async (s: Scratch, args: readonly string[], env: Record<string, string> = {}): Promise<Run> => {
  const proc = Bun.spawn(["bash", BRAIN_SH, ...args], {
    env: {
      PATH: `${s.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: s.root,
      HENT_HOME: s.home,
      HERDR_LOG: s.log,
      CODEX_LOG: `${s.log}.codex`,
      TMPDIR: process.env.TMPDIR,
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
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
  const codexArgs = existsSync(`${s.log}.codex`) ? readFileSync(`${s.log}.codex`, "utf8").split("\u0000").filter(Boolean) : [];
  return { code, stdout, stderr, calls, codexArgs };
};

/** The command the session must run first; everything after it is the instruction block. */
const register = (cwd: string): string => `hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd ${cwd} --pane ${PANE} --configure-codex`;
const instruction = (prompt: string, cwd: string): string => prompt.slice(prompt.indexOf(register(cwd)) + register(cwd).length);

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
    "pane run",
  ]);
  expect(got.calls[3]?.slice(1)).toEqual(["pane", "run", PANE, "bash", join(s.home, "state/brain-launch.sh")]);
  const startup = got.codexArgs;
  expect(startup.slice(0, 4)).toEqual(["--remote", "unix://", "-C", join(s.root, "hent-brain")]);
  expect(startup).toEqual(expect.arrayContaining(["-s", "workspace-write", "-a", "never", "sandbox_workspace_write.network_access=true"]));
  expect(startup).toContain(`shell_environment_policy.set.HENT_HOME=${JSON.stringify(s.home)}`);
  expect(startup).toContain(`shell_environment_policy.set.HERDR_PANE_ID=${JSON.stringify(PANE)}`);
  expect(startup.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(false);
  expect(startup).not.toContain("--add-dir");
  expect(readFileSync(join(s.home, "brain-codex.sid"), "utf8").trim()).toBe(SESSION_ID);

  const cwd = join(s.root, "hent-brain");
  const prompt = got.codexArgs.at(-1);
  expect(prompt).toContain(register(cwd));

  // The native image workflow is allowed explicitly: the tools it calls, the commands it runs and
  // the trees it reads.
  const rules = instruction(prompt!, cwd);
  for (const allowed of ["image_gen", "view_image", "hent media", "hent typing", "hent asset add", "hent send --file", "cat", "ls", "sed -n"]) {
    expect(rules).toContain(allowed);
  }
  for (const tree of [join(s.root, ".codex", "generated_images"), s.home, join(s.root, ".agents", "skills", "hent-mode")]) {
    expect(rules).toContain(tree);
  }
  // The brain writes no file at all: the tags go inline to `hent asset add`.
  expect(rules).not.toContain(join(s.home, "state", "media"));
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
  const startArgs = resumed.codexArgs;
  expect(startArgs.slice(0, 5)).toEqual(["resume", "--remote", "unix://", "-C", join(s.root, "hent-brain")]);
  expect(startArgs.slice(-2, -1)).toEqual([SESSION_ID]);
  for (const override of ["-s", "-a", "sandbox_workspace_write.network_access=true"]) {
    expect(startArgs).not.toContain(override);
  }
  expect(startArgs).toContain(`shell_environment_policy.set.HENT_HOME=${JSON.stringify(s.home)}`);
  expect(startArgs).toContain(`shell_environment_policy.set.HERDR_PANE_ID=${JSON.stringify(PANE)}`);
  expect(startArgs.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(false);

  // A resumed session still carries its old instructions, so the current ones are re-sent verbatim.
  const cwd = join(s.root, "hent-brain");
  const resumedPrompt = resumed.codexArgs.at(-1);
  expect(resumedPrompt).toContain(register(cwd));
  expect(instruction(resumedPrompt!, cwd)).toBe(instruction(first.codexArgs.at(-1)!, cwd));
  expect(instruction(resumedPrompt!, cwd)).toContain(join(codexHome, "generated_images"));
  expect(instruction(resumedPrompt!, cwd)).toContain("image_gen");
  expect(instruction(resumedPrompt!, cwd)).toContain("Extra house rule.");
}, 20_000);

test("brain.sh start --resume without a recorded session refuses to start anything", async () => {
  const s = scratch("hent-brain-noresume-");
  const got = await run(s, ["start", "--resume"]);

  expect(got.code).toBe(1);
  expect(got.stderr.trim()).toBe(`brain: no recorded Codex session (${join(s.home, "brain-codex.sid")})`);
  expect(got.calls.some((c) => c[2] === "create" || c[2] === "start" || c[2] === "prompt")).toBe(false);
}, 20_000);

test("brain.sh forwards non-default bridge and image switches to the shared daemon thread", async () => {
  const s = scratch("hent-brain-env-");
  const got = await run(s, ["start"], { HENT_BRIDGE_PORT: "19087", HENT_ENABLED: "0", HENT_URL: "http://127.0.0.1:19088" });
  expect(got.code).toBe(0);
  const args = got.codexArgs;
  expect(args).toContain('shell_environment_policy.set.HENT_BRIDGE_PORT="19087"');
  expect(args).toContain('shell_environment_policy.set.HENT_ENABLED="0"');
  expect(args).toContain('shell_environment_policy.set.HENT_URL="http://127.0.0.1:19088"');
}, 20_000);

test("brain.sh preserves long quoted startup input without sending it through terminal input", async () => {
  const s = scratch("hent-brain-long-");
  const marker = join(s.root, "must-not-exist");
  const extra = `${"long input ".repeat(1_000)} 'quoted' $(touch ${marker}) \`touch ${marker}\``;
  writeFileSync(join(s.home, "brain-prompt.md"), extra);
  const got = await run(s, ["start"]);
  expect(got.code).toBe(0);
  expect(got.codexArgs.at(-1)?.endsWith(extra)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(statSync(join(s.home, "state/brain-launch.sh")).mode & 0o777).toBe(0o600);
  expect(got.calls.find((call) => call[1] === "pane" && call[2] === "run")?.slice(3)).toEqual([
    PANE, "bash", join(s.home, "state/brain-launch.sh"),
  ]);
}, 20_000);
