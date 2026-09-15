import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const bundled = await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/routed-tool-breaker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
}

function clock() {
  const state = { nowMs: 1_000 };
  return { now: () => state.nowMs, advance: (ms) => { state.nowMs += ms; } };
}

test("a plugin that keeps failing is answered for instead of called again", async () => {
  const { createRoutedToolBreaker } = await loadModule();
  const time = clock();
  const breaker = createRoutedToolBreaker({ threshold: 3, cooldownMs: 60_000, now: time.now });

  assert.equal(breaker.refusal("gmail"), null, "an unknown plugin is never pre-emptively refused");
  breaker.recordFailure("gmail", "rejected");
  breaker.recordFailure("gmail", "rejected");
  assert.equal(breaker.refusal("gmail"), null, "the breaker holds until the threshold");

  breaker.recordFailure("gmail", "rejected");
  const refusal = breaker.refusal("gmail");
  assert.match(refusal, /rejected the last 3 calls/);
  // Telling the model a reachable plugin is unreachable sends it to the person when the real
  // problem is its own arguments.
  assert.match(refusal, /it answered every time/);
  assert.match(refusal, /change the arguments or take a different approach/);
  assert.match(refusal, /Paused for about 60s/);
});

test("an unreachable plugin and a rejecting one are refused in different words", async () => {
  const { createRoutedToolBreaker } = await loadModule();
  const time = clock();
  const breaker = createRoutedToolBreaker({ threshold: 2, cooldownMs: 30_000, now: time.now });

  breaker.recordFailure("notion", "rejected");
  breaker.recordFailure("notion", "unreachable");
  const refusal = breaker.refusal("notion");
  assert.match(refusal, /could not reach the "notion" plugin/);
  assert.match(refusal, /continue without it, or tell the person it is unavailable/);
});

test("the cooldown ends in one probe, and a working plugin clears the breaker", async () => {
  const { createRoutedToolBreaker } = await loadModule();
  const time = clock();
  const breaker = createRoutedToolBreaker({ threshold: 2, cooldownMs: 10_000, now: time.now });

  breaker.recordFailure("linear", "unreachable");
  breaker.recordFailure("linear", "unreachable");
  assert.notEqual(breaker.refusal("linear"), null);

  time.advance(10_000);
  assert.equal(breaker.refusal("linear"), null, "the elapsed cooldown lets exactly one call through");

  // A failed probe re-arms the cooldown rather than letting every later call through.
  breaker.recordFailure("linear", "unreachable");
  assert.match(breaker.refusal("linear"), /Paused for about 10s/);

  time.advance(10_000);
  breaker.recordSuccess("linear");
  assert.equal(breaker.refusal("linear"), null);
  breaker.recordFailure("linear", "unreachable");
  assert.equal(breaker.refusal("linear"), null, "a success reset the streak, so one failure is not enough");
});

test("breakers are per plugin, so one broken server cannot mute the others", async () => {
  const { createRoutedToolBreaker } = await loadModule();
  const breaker = createRoutedToolBreaker({ threshold: 1, cooldownMs: 5_000 });

  breaker.recordFailure("gmail", "unreachable");
  assert.notEqual(breaker.refusal("gmail"), null);
  assert.equal(breaker.refusal("slack"), null);
});
