import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function loadModule(source, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-json-"));
  const output = path.join(temporary, `${name}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, source)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return {
    module,
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

test("gateway JSON parsing rejects malformed request bodies as client errors", async () => {
  const protocol = await loadModule(
    "source/host/gateway-protocol.ts",
    "gateway-protocol",
  );
  const server = await loadModule(
    "source/host/gateway-server.ts",
    "gateway-server",
  );
  try {
    assert.deepEqual(protocol.module.parseCommandArgs(""), {});
    assert.deepEqual(protocol.module.parseCommandArgs('{"ok":true}'), {
      ok: true,
    });
    assert.throws(
      () => protocol.module.parseCommandArgs('{"broken":'),
      (error) =>
        error?.name === "SandGatewayRequestError" &&
        error.message === "Request body must be valid JSON.",
    );
    assert.equal(
      server.module.statusForCommandError(
        new server.module.SandGatewayRequestError("invalid"),
      ),
      400,
    );
  } finally {
    await Promise.all([protocol.dispose(), server.dispose()]);
  }
});
