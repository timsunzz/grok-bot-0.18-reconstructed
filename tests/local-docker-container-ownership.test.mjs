import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const UNOWNED = JSON.stringify({ State: { Running: true }, Config: { Image: "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest", Labels: { "com.docker.compose.project": "someone-else" } } });
const OWNED = JSON.stringify({ State: { Running: true }, Config: { Image: "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest", Labels: { "com.grok-bot.local-vm": "1" } } });

// A `docker` stand-in on PATH: it records every argv it is asked to run and answers `inspect`
// from a file the test controls, so the test can assert which lifecycle commands were reached.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ -n "$FAKE_DOCKER_HANG" ]; then sleep 600; exit 0; fi
if [ "$1" = "inspect" ]; then
  if [ -s "$FAKE_DOCKER_INSPECT" ]; then cat "$FAKE_DOCKER_INSPECT"; exit 0; fi
  echo "Error: No such object: grok-bot-local-vm" >&2
  exit 1
fi
if [ "$1" = "info" ]; then echo "27.0.0"; exit 0; fi
exit 0
`;

async function loadConnector() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-docker-"));
  const outfile = path.join(temporary, "local-docker-host-connector.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });

  const bin = path.join(temporary, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "docker"), FAKE_DOCKER);
  await chmod(path.join(bin, "docker"), 0o755);

  const log = path.join(temporary, "docker.log");
  const inspect = path.join(temporary, "inspect.json");
  await writeFile(log, "");
  await writeFile(inspect, "");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_DOCKER_INSPECT = inspect;

  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return {
    module,
    setContainer: (json) => writeFile(inspect, json),
    commands: async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0),
    resetLog: () => writeFile(log, ""),
    settingsPath: path.join(temporary, "state", "settings.json"),
    dispose: () => rm(temporary, { recursive: true, force: true }),
  };
}

function connector(loaded) {
  return loaded.module.createSettingsRoutedHostConnector(
    { connect: async () => { throw new Error("the remote box should not be used here"); } },
    { settingsPath: loaded.settingsPath, getBoxRuntime: () => "local-docker" },
  );
}

test("resetting the computer refuses to destroy a container Grok Bot does not own", async () => {
  const loaded = await loadConnector();
  try {
    await loaded.setContainer(UNOWNED);
    const routed = connector(loaded);

    const result = await routed.forceRecreate();

    assert.equal(result.status, "rejected");
    assert.match(result.reason, /unowned container already has that name/);
    // `docker rm --force` on a fixed container name is destructive and irreversible; a container
    // someone else created with that name must never reach it.
    assert.deepEqual((await loaded.commands()).filter((line) => line.startsWith("rm")), []);
  } finally {
    await loaded.dispose();
  }
});

test("updating the computer refuses to restart a container Grok Bot does not own", async () => {
  const loaded = await loadConnector();
  try {
    await loaded.setContainer(UNOWNED);
    const routed = connector(loaded);

    await assert.rejects(routed.recreate({}), /unowned container already has that name/);
    assert.deepEqual((await loaded.commands()).filter((line) => line.startsWith("restart")), []);
  } finally {
    await loaded.dispose();
  }
});

test("an owned container is still replaced on reset", async () => {
  const loaded = await loadConnector();
  try {
    await loaded.setContainer(OWNED);
    const routed = connector(loaded);

    // Removal succeeds and provisioning proceeds until it needs the compiled runtime, which a
    // source checkout does not have. Reaching that point is what proves the guard let it past.
    await assert.rejects(routed.forceRecreate(), /reconstructed runtime is unavailable/);
    assert.deepEqual((await loaded.commands()).filter((line) => line.startsWith("rm")), ["rm --force grok-bot-local-vm"]);
  } finally {
    await loaded.dispose();
  }
});

test("a wedged docker daemon does not hang the settings page forever", { timeout: 60_000 }, async () => {
  const loaded = await loadConnector();
  try {
    process.env.FAKE_DOCKER_HANG = "1";
    const started = Date.now();

    // Without a deadline this promise never settles, and every coordinator reconnect and
    // settings IPC call queued behind it stops too.
    const status = await loaded.module.getLocalDockerStatus(loaded.settingsPath);

    assert.equal(status.available, false);
    assert.match(status.detail, /did not respond within/);
    assert.ok(Date.now() - started < 30_000, `gave up after ${Date.now() - started}ms`);
  } finally {
    delete process.env.FAKE_DOCKER_HANG;
    await loaded.dispose();
  }
});
