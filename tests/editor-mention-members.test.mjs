import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hidden agents remain mentionable in the composer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-editor-mentions-"));
  const output = path.join(temporary, "editor-suggestion-provider.mjs");
  try {
    await build({
      entryPoints: [path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/editor-suggestion-provider.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
    });
    const { projectMentionMembers } = await import(`${pathToFileURL(output).href}?${Date.now()}`);
    const members = projectMentionMembers([
      { id: "visible", name: "Research" },
      { id: "hidden", name: "Ops", isHiddenFromSidebar: true },
    ], false);
    assert.deepEqual(members.map((member) => member.id), ["visible", "hidden"]);
    assert.equal(members[1].subtitle, "Hidden");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
