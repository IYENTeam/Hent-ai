#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VALID_EMOTIONS = ["happy", "neutral", "loyalty", "sorry", "confused", "focused"];
const GLOBAL_DIR = path.join(os.homedir(), ".hent-ai");
const CURSOR_GLOBAL_DIR = path.join(os.homedir(), ".cursor");
const ASSETS_DIR = path.resolve(__dirname, "..", "assets", "optimized");

function mkdirp(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyAssets(targetDir: string) {
  const dst = path.join(targetDir, "assets", "optimized");
  mkdirp(dst);
  for (const e of VALID_EMOTIONS) {
    const src = path.join(ASSETS_DIR, `${e}.png`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dst, `${e}.png`));
    }
  }
  console.log(`  ✓ 에셋 이미지 복사 완료 → ${dst}`);
}

function buildRule(assetPath: string): string {
  return `---
description: Hent-ai - display emotion character image at end of every response
globs:
alwaysApply: true
---

## Hent-ai Emotion Character Rule

At the very end of every response, after your complete answer, append a markdown image showing your emotion character.

### How

1. Write your full answer to the user's question first.

2. Classify your response emotion as one of: happy, sorry, confused, focused, loyalty, neutral
   - happy: success, completed, fixed, tests passed
   - sorry: error, apology, failure
   - confused: unclear, need more info
   - focused: analyzing, debugging, investigating
   - loyalty: greeting, acknowledged, starting task
   - neutral: general info, none of the above

3. As the very last line of your response, output this markdown (replace {emotion}):

![hent-ai](${assetPath}/{emotion}.png)

### Rules
- Always answer the question first. Never skip your answer.
- The image markdown must be the LAST line. Nothing after it.
- Only ONE image per response. Never repeat.
`;
}

function installRule(cursorDir: string, assetPath: string) {
  const rulesDir = path.join(cursorDir, "rules");
  mkdirp(rulesDir);
  const ruleFile = path.join(rulesDir, "hent-ai.mdc");
  fs.writeFileSync(ruleFile, buildRule(assetPath));
  console.log(`  ✓ Cursor 룰 설치 완료 → ${ruleFile}`);
}

function uninstall(scope: "project" | "global", projectRoot?: string) {
  const targetDir = scope === "global" ? GLOBAL_DIR : path.join(projectRoot!, ".cursor", "hent-ai");
  const cursorDir = scope === "global" ? CURSOR_GLOBAL_DIR : path.join(projectRoot!, ".cursor");

  const ruleFile = path.join(cursorDir, "rules", "hent-ai.mdc");
  if (fs.existsSync(ruleFile)) {
    fs.unlinkSync(ruleFile);
    console.log(`  ✓ 룰 제거: ${ruleFile}`);
  }

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`  ✓ 파일 제거: ${targetDir}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  const scope = args[1];

  if (!action || !["install", "uninstall", "status"].includes(action)) {
    console.log(`
╔══════════════════════════════════════╗
║          🎭  Hent-ai CLI            ║
╚══════════════════════════════════════╝

사용법:
  hent-ai install project   현재 프로젝트에 설치
  hent-ai install global    전체 환경에 설치 (글로벌)
  hent-ai uninstall project 현재 프로젝트에서 제거
  hent-ai uninstall global  전체 환경에서 제거
  hent-ai status            설치 상태 확인
`);
    return;
  }

  if (action === "status") {
    const cwd = process.cwd();
    const projectRule = path.join(cwd, ".cursor", "rules", "hent-ai.mdc");
    const globalRule = path.join(CURSOR_GLOBAL_DIR, "rules", "hent-ai.mdc");

    console.log("\n🎭 Hent-ai 설치 상태:");
    console.log(`  프로젝트 (${cwd}): ${fs.existsSync(projectRule) ? "✅ 설치됨" : "❌ 미설치"}`);
    console.log(`  글로벌: ${fs.existsSync(globalRule) ? "✅ 설치됨" : "❌ 미설치"}\n`);
    return;
  }

  if (!scope || !["project", "global"].includes(scope)) {
    console.error("❌ scope을 지정해 주세요: project 또는 global");
    process.exit(1);
  }

  const projectRoot = process.cwd();

  if (action === "install") {
    const targetDir = scope === "global" ? GLOBAL_DIR : path.join(projectRoot, ".cursor", "hent-ai");
    const cursorDir = scope === "global" ? CURSOR_GLOBAL_DIR : path.join(projectRoot, ".cursor");
    const assetPath = path.join(targetDir, "assets", "optimized");
    const label = scope === "project" ? `현재 프로젝트 (${projectRoot})` : "전체 환경 (글로벌)";

    console.log(`\n🎭 Hent-ai 설치: ${label}\n`);

    copyAssets(targetDir);
    installRule(cursorDir, assetPath);

    console.log(`\n✅ 설치 완료! Cursor를 리로드해 주세요.`);
    console.log(`   Cmd+Shift+P → "Developer: Reload Window"\n`);
  }

  if (action === "uninstall") {
    const label = scope === "project" ? `현재 프로젝트 (${projectRoot})` : "전체 환경 (글로벌)";
    console.log(`\n🎭 Hent-ai 제거: ${label}\n`);
    uninstall(scope as "project" | "global", projectRoot);
    console.log(`\n✅ 제거 완료!\n`);
  }
}

main();
