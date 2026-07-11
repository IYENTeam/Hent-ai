import { parseArgs } from "node:util";

const SHORT_LIVED_BRANCH = /^(?:feat|fix|docs|chore|refactor|codex)\/.+$/;
const RELEASE_CANDIDATE_FIX = /^fix\/rc-.+$/;
const HOTFIX_BRANCH = /^hotfix\/.+$/;

function parseInput(args) {
  try {
    const { values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        base: { type: "string" },
        head: { type: "string" },
      },
      strict: true,
    });

    if (
      typeof values.base !== "string" ||
      typeof values.head !== "string" ||
      values.base.trim().length === 0 ||
      values.head.trim().length === 0
    ) {
      return null;
    }

    return { base: values.base, head: values.head };
  } catch {
    // no-excuse-ok: catch -- normalize all CLI parse failures at this boundary.
    return null;
  }
}

function deniedRouteDescription(base, head) {
  switch (base) {
    case "dev":
      return head === "release" || SHORT_LIVED_BRANCH.test(head)
        ? null
        : "feat/*, fix/*, docs/*, chore/*, refactor/*, codex/*, release";
    case "release":
      return head === "dev" || head === "main" || RELEASE_CANDIDATE_FIX.test(head)
        ? null
        : "dev, main, fix/rc-*";
    case "main":
      return head === "release" || HOTFIX_BRANCH.test(head)
        ? null
        : "release, hotfix/*";
    default:
      return null;
  }
}

const input = parseInput(process.argv.slice(2));

if (input === null) {
  console.error(
    "Invalid branch flow input: --base and --head must be non-empty branch names.",
  );
  process.exitCode = 2;
} else {
  const deniedDescription = deniedRouteDescription(input.base, input.head);

  if (deniedDescription === null) {
    console.log(`Branch flow allowed: ${input.head} -> ${input.base}.`);
  } else {
    console.error(
      `Branch flow denied: ${input.head} -> ${input.base}. Allowed heads for ${input.base}: ${deniedDescription}.`,
    );
    process.exitCode = 1;
  }
}
