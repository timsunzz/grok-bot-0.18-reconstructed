import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { DEFAULT_RUN_TIMEOUT_MS, capture, run } = await import(path.join(repoRoot, "scripts/lib/process.mjs"));
const { SYSTEM_TOOLS, assertMacOsHost } = await import(path.join(repoRoot, "scripts/lib/system-tools.mjs"));
const { DETACH_RETRY_DELAYS_MS, detachQuietly } = await import(path.join(repoRoot, "scripts/lib/dmg.mjs"));

test("a build subprocess that never exits fails on its deadline instead of hanging", async () => {
  const started = Date.now();
  // `hdiutil detach` on a busy volume and `codesign` on stalled trust material both block
  // indefinitely rather than failing, which used to stall the whole build with no output.
  await assert.rejects(
    run("/bin/sh", ["-c", "exec sleep 60"], { timeoutMs: 250 }),
    /did not finish within 250ms/,
  );
  // The child's piped stdio keeps the loop alive until it closes, so the deadline has to tear the
  // streams down rather than only signalling the process.
  assert.ok(Date.now() - started < 20_000, "the deadline must not wait for the child to exit on its own");
});

test("a captured subprocess honours the same deadline", async () => {
  await assert.rejects(
    capture("/bin/sh", ["-c", "echo partial; exec sleep 60"], { timeoutMs: 250 }),
    /did not finish within 250ms/,
  );
});

test("the deadline leaves well-behaved commands alone", async () => {
  assert.equal(await capture("/bin/sh", ["-c", "printf ready"]), "ready");
  await run("/bin/sh", ["-c", "exit 0"]);
  await assert.rejects(run("/bin/sh", ["-c", "exit 3"]), /exited with 3/);
  await assert.rejects(run("/nonexistent/tool", []), /ENOENT/);
  assert.ok(DEFAULT_RUN_TIMEOUT_MS >= 60_000, "the default must not cut short a legitimate native rebuild");
});

test("a macOS-only build step names the precondition instead of failing on a missing binary", () => {
  if (process.platform === "darwin") {
    assert.doesNotThrow(() => assertMacOsHost("Packaging"));
    return;
  }
  // Reaching a system tool on another platform produced `spawn /usr/bin/hdiutil ENOENT`, which
  // reads like a broken toolchain rather than an unsupported host.
  assert.throws(() => assertMacOsHost("Packaging"), (error) => {
    assert.match(error.message, /^Packaging requires macOS\./);
    assert.match(error.message, /hdiutil/);
    assert.match(error.message, new RegExp(`this host is ${process.platform}`));
    return true;
  });
});

test("every entry-point build script states its platform precondition before doing work", async () => {
  for (const script of [
    "scripts/bootstrap-runtime.mjs",
    "scripts/verify.mjs",
    "scripts/package-macos.mjs",
    "scripts/package-fidelity-diagnostic.mjs",
  ]) {
    const source = await readFile(path.join(repoRoot, script), "utf8");
    const guard = source.indexOf("assertMacOsHost(\"");
    assert.notEqual(guard, -1, `${script} must assert its platform precondition`);
    // The guard exists to be reached before a 150 MB download or a native rebuild, so its
    // position is the point: after the first `await` it is a comment.
    const firstAwait = source.search(/^\s*(?:await|const .* = await)\s/m);
    assert.ok(guard < firstAwait || firstAwait === -1, `${script} does work before asserting its platform precondition`);
  }
  // Every entry in SYSTEM_TOOLS is an absolute macOS path, so the single guard stays sufficient
  // as tools are added.
  assert.deepEqual(Object.values(SYSTEM_TOOLS).filter((tool) => !tool.startsWith("/")), []);
});

test("the release image is detached with retries and never masks the original failure", async () => {
  // Spotlight indexes an image it has just seen appear, and `hdiutil detach` fails while anything
  // holds the volume, so the first attempt losing is the common case rather than the exception.
  const attempts = [];
  const busyUntilThirdTry = async (mountRoot) => {
    attempts.push(mountRoot);
    if (attempts.length < 3) throw new Error("hdiutil: couldn't unmount: Resource busy");
  };

  assert.equal(await detachQuietly("/Volumes/scratch", { detach: busyUntilThirdTry, delaysMs: [0, 0, 0] }), null);
  assert.equal(attempts.length, 3);

  // It runs from a `finally`. A throw there would replace whatever went wrong inside the block and
  // skip the cleanup after it, leaving the image attached and unexplained, so the failure comes
  // back as a value for the caller to report.
  const failure = await detachQuietly("/Volumes/scratch", {
    detach: async () => { throw new Error("hdiutil: couldn't unmount: Resource busy"); },
    delaysMs: [0, 0, 0],
  });
  assert.match(String(failure), /Resource busy/);

  assert.equal(await detachQuietly("/Volumes/scratch", { detach: async () => {}, delaysMs: DETACH_RETRY_DELAYS_MS }), null);
  const source = await readFile(path.join(repoRoot, "scripts/bootstrap-runtime.mjs"), "utf8");
  assert.match(source, /Could not detach the release image/);
});
