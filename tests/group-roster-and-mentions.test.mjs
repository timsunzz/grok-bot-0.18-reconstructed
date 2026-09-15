import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-group-"));
  const output = path.join(temporary, "mod.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("local plus remote group members share one six-seat cap", async () => {
  const loaded = await load("source/host/groups/group-store.ts");
  try {
    const roster = loaded.module.capCombinedGroupRoster(
      ["a", "b", "c", "d"],
      [
        { ownerAuthId: "u1", agentId: "r1", name: "Remote 1" },
        { ownerAuthId: "u1", agentId: "r2", name: "Remote 2" },
        { ownerAuthId: "u1", agentId: "r3", name: "Remote 3" },
      ],
    );
    assert.deepEqual(roster.memberIds, ["a", "b", "c", "d"]);
    assert.equal(roster.remoteMembers.length, 2);
    assert.equal(roster.memberIds.length + roster.remoteMembers.length, 6);
  } finally {
    await loaded.dispose();
  }
});

test("ambiguous first-name mentions do not steal another member", async () => {
  const loaded = await load("source/host/groups/group-chat.ts");
  try {
    const members = [
      { id: "1", name: "Alice Smith" },
      { id: "2", name: "Alice Jones" },
    ];
    assert.deepEqual(loaded.module.parseGroupMentions("@alice look", members), {
      isEveryone: false,
      memberIds: [],
    });
    assert.deepEqual(loaded.module.parseGroupMentions("@alicesmith look", members), {
      isEveryone: false,
      memberIds: ["1"],
    });
    assert.equal(loaded.module.parseGroupMentions("@everyone", members).isEveryone, true);
  } finally {
    await loaded.dispose();
  }
});
