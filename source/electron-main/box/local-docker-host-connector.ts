import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandSettingsStore } from "../../shared/node/settings/sand-settings-store.js";
import type { RecreateResult } from "./box-recreate-commands.js";
import type { SandRemoteHostConnector } from "./box-host-connector.js";
import type { GatewayConnection } from "./gateway-descriptor-cache.js";

export const LOCAL_DOCKER_BOX_IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
export const LOCAL_DOCKER_BOX_CONTAINER = "grok-bot-local-vm";
export const LOCAL_DOCKER_GATEWAY_URL = "http://127.0.0.1:1340";
export const LOCAL_DOCKER_OWNER_LABEL = "com.grok-bot.local-vm=1";
export const LOCAL_DOCKER_SCHEMA_VERSION = "6";
const READY_TIMEOUT_MS = 180_000;
const OPTIONAL_CREDENTIAL_TIMEOUT_MS = 3_000;
// `docker run` may pull an image, so lifecycle commands get a long deadline. The daemon probe
// behind a settings page must not sit there for two minutes.
const DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const DOCKER_PROBE_TIMEOUT_MS = 10_000;
const REPAIR_ATTEMPTS = 40;
const REPAIR_POLL_MS = 50;
const REPAIR_LOCK_STALE_MS = 10_000;

export interface LocalDockerStatus {
  readonly available: boolean;
  readonly running: boolean;
  readonly ready: boolean;
  readonly containerName: string;
  readonly image: string;
  readonly detail: string;
}

interface CommandResult { readonly ok: boolean; readonly output: string }
interface InferenceCredential { readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number }
interface LocalHostBundle { readonly path: string; readonly sha256: string; readonly boxExecDaemonPath: string; readonly boxExecDaemonSha256: string }

function runDocker(args: readonly string[], timeoutMs = DOCKER_COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    const settle = (result: CommandResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    // A wedged Docker daemon otherwise leaves this promise pending forever, which hangs the
    // settings IPC call and every coordinator reconnect behind it.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // The kill only reaches `docker` itself. Anything it left holding these pipes would keep
      // the event loop alive, so stop listening to a child we have already given up on.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle({ ok: false, output: `${output}\ndocker ${args[0] ?? ""} did not respond within ${Math.round(timeoutMs / 1_000)}s.`.trim() });
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => settle({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.once("close", (code) => settle({ ok: code === 0, output: output.trim() }));
  });
}

function credentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-vm.json");
}

function inferenceCredentialPath(settingsPath: string): string {
  return join(dirname(settingsPath), "local-docker-credential", "inference.json");
}

async function replaceFileAtomically(target: string, body: string): Promise<void> {
  // A pid alone is not unique here: this data root is bind-mounted into the box, so the host and
  // a process inside the container can share one.
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await chmod(target, 0o600);
}

async function persistInferenceCredential(settingsPath: string, credential: InferenceCredential): Promise<string> {
  const target = inferenceCredentialPath(settingsPath);
  await replaceFileAtomically(target, `${JSON.stringify({ accessToken: credential.accessToken, expiresAtMs: credential.expiresAtMs })}\n`);
  return target;
}

function tokenBody(token: string): string {
  return `${JSON.stringify({ schemaVersion: 1, token }, null, 2)}\n`;
}

async function readToken(target: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length >= 32 ? parsed.token : null;
  } catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A present-but-unparseable token file cannot be adopted, and it cannot be replaced the way an
 * absent one is created: `wx` fails on it, and unconditional replacement lets every concurrent
 * caller install a token of its own, so the gateway is handed several and accepts one. Repair
 * therefore runs under a lock file, which is also a lock across the host, coordinator, and Electron
 * main processes that share this directory. Callers that lose the lock adopt what the winner wrote.
 */
async function repairToken(target: string): Promise<string> {
  const lock = `${target}.repair`;
  for (let attempt = 0; attempt < REPAIR_ATTEMPTS; attempt++) {
    const valid = await readToken(target);
    if (valid != null) return valid;
    try {
      await writeFile(lock, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      // A process that died mid-repair would otherwise keep every later caller out for good.
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > REPAIR_LOCK_STALE_MS) await rm(lock, { force: true }).catch(() => {});
      else await sleep(REPAIR_POLL_MS);
      continue;
    }
    try {
      const token = randomBytes(32).toString("hex");
      if (await readToken(target) == null) await replaceFileAtomically(target, tokenBody(token));
      return await readToken(target) ?? token;
    } finally {
      await rm(lock, { force: true }).catch(() => {});
    }
  }
  throw new Error(`Could not repair the local VM gateway token: ${target}.repair is held by another process. Remove it if no app is running.`);
}

/**
 * This token authenticates every request to the box's gateway, so no two callers may settle on
 * different values. Both `getLocalDockerStatus` behind the settings page and `ensureLocalDockerBox`
 * behind a coordinator reconnect reach here, and the write used to be unconditional: each caller
 * that found no file minted its own token and overwrote the other's, so the container was launched
 * with one token while the health probe used another and the box never reported ready. A torn read
 * of a non-atomic write had the same effect against an already-running container.
 *
 * Creating with `wx` (O_CREAT|O_EXCL) lets exactly one writer win, across processes as well as
 * within one; every other caller adopts the winner's token by reading it back.
 */
async function readOrCreateToken(settingsPath: string): Promise<string> {
  const target = credentialPath(settingsPath);
  const existing = await readToken(target);
  if (existing != null) return existing;

  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, tokenBody(token), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(target, 0o600);
    return token;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }

  const adopted = await readToken(target);
  return adopted ?? await repairToken(target);
}

async function gatewayReady(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${LOCAL_DOCKER_GATEWAY_URL}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch { return false; }
}

// "Docker says this name is free" and "Docker could not tell us" are different answers, and the
// difference decides whether a destructive lifecycle command on a fixed container name may run.
// Collapsing them into one `exists: false` is what let a wedged daemon re-enable `rm --force`
// against a container Grok Bot does not own.
type ContainerState =
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly detail: string }
  | {
    readonly kind: "present";
    readonly running: boolean;
    readonly owned: boolean;
    readonly image: string;
    readonly hostSha256: string;
    readonly gatewayTokenSha256: string;
    readonly hasInferenceCredential: boolean;
    readonly schemaVersion: string;
  };

async function inspectContainer(timeoutMs?: number): Promise<ContainerState> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", LOCAL_DOCKER_BOX_CONTAINER], timeoutMs);
  if (!result.ok) {
    return /no such (?:object|container)/i.test(result.output)
      ? { kind: "absent" }
      : { kind: "unknown", detail: result.output || `Docker could not inspect ${LOCAL_DOCKER_BOX_CONTAINER}.` };
  }
  try {
    const value = JSON.parse(result.output) as { State?: { Running?: unknown }; Config?: { Image?: unknown; Labels?: Record<string, unknown> } };
    const labels = value.Config?.Labels ?? {};
    const label = (name: string): string => typeof labels[name] === "string" ? labels[name] as string : "";
    return {
      kind: "present",
      running: value.State?.Running === true,
      owned: label("com.grok-bot.local-vm") === "1",
      image: typeof value.Config?.Image === "string" ? value.Config.Image : "",
      hostSha256: label("com.grok-bot.local-vm.host-sha256"),
      gatewayTokenSha256: label("com.grok-bot.local-vm.gateway-token-sha256"),
      hasInferenceCredential: label("com.grok-bot.local-vm.inference-credential") === "1",
      schemaVersion: label("com.grok-bot.local-vm.schema-version"),
    };
  } catch { return { kind: "unknown", detail: "Docker returned malformed container inspection data." }; }
}

export async function getLocalDockerStatus(settingsPath: string): Promise<LocalDockerStatus> {
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"], DOCKER_PROBE_TIMEOUT_MS);
  if (!daemon.ok) return { available: false, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: daemon.output || "Docker is not running." };
  // A daemon that answers `info` from cache while container operations hang is a common wedge, so
  // the probe deadline has to cover the inspection too and not just the reachability check.
  const inspected = await inspectContainer(DOCKER_PROBE_TIMEOUT_MS);
  if (inspected.kind === "unknown") return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: inspected.detail };
  if (inspected.kind === "absent") return { available: true, running: false, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: LOCAL_DOCKER_BOX_IMAGE, detail: "Ready to create the local VM." };
  if (!inspected.owned) return { available: true, running: inspected.running, ready: false, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: `Container ${LOCAL_DOCKER_BOX_CONTAINER} exists but is not owned by Grok Bot.` };
  const ready = inspected.running && await gatewayReady(await readOrCreateToken(settingsPath));
  return { available: true, running: inspected.running, ready, containerName: LOCAL_DOCKER_BOX_CONTAINER, image: inspected.image, detail: ready ? "Local Docker VM is ready." : inspected.running ? "Container is starting." : "Local Docker VM is stopped." };
}

let ensureInFlight: { readonly suppliesCredential: boolean; readonly promise: Promise<GatewayConnection> } | undefined;

// One fixed container name means one provisioning pass at a time. The settings IPC path and the
// coordinator reconnect path both provision, and overlapping `docker run --name` attempts make
// one of them fail with a name conflict.
function ensureSingleFlight(suppliesCredential: boolean, run: () => Promise<GatewayConnection>): Promise<GatewayConnection> {
  const current = ensureInFlight;
  // A caller carrying an inference credential must not adopt a pass that was provisioning without
  // one: the box it would join never received the credential, and the label the replace check
  // reads reports nothing missing. It waits for that pass and then provisions on top of it.
  if (current != null && (current.suppliesCredential || !suppliesCredential)) return current.promise;
  const promise = (current == null ? run() : current.promise.catch(() => undefined).then(run))
    .finally(() => { if (ensureInFlight?.promise === promise) ensureInFlight = undefined; });
  ensureInFlight = { suppliesCredential, promise };
  return promise;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function stageCurrentHostBundle(settingsPath: string): Promise<LocalHostBundle> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const readRuntime = async (relative: string): Promise<Buffer> => {
    const candidates = [resolve(moduleDirectory, `../${relative}`), resolve(moduleDirectory, `../../${relative}`)];
    for (const candidate of candidates) {
      try { return await readFile(candidate); } catch {}
    }
    throw new Error(`The reconstructed runtime is unavailable at ${candidates.join(" or ")}; refusing to start a stock local VM.`);
  };
  const hostBytes = await readRuntime("host/host-main.cjs");
  const boxExecDaemonBytes = await readRuntime("box-exec-daemon/main.cjs");
  const sha256 = createHash("sha256").update(hostBytes).digest("hex");
  const boxExecDaemonSha256 = createHash("sha256").update(boxExecDaemonBytes).digest("hex");
  const directory = join(dirname(settingsPath), "local-docker-runtime", `${sha256}-${boxExecDaemonSha256}`);
  const persistRuntime = async (name: string, bytes: Buffer): Promise<string> => {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`Content-addressed local runtime ${target} has unexpected bytes.`);
    } catch (error) {
      if (error instanceof Error && !Reflect.has(error, "code")) throw error;
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, target);
    }
    return target;
  };
  await mkdir(directory, { recursive: true });
  return {
    path: await persistRuntime("host-main.cjs", hostBytes),
    sha256,
    boxExecDaemonPath: await persistRuntime("box-exec-daemon/main.cjs", boxExecDaemonBytes),
    boxExecDaemonSha256,
  };
}

async function localAuthMountArguments(): Promise<string[]> {
  const mounts: string[] = [];
  for (const [source, destination] of [[join(homedir(), ".codex"), "/root/.codex"], [join(homedir(), ".claude"), "/root/.claude"]] as const) {
    if (await isDirectory(source)) mounts.push("--mount", `type=bind,src=${source},dst=${destination},readonly`);
  }
  return mounts;
}

// Why an existing owned container cannot serve this request. Each of these is baked in at
// `docker run` and cannot be changed on a running container.
function replacementReason(
  present: Extract<ContainerState, { kind: "present" }>,
  hostSha256: string,
  gatewayTokenSha256: string,
  needsInferenceCredential: boolean,
): string | null {
  if (present.schemaVersion !== LOCAL_DOCKER_SCHEMA_VERSION) return "it predates this app's local VM contract";
  if (present.hostSha256 !== hostSha256) return "it runs a different app runtime";
  // The gateway token is an environment variable of the container. A token this host has since
  // repaired or rotated can only be adopted by replacing the container: otherwise every health
  // probe gets 401 for the rest of that container's life and no reset path recovers it.
  if (present.gatewayTokenSha256 !== gatewayTokenSha256) return "its gateway token is not the one this host now holds";
  if (needsInferenceCredential && !present.hasInferenceCredential) return "it was created without an inference credential";
  return null;
}

async function ensureLocalDockerBox(settingsPath: string, inferenceCredential?: InferenceCredential): Promise<GatewayConnection> {
  const token = await readOrCreateToken(settingsPath);
  const gatewayTokenSha256 = createHash("sha256").update(token).digest("hex");
  const hostBundle = await stageCurrentHostBundle(settingsPath);
  const inferenceFile = inferenceCredential == null ? undefined : await persistInferenceCredential(settingsPath, inferenceCredential);
  const daemon = await runDocker(["info", "--format", "{{.ServerVersion}}"], DOCKER_PROBE_TIMEOUT_MS);
  if (!daemon.ok) throw new Error(`Local Docker VM is selected, but Docker is unavailable: ${daemon.output || "start Docker and try again"}`);
  const inspected = await inspectContainer();
  if (inspected.kind === "unknown") throw new Error(`Local Docker VM cannot verify ${LOCAL_DOCKER_BOX_CONTAINER}: ${inspected.detail}`);
  if (inspected.kind === "present" && !inspected.owned) throw new Error(`Local Docker VM cannot use ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`);
  if (inspected.kind === "present" && inspected.image !== LOCAL_DOCKER_BOX_IMAGE) throw new Error(`Local Docker VM container uses unexpected image ${inspected.image}. Remove it explicitly before changing images.`);
  let current: ContainerState = inspected;
  if (inspected.kind === "present") {
    const reason = replacementReason(inspected, hostBundle.sha256, gatewayTokenSha256, inferenceCredential != null);
    if (reason != null) {
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok) throw new Error(`Could not replace the local VM because ${reason}: ${removed.output}`);
      current = { kind: "absent" };
    }
  }
  // Only a container this pass started may be stopped again when provisioning gives up below.
  let startedHere = false;
  if (current.kind === "present" && !current.running) {
    startedHere = true;
    const started = await runDocker(["start", LOCAL_DOCKER_BOX_CONTAINER]);
    if (!started.ok) throw new Error(`Could not start the local Docker VM: ${started.output}`);
  } else if (current.kind === "absent") {
    startedHere = true;
    const authMounts = await localAuthMountArguments();
    const created = await runDocker([
      "run", "--detach", "--name", LOCAL_DOCKER_BOX_CONTAINER,
      "--label", LOCAL_DOCKER_OWNER_LABEL, "--label", `com.grok-bot.local-vm.host-sha256=${hostBundle.sha256}`,
      "--label", `com.grok-bot.local-vm.box-exec-daemon-sha256=${hostBundle.boxExecDaemonSha256}`,
      "--label", `com.grok-bot.local-vm.gateway-token-sha256=${gatewayTokenSha256}`,
      "--label", `com.grok-bot.local-vm.inference-credential=${inferenceCredential == null ? "0" : "1"}`,
      "--label", `com.grok-bot.local-vm.schema-version=${LOCAL_DOCKER_SCHEMA_VERSION}`,
      "--platform", "linux/amd64", "--restart", "unless-stopped",
      "--env", "SAND_SUPERVISOR_ENABLED=1", "--env", "SAND_BOX_AUTO_UPDATE=0", "--env", "SAND_USE_EXISTING_BOX_EXEC_DAEMON=1", "--env", "SAND_TREE_SITTER_NODE_DEPS=/home/box/deps", "--env", "NODE_PATH=/home/box/deps", "--env", "SAND_GATEWAY_BIND_HOST=0.0.0.0", "--env", "SAND_HOST_PORT=1340", "--env", `SAND_GATEWAY_TOKEN=${token}`,
      ...(inferenceCredential == null ? [] : ["--env", "SAND_DEV_INFERENCE_TOKEN_FILE=/run/grok-bot/inference.json", "--env", `SAND_BACKEND_URL=${inferenceCredential.backendUrl}`]),
      "--publish", "127.0.0.1:1337:1337", "--publish", "127.0.0.1:1339:1339", "--publish", "127.0.0.1:1340:1340",
      "--publish", "127.0.0.1:6080:6080", "--publish", "127.0.0.1:6081:6081", "--publish", "127.0.0.1:8790:8790",
      "--volume", "grok-bot-local-vm-workspace:/workspace", "--volume", "grok-bot-local-vm-data:/home/box/sand-data",
      "--mount", `type=bind,src=${hostBundle.path},dst=/home/box/sand-host/host-main.cjs,readonly`,
      "--mount", `type=bind,src=${dirname(hostBundle.boxExecDaemonPath)},dst=/home/box/box-exec-daemon,readonly`,
      ...(inferenceFile == null ? [] : ["--mount", `type=bind,src=${dirname(inferenceFile)},dst=/run/grok-bot,readonly`]),
      ...authMounts,
      LOCAL_DOCKER_BOX_IMAGE,
    ]);
    if (!created.ok) throw new Error(`Could not create the local Docker VM: ${created.output}`);
  }
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let failure = "Local Docker VM did not expose its gateway within three minutes.";
  while (Date.now() < deadline) {
    if (await gatewayReady(token)) return { baseUrl: LOCAL_DOCKER_GATEWAY_URL, token };
    const state = await inspectContainer();
    // An inspection that could not answer is not evidence the container died, and the gateway
    // probe above is the authority on readiness, so a wedged `inspect` keeps waiting instead of
    // tearing down a box that is still coming up.
    if (state.kind === "absent" || (state.kind === "present" && !state.running)) {
      const logs = await runDocker(["logs", "--tail", "80", LOCAL_DOCKER_BOX_CONTAINER]);
      failure = `Local Docker VM stopped before its gateway became ready.\n${logs.output}`;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  // Callers roll the box runtime back to remote when this throws, so a container this pass started
  // would keep holding the loopback ports and CPU with nothing attached to it. A box that was
  // already running is left alone: it belongs to whoever started it. Stopping rather than removing
  // keeps the logs and volumes available for diagnosis.
  if (startedHere) await stopOwnedContainerQuietly();
  throw new Error(failure);
}

async function stopOwnedContainerQuietly(): Promise<void> {
  const inspected = await inspectContainer();
  if (inspected.kind !== "present" || !inspected.owned || !inspected.running) return;
  await runDocker(["stop", "--time", "10", LOCAL_DOCKER_BOX_CONTAINER]);
}

// `ensureLocalDockerBox` and `stopLocalDockerBox` both refuse to touch a container they do not
// own. The recreate paths run `restart` and `rm --force` on a fixed name, so they need the
// same guard or a user's unrelated container of that name is destroyed for them.
async function unownedContainerRefusal(action: string): Promise<string | null> {
  const inspected = await inspectContainer();
  if (inspected.kind === "absent") return null;
  // Ownership has to be confirmed, not merely not-denied: `docker inspect` failing to answer is no
  // evidence that destroying this name is safe.
  if (inspected.kind === "unknown") return `Refusing to ${action} ${LOCAL_DOCKER_BOX_CONTAINER}: Docker could not confirm who owns it (${inspected.detail}).`;
  return inspected.owned ? null : `Refusing to ${action} ${LOCAL_DOCKER_BOX_CONTAINER}: an unowned container already has that name.`;
}

export async function startLocalDockerBox(settingsPath: string): Promise<GatewayConnection> {
  return await ensureSingleFlight(false, () => ensureLocalDockerBox(settingsPath));
}

export async function stopLocalDockerBox(): Promise<void> {
  const inspected = await inspectContainer();
  if (inspected.kind === "absent") return;
  if (inspected.kind === "unknown") throw new Error(`Could not stop the local Docker VM: Docker could not confirm the container's state (${inspected.detail}).`);
  if (!inspected.running) return;
  if (!inspected.owned) throw new Error(`Refusing to stop unowned container ${LOCAL_DOCKER_BOX_CONTAINER}.`);
  const stopped = await runDocker(["stop", LOCAL_DOCKER_BOX_CONTAINER]);
  if (!stopped.ok) throw new Error(`Could not stop the local Docker VM: ${stopped.output}`);
}

export function createSettingsRoutedHostConnector(
  remote: SandRemoteHostConnector,
  settings: SandSettingsStore,
): SandRemoteHostConnector {
  const localConnect = (): Promise<GatewayConnection> => ensureSingleFlight(remote.issueInferenceCredential != null, async () => {
    const issued = remote.issueInferenceCredential == null ? undefined : await Promise.race([
      remote.issueInferenceCredential(),
      new Promise<undefined>((resolve) => setTimeout(resolve, OPTIONAL_CREDENTIAL_TIMEOUT_MS)),
    ]);
    return await ensureLocalDockerBox(settings.settingsPath, issued);
  });
  return {
    connect: async () => settings.getBoxRuntime() === "local-docker" ? await localConnect() : await remote.connect(),
    ...(remote.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: remote.issueLocalExecDaemonCredential.bind(remote) }),
    ...(remote.issueInferenceCredential == null ? {} : { issueInferenceCredential: remote.issueInferenceCredential.bind(remote) }),
    recreate: async (args): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.recreate == null) throw new Error("Remote computer recreation is unavailable.");
        return await remote.recreate(args);
      }
      const refusal = await unownedContainerRefusal("restart");
      if (refusal != null) throw new Error(refusal);
      const stopped = await runDocker(["restart", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!stopped.ok) throw new Error(`Could not restart the local Docker VM: ${stopped.output}`);
      await localConnect();
      return { status: "started-untrackable" };
    },
    forceRecreate: async (): Promise<RecreateResult> => {
      if (settings.getBoxRuntime() !== "local-docker") {
        if (remote.forceRecreate == null) return { status: "rejected", reason: "Remote computer reset is unavailable." };
        return await remote.forceRecreate();
      }
      const refusal = await unownedContainerRefusal("remove");
      if (refusal != null) return { status: "rejected", reason: refusal };
      const removed = await runDocker(["rm", "--force", LOCAL_DOCKER_BOX_CONTAINER]);
      if (!removed.ok && !/no such container/i.test(removed.output)) return { status: "rejected", reason: removed.output };
      await localConnect();
      return { status: "started-untrackable" };
    },
  };
}
