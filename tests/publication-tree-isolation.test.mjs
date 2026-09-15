import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPublicationCheck(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts/verify-publication-tree.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the publication export compares the same tree regardless of the developer's git config", { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-gitconfig-"));
  try {
    // A personal `core.excludesFile` made `git add --all` stage a different tree in the scratch
    // repository, so the check reported a publication defect that existed only on that machine.
    const ignore = path.join(scratch, "ignore");
    const gitconfig = path.join(scratch, "gitconfig");
    await writeFile(ignore, "*.css\n*.json\n");
    await writeFile(gitconfig, `[core]\n\texcludesFile = ${ignore}\n\tautocrlf = true\n`);

    const result = await runPublicationCheck({ GIT_CONFIG_GLOBAL: gitconfig });

    assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Publication export preserves \d+ files and tree [0-9a-f]{40}\./);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the publication export resolves git and tar from PATH", { timeout: 120_000 }, async () => {
  // Hardcoded /usr/bin paths miss a Homebrew or Nix git and blame the repository for it.
  const result = await runPublicationCheck({});
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);

  const overridden = await runPublicationCheck({ GROK_BOT_GIT: "/nonexistent/git" });
  assert.notEqual(overridden.code, 0);
  assert.match(overridden.stderr, /ENOENT/);
});
