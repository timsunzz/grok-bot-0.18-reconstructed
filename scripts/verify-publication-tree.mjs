import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { capture, run } from "./lib/process.mjs";
import { repoRoot } from "./lib/config.mjs";

// Neither tool is a macOS system binary, and a hardcoded /usr/bin path misses both a Homebrew git
// and a Nix one, reporting `spawn /usr/bin/git ENOENT` as though the repository were at fault.
// Bare names go through the usual PATH search, and the overrides let a caller pin a build.
const git = process.env.GROK_BOT_GIT?.trim() || "git";
const tar = process.env.GROK_BOT_TAR?.trim() || "tar";

const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-bot-publication-"));
const archive = path.join(scratch, "repository.tar");
const exported = path.join(scratch, "exported");

// Git adopts the invoking user's configuration, and two settings in it change what this comparison
// sees. `core.excludesFile` makes `git add --all` stage fewer files in the scratch repository, and
// `core.autocrlf` makes `git archive` rewrite line endings on the way out, so every text blob comes
// back with a different hash and the trees differ while the file lists match exactly. Either
// reports a publication defect that exists only on that machine.
//
// The environment variables cover global and system configuration. Both settings can equally live
// in this repository's own `.git/config`, which no environment variable can turn off, so the two
// that matter are also pinned per invocation — `-c` outranks every configuration file.
const isolated = {
  env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1" },
};
const inRepo = { ...isolated, cwd: repoRoot };
const inExport = { ...isolated, cwd: exported };
const fixedConfig = ["-c", "core.autocrlf=false", "-c", "core.excludesFile=", "-c", "core.eol=lf"];
const gitArgs = (args) => [...fixedConfig, ...args];

async function requireExported(relative) {
  const target = path.join(exported, relative);
  try {
    await access(target);
  } catch {
    throw new Error(`Fresh publication export omitted ${relative}. It is tracked in HEAD but did not survive git archive.`);
  }
  if ((await stat(target)).size === 0) {
    throw new Error(`Fresh publication export truncated ${relative} to zero bytes.`);
  }
}

try {
  await run(git, gitArgs(["archive", "--format=tar", `--output=${archive}`, "HEAD"]), inRepo);
  await mkdir(exported);
  await run(tar, ["-xf", archive, "-C", exported]);
  // An empty template keeps sample hooks out of the scratch repository.
  await run(git, gitArgs(["init", "--quiet", "--template="]), inExport);
  await run(git, gitArgs(["add", "--all"]), inExport);

  const [sourceTree, exportedTree, sourceFiles, exportedFiles] = await Promise.all([
    capture(git, gitArgs(["rev-parse", "HEAD^{tree}"]), inRepo),
    capture(git, gitArgs(["write-tree"]), inExport),
    capture(git, gitArgs(["ls-tree", "-r", "--name-only", "HEAD"]), inRepo),
    capture(git, gitArgs(["ls-files"]), inExport),
  ]);
  if (sourceTree !== exportedTree) {
    const sourceSet = new Set(sourceFiles.split("\n").filter(Boolean));
    const exportedSet = new Set(exportedFiles.split("\n").filter(Boolean));
    const omitted = [...sourceSet].filter(file => !exportedSet.has(file));
    const unexpected = [...exportedSet].filter(file => !sourceSet.has(file));
    const sameNames = omitted.length === 0 && unexpected.length === 0;
    throw new Error(`Fresh publication export changed the tracked tree (${sourceTree} became ${exportedTree}). Omitted: ${omitted.slice(0, 20).join(", ") || "none"}. Unexpected: ${unexpected.slice(0, 20).join(", ") || "none"}.${sameNames ? " Every tracked path survived, so the contents were rewritten in transit rather than lost." : ""}`);
  }

  await requireExported("frontend/src/recovered/ui/sand-form-primitives.css");
  console.log(`Publication export preserves ${sourceFiles.split("\n").filter(Boolean).length} files and tree ${sourceTree}.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
