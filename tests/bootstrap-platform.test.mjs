import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapCanExtractDmg, bootstrapUnsupportedPlatformMessage } from "../scripts/lib/bootstrap-platform.mjs";

test("bootstrap refuses DMG extraction off macOS unless a runtime is already available", () => {
  assert.equal(bootstrapCanExtractDmg("linux", { configuredApp: "", hasCachedRuntime: false }), false);
  assert.equal(bootstrapCanExtractDmg("linux", { configuredApp: "/tmp/Grok Bot.app", hasCachedRuntime: false }), true);
  assert.equal(bootstrapCanExtractDmg("linux", { configuredApp: "", hasCachedRuntime: true }), true);
  assert.equal(bootstrapCanExtractDmg("darwin", { configuredApp: "", hasCachedRuntime: false }), true);
  assert.match(bootstrapUnsupportedPlatformMessage("linux"), /GROK_BOT_018_APP/);
});
