import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
const SCHEMA_VERSION = "7";

const UNOWNED = JSON.stringify({ State: { Running: true }, Config: { Image: IMAGE, Labels: { "com.docker.compose.project": "someone-else" } } });
const OWNED = JSON.stringify({ State: { Running: true }, Config: { Image: IMAGE, Labels: { "com.grok-bot.local-vm": "1" } } });

function ownedContainer(labels, running = true) {
  return JSON.stringify({ State: { Running: running }, Config: { Image: IMAGE, Labels: { "com.grok-bot.local-vm": "1", "com.grok-bot.local-vm.schema-version": SCHEMA_VERSION, ...labels } } });
}

// A `docker` stand-in on PATH: it records every argv it is asked to run and answers `inspect`
// from files the test controls, so the test can assert which lifecycle commands were reached.
// `FAKE_DOCKER_HANG` is a space-separated list of subcommands that never answer, because a daemon
// that serves `info` from cache while container operations wedge is the interesting failure.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $FAKE_DOCKER_HANG " in
  *" $1 "*) exec sleep 600 ;;
esac
if [ -n "$FAKE_DOCKER_STDERR_NOISE" ]; then echo "$FAKE_DOCKER_STDERR_NOISE" >&2; fi
if [ "$1" = "inspect" ]; then
  if [ -n "$FAKE_DOCKER_INSPECT_ERROR" ]; then echo "$FAKE_DOCKER_INSPECT_ERROR" >&2; exit 1; fi
  if [ -s "$FAKE_DOCKER_INSPECT" ]; then cat "$FAKE_DOCKER_INSPECT"; exit 0; fi
  echo "Error: No such object: grok-bot-local-vm" >&2
  exit 1
fi
if [ "$1" = "info" ]; then echo "27.0.0"; exit 0; fi
exit 0
`;

// The connector resolves its compiled runtimes relative to its own directory, so the bundle is
// placed where a packaged app would put it. Tests that need provisioning to get past staging ask
// for those runtimes to exist.
async function loadConnector(options = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-local-docker-"));
  const appDirectory = path.join(temporary, "app");
  const outfile = path.join(appDirectory, "electron-main", "local-docker-host-connector.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/electron-main/box/local-docker-host-connector.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });

  const runtime = {};
  if (options.withRuntime === true) {
    const hostBytes = Buffer.from("// fake compiled host runtime\n");
    const daemonBytes = Buffer.from("// fake compiled box exec daemon\n");
    await mkdir(path.join(appDirectory, "host"), { recursive: true });
    await mkdir(path.join(appDirectory, "box-exec-daemon"), { recursive: true });
    await writeFile(path.join(appDirectory, "host", "host-main.cjs"), hostBytes);
    await writeFile(path.join(appDirectory, "box-exec-daemon", "main.cjs"), daemonBytes);
    runtime.hostSha256 = createHash("sha256").update(hostBytes).digest("hex");
  }

  const bin = path.join(temporary, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "docker"), FAKE_DOCKER);
  await chmod(path.join(bin, "docker"), 0o755);

  const log = path.join(temporary, "docker.log");
  const inspect = path.join(temporary, "inspect.json");
  await writeFile(log, "");
  await writeFile(inspect, "");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_DOCKER_INSPECT = inspect;

  const module = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  return {
    module,
    runtime,
    setContainer: (json) => writeFile(inspect, json),
    setInspectError: (message) => { process.env.FAKE_DOCKER_INSPECT_ERROR = message; },
    commands: async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0),
    settingsPath: path.join(temporary, "state", "settings.json"),
    writeToken: async (token) => {
      const target = path.join(temporary, "state", "local-docker-vm.json");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify({ schemaVersion: 1, token })}\n`);
    },
    dispose: async () => {
      process.env.PATH = previousPath ?? "";
      delete process.env.FAKE_DOCKER_INSPECT_ERROR;
      delete process.env.FAKE_DOCKER_STDERR_NOISE;
      await rm(temporary, { recursive: true, force: true });
    },
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

test("an inspection Docker cannot answer is not read as permission to destroy", async () => {
  const loaded = await loadConnector();
  try {
    // A daemon that cannot answer used to be indistinguishable from "that name is free", so the
    // guard let `rm --force` through on the strength of a failed inspection.
    loaded.setInspectError("Error response from daemon: dial unix /var/run/docker.sock: connect: connection refused");
    const routed = connector(loaded);

    const result = await routed.forceRecreate();

    assert.equal(result.status, "rejected");
    assert.match(result.reason, /could not confirm who owns it/);
    assert.deepEqual((await loaded.commands()).filter((line) => line.startsWith("rm")), []);
    await assert.rejects(routed.recreate({}), /could not confirm who owns it/);
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

// Stands in for the box's gateway on the address the connector probes, recording the bearer token
// each health check presents. The port is fixed by the connector, so a developer running the real
// local box cannot also run these tests.
async function recordingGateway(t) {
  const { createServer } = await import("node:http");
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.authorization ?? "").replace(/^Bearer /, ""));
    response.writeHead(200).end("ok");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(1340, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    t.skip("127.0.0.1:1340 is already in use, so the local box gateway cannot be stubbed");
    return null;
  }
  return { seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function tokenOnDisk(settingsPath) {
  const stored = JSON.parse(await readFile(path.join(path.dirname(settingsPath), "local-docker-vm.json"), "utf8"));
  return stored.token;
}

test("concurrent callers settle on one gateway token", { timeout: 60_000 }, async (t) => {
  const loaded = await loadConnector();
  const gateway = await recordingGateway(t);
  if (gateway == null) { await loaded.dispose(); return; }
  try {
    await loaded.setContainer(OWNED);

    // The settings page and every coordinator reconnect both reach the token, and each caller that
    // found no file used to mint its own and overwrite the others. The container was then launched
    // with one token while the health probe used another, so the box never reported ready.
    const statuses = await Promise.all(Array.from({ length: 8 }, () => loaded.module.getLocalDockerStatus(loaded.settingsPath)));

    assert.deepEqual([...new Set(statuses.map((status) => status.ready))], [true]);
    assert.equal(gateway.seen.length, 8);
    assert.deepEqual([...new Set(gateway.seen)], [await tokenOnDisk(loaded.settingsPath)]);

    const stateDir = path.dirname(loaded.settingsPath);
    assert.deepEqual((await readdir(stateDir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("concurrent callers finding an unreadable token settle on the repaired one", { timeout: 60_000 }, async (t) => {
  const loaded = await loadConnector();
  const gateway = await recordingGateway(t);
  if (gateway == null) { await loaded.dispose(); return; }
  try {
    await loaded.setContainer(OWNED);
    const credential = path.join(path.dirname(loaded.settingsPath), "local-docker-vm.json");
    await mkdir(path.dirname(credential), { recursive: true });
    await writeFile(credential, '{"schemaVersion":1,"token":"too-short"}');

    const statuses = await Promise.all(Array.from({ length: 8 }, () => loaded.module.getLocalDockerStatus(loaded.settingsPath)));

    assert.deepEqual([...new Set(statuses.map((status) => status.ready))], [true]);
    const repaired = await tokenOnDisk(loaded.settingsPath);
    assert.ok(repaired.length >= 32, `expected a full-length token, got ${repaired}`);
    // A repair that each caller performs for itself hands the gateway several different tokens,
    // only one of which the container was ever given.
    assert.deepEqual([...new Set(gateway.seen)], [repaired]);
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("a container holding a superseded gateway token is replaced, not restarted", { timeout: 60_000 }, async (t) => {
  const loaded = await loadConnector({ withRuntime: true });
  const gateway = await recordingGateway(t);
  if (gateway == null) { await loaded.dispose(); return; }
  try {
    await loaded.writeToken("b".repeat(64));
    // The container was created with a token this host no longer holds. Its token is an
    // environment variable fixed at `docker run`, so starting it again only produces a gateway
    // that answers 401 until someone resets the box by hand.
    await loaded.setContainer(ownedContainer({
      "com.grok-bot.local-vm.host-sha256": loaded.runtime.hostSha256,
      "com.grok-bot.local-vm.gateway-token-sha256": createHash("sha256").update("a".repeat(64)).digest("hex"),
    }, false));

    await loaded.module.startLocalDockerBox(loaded.settingsPath);

    const commands = await loaded.commands();
    assert.deepEqual(commands.filter((line) => line.startsWith("rm")), ["rm --force grok-bot-local-vm"]);
    assert.deepEqual(commands.filter((line) => line.startsWith("start")), []);
    const created = commands.find((line) => line.startsWith("run "));
    assert.match(created, /SAND_GATEWAY_TOKEN=b{64}/);
    assert.match(created, new RegExp(`gateway-token-sha256=${createHash("sha256").update("b".repeat(64)).digest("hex")}`));
    assert.deepEqual([...new Set(gateway.seen)], ["b".repeat(64)]);
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("a container already holding this host's token is started as it is", { timeout: 60_000 }, async (t) => {
  const loaded = await loadConnector({ withRuntime: true });
  const gateway = await recordingGateway(t);
  if (gateway == null) { await loaded.dispose(); return; }
  try {
    const token = "c".repeat(64);
    await loaded.writeToken(token);
    await loaded.setContainer(ownedContainer({
      "com.grok-bot.local-vm.host-sha256": loaded.runtime.hostSha256,
      "com.grok-bot.local-vm.gateway-token-sha256": createHash("sha256").update(token).digest("hex"),
    }, false));

    await loaded.module.startLocalDockerBox(loaded.settingsPath);

    const commands = await loaded.commands();
    assert.deepEqual(commands.filter((line) => line.startsWith("rm")), [], "a usable box must not be destroyed");
    assert.deepEqual(commands.filter((line) => line.startsWith("start")), ["start grok-bot-local-vm"]);
  } finally {
    await gateway.close();
    await loaded.dispose();
  }
});

test("a docker that writes advice to stderr is still a docker that answered", { timeout: 60_000 }, async () => {
  const loaded = await loadConnector();
  try {
    // `podman-docker` prints this in front of every command, and Docker Desktop has its own
    // announcements. Reading the inspection out of both streams at once turned that note into
    // malformed JSON, and an unverifiable container is deliberately never touched — so one benign
    // line on stderr blocked reset, update, and connect alike, with no in-app way back.
    process.env.FAKE_DOCKER_STDERR_NOISE = "Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.";
    await loaded.setContainer(UNOWNED);
    const routed = connector(loaded);

    const result = await routed.forceRecreate();

    assert.equal(result.status, "rejected");
    assert.match(result.reason, /unowned container already has that name/);
    assert.doesNotMatch(result.reason, /malformed/);
  } finally {
    await loaded.dispose();
  }
});

test("a wedged docker daemon does not hang the settings page forever", { timeout: 60_000 }, async () => {
  const loaded = await loadConnector();
  try {
    process.env.FAKE_DOCKER_HANG = "info inspect";
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

test("a daemon that answers info while container operations wedge still reports back", { timeout: 60_000 }, async () => {
  const loaded = await loadConnector();
  try {
    // This is the common Docker wedge, and the inspection used to run on the two-minute lifecycle
    // deadline rather than the probe's, so the settings page hung for it anyway.
    process.env.FAKE_DOCKER_HANG = "inspect";
    const started = Date.now();

    const status = await loaded.module.getLocalDockerStatus(loaded.settingsPath);

    assert.equal(status.available, true);
    assert.equal(status.ready, false);
    assert.match(status.detail, /did not respond within/);
    assert.ok(Date.now() - started < 30_000, `gave up after ${Date.now() - started}ms`);
  } finally {
    delete process.env.FAKE_DOCKER_HANG;
    await loaded.dispose();
  }
});
