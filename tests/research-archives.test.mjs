import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const archiveRoot = path.join(repositoryRoot, "research-archives", "original", "0.18.0");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

// The installers are Git LFS objects. A checkout without `git lfs pull` leaves ~134-byte text
// pointers in their place, and comparing those against the real byte counts reports a bare
// size mismatch that says nothing about the cause.
async function unpulledLfsPointers(files) {
  const pointers = [];
  for (const file of files) {
    const handle = await open(file, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(LFS_POINTER_PREFIX.length), 0, LFS_POINTER_PREFIX.length, 0);
      if (buffer.subarray(0, bytesRead).toString("utf8") === LFS_POINTER_PREFIX) pointers.push(path.relative(archiveRoot, file));
    } finally {
      await handle.close();
    }
  }
  return pointers;
}

test("preserved 0.18.0 installers match the exact public release inventory", async (t) => {
  const manifest = JSON.parse(await readFile(path.join(archiveRoot, "artifacts.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "product", "schemaVersion", "version"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, "Grok Bot");
  assert.equal(manifest.version, "0.18.0");
  assert.equal(manifest.artifacts.length, 2);

  const files = [];
  for (const artifact of manifest.artifacts) {
    assert.deepEqual(
      Object.keys(artifact).sort(),
      ["architecture", "bytes", "path", "platform", "sha256", "sourceUrl"],
    );
    assert.match(artifact.path, /^(macos-arm64\/[^/]+\.dmg|windows-x64\/[^/]+\.exe)$/);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.match(artifact.sourceUrl, /^https:\/\/downloads\.cursor\.com\/grokbot\/stable\//);
    const file = path.join(archiveRoot, artifact.path);
    assert.ok(file.startsWith(`${archiveRoot}${path.sep}`));
    const metadata = await lstat(file);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.isSymbolicLink(), false);
    files.push(file);
  }

  const pointers = await unpulledLfsPointers(files);
  if (pointers.length > 0) {
    const advice = `Git LFS objects are not present (${pointers.join(", ")}). Run \`git lfs install && git lfs pull\` to verify the preserved installers.`;
    // A checkout without the objects cannot verify them, and saying so beats reporting a bare size
    // mismatch. On CI it has to fail: a green run that quietly skipped this check would mean the
    // archived installers are never verified at all, which is the whole point of preserving them.
    if (process.env.CI != null && process.env.CI !== "" && process.env.CI !== "false") assert.fail(advice);
    t.skip(advice);
    return;
  }

  for (const [index, artifact] of manifest.artifacts.entries()) {
    const file = files[index];
    assert.equal((await lstat(file)).size, artifact.bytes, `${artifact.path} does not match the recorded byte count`);
    assert.equal(await sha256(file), artifact.sha256);
  }
});

test("bootstrap prefers the hash-pinned local archive before the network", async () => {
  const [attributes, config, bootstrap] = await Promise.all([
    readFile(path.join(repositoryRoot, ".gitattributes"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "lib", "config.mjs"), "utf8"),
    readFile(path.join(repositoryRoot, "scripts", "bootstrap-runtime.mjs"), "utf8"),
  ]);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.dmg filter=lfs diff=lfs merge=lfs -text/);
  assert.match(attributes, /research-archives\/original\/\*\*\/\*\.exe filter=lfs diff=lfs merge=lfs -text/);
  assert.match(config, /export const archivedDmg = path\.join\(repoRoot, "research-archives", "original", "0\.18\.0", "macos-arm64", "Grok_Bot_0\.18\.0\.dmg"\)/);
  assert.match(bootstrap, /const archivedDigest = await sha256\(archivedDmg\)/);
  assert.match(bootstrap, /if \(archivedDigest !== dmgSha256\)/);
  assert.match(bootstrap, /await copyFile\(archivedDmg, cachedDmg\)/);
  assert.ok(bootstrap.indexOf("await copyFile(archivedDmg, cachedDmg)") < bootstrap.indexOf("await fetch(dmgUrl"));
});
